import { Effect, Option, Schema, Stream } from "effect";
import { MachineBuild, MachineConfigured, MachinePeerPin, type MachineCopyInput } from "@shared/machine-control";
import { MachineFarInstallResult, MachineInstallError, MachinePinRefused, MachineSetupError, MachineTakeoverRemoteHint } from "@shared/machine-install";
import type { MachineSendEvent } from "@shared/machine-progress";
import type { InstallationId } from "@shared/installation-id";
import type { RemoteHost } from "@shared/remote-hosts";
import { OperatorErrorBody } from "@shared/operator-control";
import { scrubMessage } from "../../node/credentials/scrub";
import { failureHere } from "./failure-here";
import { LogService } from "../../node/observability/logger";
import { MachineRepository } from "../machines/repository";
import { parseHostSshRoute, SshTransport, type ScopedStreamProgram, type SshError } from "../ssh";
import { SshTransferExitError } from "../ssh/service";
import { configureMachine, setupMachine, machineStatusProgram, machinePlatform } from "../ssh/machine-owner-commands";
import { decodeMachineOwnStatus } from "./machine-status";
import { inspectMachineBundle } from "../../node/hosts/bundle";
import { sendMachine } from "./send";
import { HostsService } from "./service";
import type { MachineBundleAcquirer } from "./machine-bundle-download";

type Target = "darwin-arm64" | "linux-x64";
export interface MachineCopyOptions {
  readonly build: string;
  readonly bundles: Readonly<Partial<Record<Target, string>>>;
  /** Present only for a release: local paths cannot replace compiled archive pins. */
  readonly acquireBundle?: MachineBundleAcquirer;
  readonly connectSetup: (host: RemoteHost, expectedInstallationId: InstallationId) => Effect.Effect<unknown, unknown>;
  readonly connect: (host: RemoteHost) => Effect.Effect<unknown, unknown>;
  /**
   * Asks the machine over the link that `connect` opened, so it answers only
   * once it has let this machine in: a hello admitted here is no proof the far
   * admitted this one (receipt 22). Bounded by LINK_OPEN_MS.
   */
  readonly linkAnswers: (host: RemoteHost) => Effect.Effect<unknown, unknown>;
  /**
   * Told once, on the S4 refusal only, after the route is kept: the name, that
   * route, and the installation the install receipt over it named, for
   * take-over-remote (remote-send owns the record). A failure here is logged
   * and never changes the refusal.
   */
  readonly onPinnedElsewhere?: (machineName: string, route: RemoteHost, installationId: InstallationId) => Effect.Effect<void, unknown>;
  /** How long the send waits for that answer; LINK_OPEN_MS unless a test says. */
  readonly linkOpenMs?: number;
  readonly disconnect: (name: string) => Effect.Effect<void, unknown>;
  /** Clears what a remove left pending on `name`, over the route this send just reached, before setup pins this machine again. */
  readonly settleRemovedLink?: (name: string, route: RemoteHost, installationId: InstallationId) => Effect.Effect<unknown, unknown>;
  /** Does this machine hold its own link key for `name`: held, none, or unreadable, which counts as held. */
  readonly linkKeyState?: (name: string) => "held" | "none" | "unreadable";
  /** Clears every line and the pin of this machine on `route`, only when `holder` answers: true when one went. */
  readonly clearStaleLink?: (route: RemoteHost, holder: InstallationId) => Effect.Effect<boolean, unknown>;
}

/** The words for a stale link this send could not clear: a resend runs the clear again. */
export const STALE_LINK_WORDS = "That machine still accepts an old link from this one, and Junto could not clear it. Send Junto again.";
/** The words for a link key here that cannot be read: a remove deletes it unread, and the next send clears the stale link. */
export const UNREADABLE_LINK_KEY_WORDS = "This machine's link key for that machine cannot be read. Remove that machine, then add it again and send Junto to it.";

/**
 * The pinned machine answers as another installation and nothing changed there
 * (remote-design, 209adfb83): the send stops before it copies anything, and the
 * operator previews a take-over. The command itself is the CLI's to print, from
 * the refusal's typed `takeover` fields; it is never part of these words.
 */
export const INSTALLATION_CHANGED_WORDS = "It now answers as a different install of Junto, so nothing changed. Preview a take-over with junto machine takeover to see which seats and automations move.";

/** How long a send waits for the machine to answer over the link once it is set up (receipt 22, S6). */
export const LINK_OPEN_MS = 20_000;

/** Set up, but the machine never answered over the link in time, or refused it: sending again may finish it (remote-design, c1ef3953f). */
export const LINK_NOT_OPENED_WORDS = "Junto is set up there, but no link to it opened in time. Send Junto again, and if that fails too, check it again.";

/**
 * The machine already trusts another install under this machine's name, or
 * this install under another name, so its setup refused to pin this one
 * (remote-design, c65fe82c8, S4). Always after the install receipt, so the
 * words say Junto is installed. The CLI prints the take-over-remote line from the typed
 * `takeoverRemote` field; it is never part of these words.
 */
export const PINNED_ELSEWHERE_WORDS = "Junto is installed there, but it already trusts a different install of Junto under this machine's name. Preview a take-over there with junto machine takeover-remote to see which seats and automations move.";

/** The far's setup refused to pin this machine, by which rule, read closed from its answer. */
class PinRefused extends Schema.TaggedError<PinRefused>()("PinRefused", { check: MachinePinRefused, message: Schema.String }) {}
/** That refusal, on a first send or a pin already here: the route is kept, and the send ends in PINNED_ELSEWHERE_WORDS. */
class PinnedElsewhere extends Schema.TaggedError<PinnedElsewhere>()("PinnedElsewhere", { message: Schema.String }) {}
/** The machine did not answer over the link in time once set up. */
class LinkNotOpened extends Schema.TaggedError<LinkNotOpened>()("LinkNotOpened", { message: Schema.String }) {}

/** A machine still holds the link this one made before it was removed, and this one no longer holds the key. */
class LinkOutlivedRemove extends Schema.TaggedError<LinkOutlivedRemove>()("LinkOutlivedRemove", { message: Schema.String }) {}
/** Which check refused a copy, setup or update; the remote's own refusal arrives scrubbed. */
export const MachineCopyCheck = Schema.Literals(["release-download-only", "not-set-up", "platform-unsupported", "no-bundle", "bundle-mismatch",
  "identity-mismatch", "name-not-kept", "binding-not-kept", "name-changed", "remote-refused"]);
export class MachineCopyRefused extends Schema.TaggedError<MachineCopyRefused>()("MachineCopyRefused", {
  check: MachineCopyCheck,
  message: Schema.String,
}) {}
/** Staged, in the core's own words, with the typed fields the CLI builds its take-over line from. */
const installationChanged = (machineName: string, previousInstallationId: InstallationId, installationId: InstallationId) =>
  new MachineInstallError({
    message: INSTALLATION_CHANGED_WORDS, disposition: "staged", retryable: false, ownWords: true,
    takeover: { machineName, installationId, previousInstallationId },
  });
const refused = (check: typeof MachineCopyCheck.Type, message: string) =>
  new MachineCopyRefused({ check, message: check === "remote-refused" ? scrubMessage(message) : message });
const ConfigureResponse = Schema.Struct({ ok: Schema.Literal(true), command: Schema.Literal("machine configure"), data: MachineConfigured });
const SetupResponse = Schema.Struct({ ok: Schema.Literal(true), command: Schema.Literal("machine setup"), data: MachinePeerPin });

/** Explicit send completes setup through a checked first hello; update uses an existing pin only. */
export const makeMachineCopy = (options: MachineCopyOptions) => Effect.gen(function* () {
  const log = yield* LogService;
  const staged = (cause: unknown) => new MachineInstallError({ message: cause instanceof Error ? cause.message : String(cause), disposition: "staged", retryable: false, ...failureHere(cause, log.machine()) });
  const machines = yield* MachineRepository;
  const hosts = yield* HostsService;
  const ssh = yield* SshTransport;
  const build = yield* Schema.decodeUnknownEffect(MachineBuild)(options.build);
  const ownerTransfer = (program: ScopedStreamProgram, command: "machine configure" | "machine setup") =>
    ssh.transfer(program, Stream.empty, 30_000).pipe(Effect.catch((cause): Effect.Effect<never, MachineCopyRefused | PinRefused | SshError | SshTransferExitError> => {
      if (cause instanceof SshTransferExitError) {
        const failure = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Struct({
          ok: Schema.Literal(false), command: Schema.Literal(command), error: OperatorErrorBody,
        })), { onExcessProperty: "error" })(cause.stderr.trim().split("\n").at(-1));
        const pinRefused = failure._tag === "Success" && command === "machine setup" ? failure.success.error.details?.pinRefused : undefined;
        if (failure._tag === "Success" && pinRefused !== undefined) return Effect.fail(new PinRefused({ check: pinRefused, message: scrubMessage(failure.success.error.message) }));
        if (failure._tag === "Success") return Effect.fail(refused("remote-refused", failure.success.error.message));
      }
      return Effect.fail(cause);
    }));
  return (host: RemoteHost, input: MachineCopyInput, mode: "send" | "update", onTransition?: (event: MachineSendEvent) => void) => Effect.scoped(Effect.gen(function* () {
    if (options.acquireBundle !== undefined && input.bundle !== undefined) return yield* Effect.fail(staged(refused("release-download-only", "This Junto release uses its own verified machine download. A local package cannot replace it")));
    const pin = yield* machines.peer(host.id);
    if (mode === "update" && pin === undefined) return yield* Effect.fail(staged(refused("not-set-up", "Set up this machine before updating Junto")));
    const target = yield* parseHostSshRoute(host).pipe(Effect.mapError(staged));
    const platform = yield* machinePlatform(target).pipe(Effect.flatMap(program => ssh.run(program)), Effect.mapError(staged));
    const reported = platform.stdout.trim();
    const targetPlatform: Target | undefined = reported === "Darwin arm64" ? "darwin-arm64" : reported === "Linux x86_64" ? "linux-x64" : undefined;
    if (targetPlatform === undefined) return yield* Effect.fail(staged(refused("platform-unsupported", "This machine's platform is not supported by Junto")));
    // A pinned machine that answers as another installation is refused before
    // anything is copied: an install would start a core under the wrong pin.
    // No answer is not a refusal: a pinned machine whose core is down is what a
    // send repairs, and the installer checks the started core's id itself.
    if (mode === "send" && pin !== undefined && host.juntoHome !== undefined && host.installRoot !== undefined) {
      const answered = yield* machineStatusProgram(target, { juntoHome: host.juntoHome, installRoot: host.installRoot }).pipe(
        Effect.flatMap(program => ssh.run(program)),
        Effect.flatMap(answer => decodeMachineOwnStatus(answer.stdout)),
        Effect.option,
      );
      if (Option.isSome(answered) && answered.value.installationId !== pin.installationId) {
        return yield* Effect.fail(installationChanged(host.id, pin.installationId, answered.value.installationId));
      }
    }
    // The whole-machine count over the operator's SSH route, before the
    // transfer. The maintenance lease inside the install is the gate; this
    // check only saves the download and the copy.
    if (mode === "update" && input.stopRunningSeats !== true && host.juntoHome !== undefined && host.installRoot !== undefined) {
      const statusProgram = yield* machineStatusProgram(target, { juntoHome: host.juntoHome, installRoot: host.installRoot }).pipe(Effect.mapError(staged));
      const statusAnswer = yield* ssh.run(statusProgram).pipe(Effect.mapError(staged));
      const status = yield* decodeMachineOwnStatus(statusAnswer.stdout).pipe(Effect.mapError(staged));
      if (pin !== undefined && status.machineName === host.id && status.installationId !== pin.installationId) {
        return yield* Effect.fail(installationChanged(host.id, pin.installationId, status.installationId));
      }
      if (status.machineName !== host.id || (pin !== undefined && status.installationId !== pin.installationId)) {
        return yield* Effect.fail(staged(refused("identity-mismatch", "The machine that answered is not the machine this update was for")));
      }
      if (status.runningSeats === undefined) return yield* Effect.fail(new MachineInstallError({
        message: "This machine's Junto did not say how many seats it runs, so nothing was changed. Check this machine before updating",
        disposition: "staged", retryable: true, runningSeatsUnknown: true, ownWords: true,
      }));
      if (status.runningSeats > 0) return yield* Effect.fail(new MachineInstallError({
        message: `${status.runningSeats === 1 ? "One seat is" : `${String(status.runningSeats)} seats are`} running on this machine. Confirm to stop ${status.runningSeats === 1 ? "it" : "them"} and update`,
        disposition: "staged", retryable: true, runningSeats: status.runningSeats, ownWords: true,
      }));
    }
    const bundle = options.acquireBundle === undefined ? input.bundle ?? options.bundles[targetPlatform]
      : yield* options.acquireBundle(targetPlatform, onTransition);
    if (bundle === undefined) return yield* Effect.fail(staged(refused("no-bundle", targetPlatform === "linux-x64" ? "This Junto has no build for a Linux machine" : "This Junto has no build for a Mac machine")));
    const manifest = yield* Effect.tryPromise({ try: () => inspectMachineBundle(bundle), catch: staged });
    if (manifest.build !== build || manifest.target !== targetPlatform) return yield* Effect.fail(staged(refused("bundle-mismatch", "The selected Junto package does not match this build and the target platform")));
    // Existing channels must close before the service can be replaced.
    yield* options.disconnect(host.id).pipe(Effect.mapError(staged));
    const installed = yield* sendMachine(target, {
      bundle,
      ...(host.juntoHome === undefined ? {} : { juntoHome: host.juntoHome }),
      ...(host.installRoot === undefined ? {} : { installRoot: host.installRoot }),
      ...(pin === undefined ? {} : { expectedInstallationId: pin.installationId }),
      ...(input.stopRunningSeats === true ? { stopRunningSeats: true } : {}),
    }, onTransition, host.id).pipe(Effect.provideService(SshTransport, ssh), Effect.provideService(LogService, log));
    // The far's own receipt, closed to its own steps: it can never say it pinned this machine.
    const receipt = yield* Schema.decodeUnknownEffect(MachineFarInstallResult)(installed, { onExcessProperty: "error" });
    return yield* Effect.gen(function* () {
      if (receipt.build !== build || (pin !== undefined && receipt.installationId !== pin.installationId)) return yield* Effect.fail(refused("identity-mismatch", "The installed Junto identity does not match the selected machine"));
      /**
       * The machine pins this one, plainly or by key, as a first send leaves it.
       * A send to a pin already here runs it too: a take-over leaves a pin whose
       * install was never told this machine (receipt 22), so that install would
       * refuse every link from here while this side read ready. Pinning again is
       * idempotent there.
       */
      let pinned = false;
      const bindHere = Effect.gen(function* () {
        const own = { machineName: yield* machines.machineName, installationId: yield* machines.installationId };
        const setUp = Effect.gen(function* () {
          const setupProgram = yield* setupMachine(target, receipt, own);
          const setupOutput = yield* ownerTransfer(setupProgram, "machine setup");
          const setup = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SetupResponse))(setupOutput.stdout.trim(), { onExcessProperty: "error" });
          if (setup.data.machineName !== own.machineName || setup.data.installationId !== own.installationId) return yield* Effect.fail(refused("binding-not-kept", "The machine did not bind this Junto installation"));
          return setup;
        });
        const setup = yield* setUp;
        // It lets this machine in only through a link key this machine no longer holds: a send that ended ready here would sit beside a dead route.
        // With no key here, that trust is stale: it is cleared once, against the installation this send confirmed, and setup runs once more.
        // A key this machine cannot read counts as held elsewhere: never cleared, the send fails in its own words.
        const keyState = setup.data.keyBound === true ? options.linkKeyState?.(host.id) ?? "unreadable" : "held";
        if (keyState !== "held") {
          const route = { ...host, juntoHome: receipt.juntoHome, installRoot: receipt.installRoot };
          const cleared = keyState === "none" && options.clearStaleLink !== undefined
            && (yield* options.clearStaleLink(route, receipt.installationId).pipe(Effect.orElseSucceed(() => false)));
          // The route is kept, never a pin: a remove can then reach it to clear what this send could not, and nothing reads ready.
          const failed = (message: string) => hosts.upsert(route).pipe(Effect.andThen(Effect.fail(new LinkOutlivedRemove({ message }))));
          if (keyState === "unreadable") return yield* failed(UNREADABLE_LINK_KEY_WORDS);
          if (!cleared || (yield* setUp).data.keyBound === true) return yield* failed(STALE_LINK_WORDS);
        }
        // The send's own step: the machine now pins this one, first or again (S5).
        yield* Effect.logInfo("machine pinned this machine").pipe(Effect.annotateLogs({ area: "machines", peer: host.id, again: pin !== undefined }));
        onTransition?.({ event: "machine-install", juntoHome: receipt.juntoHome, installRoot: receipt.installRoot, step: "pinned" });
        pinned = true;
      });
      // A machine that trusts another install under this name refuses, on a first send (this machine was
      // reinstalled) as on a send to a pin here: the route stays, and the pin if there is one; nothing is
      // taken over and nothing retried, and the operator previews a take-over there (S4, receipt 24).
      const bindOrRefuse = bindHere.pipe(Effect.catchTag("PinRefused", (cause) => Effect.gen(function* () {
        const route = { ...host, juntoHome: receipt.juntoHome, installRoot: receipt.installRoot };
        yield* hosts.upsert(route);
        if (options.onPinnedElsewhere !== undefined) yield* options.onPinnedElsewhere(host.id, route, receipt.installationId).pipe(
          Effect.catch(() => Effect.logWarning("the refused setup could not be recorded").pipe(Effect.annotateLogs({ area: "machines", peer: host.id }))));
        return yield* Effect.fail(new PinnedElsewhere({ message: cause.message }));
      })));
      if (pin === undefined) {
        const configuredProgram = yield* configureMachine(target, receipt, host.id);
        const configuredOutput = yield* ownerTransfer(configuredProgram, "machine configure");
        const configured = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ConfigureResponse))(configuredOutput.stdout.trim(), { onExcessProperty: "error" });
        if (configured.data.machineName !== host.id || configured.data.installationId !== receipt.installationId) return yield* Effect.fail(refused("name-not-kept", "The machine did not keep its selected name and installation identity"));
        // A remove that could not reach this machine left its line and pin of this one pending: they go first, so setup pins plainly.
        // It settles only against the installation this send reached, the one that held the line.
        if (options.settleRemovedLink !== undefined) yield* options.settleRemovedLink(host.id, { ...host, juntoHome: receipt.juntoHome, installRoot: receipt.installRoot }, receipt.installationId).pipe(Effect.ignore);
        yield* bindOrRefuse;
      } else {
        const linked = (yield* machines.peersSeen).some(row => row.installationId === pin.installationId);
        if (receipt.machineName !== host.id) {
          // A pin this machine never linked with (a take-over leaves one) names an install that was never told its
          // name: it is told now. One that linked and then took another name was renamed there, and is refused.
          if (linked) return yield* Effect.fail(refused("name-changed", "The machine calls itself another name; keep its setup binding and choose the correct machine"));
          const configuredProgram = yield* configureMachine(target, receipt, host.id);
          const configuredOutput = yield* ownerTransfer(configuredProgram, "machine configure");
          const configured = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ConfigureResponse))(configuredOutput.stdout.trim(), { onExcessProperty: "error" });
          if (configured.data.machineName !== host.id || configured.data.installationId !== receipt.installationId) return yield* Effect.fail(refused("name-not-kept", "The machine did not keep its selected name and installation identity"));
        }
        // A send binds again whatever was seen: a hello seen from that install is no proof it pinned this one.
        // An update never binds, so it never revives a binding that was taken away there.
        if (mode === "send") yield* bindOrRefuse;
      }
      const configuredHost = { ...host, juntoHome: receipt.juntoHome, installRoot: receipt.installRoot };
      yield* hosts.upsert(configuredHost);
      if (pin === undefined) yield* options.connectSetup(configuredHost, receipt.installationId);
      else yield* options.connect(configuredHost);
      // Ready only once the machine answers over that link: one that refused this machine's hello never does (S6).
      // Once per send, never retried here; the route and the pin stay for the next send.
      yield* options.linkAnswers(configuredHost).pipe(Effect.timeoutOrElse({
        duration: options.linkOpenMs ?? LINK_OPEN_MS,
        orElse: () => Effect.fail(new LinkNotOpened({ message: "no answer in time" })),
      }), Effect.catch((cause) => cause instanceof LinkNotOpened ? Effect.fail(cause)
        : Effect.logWarning("machine did not answer over the link").pipe(Effect.annotateLogs({ area: "machines", peer: host.id }),
          Effect.andThen(Effect.fail(new LinkNotOpened({ message: "refused" }))))));
      // The result lists the send's own step after the install's, as the CLI and the window read it (receipt 24).
      return { ...receipt, machineName: host.id, ...(pinned ? { transitions: [...receipt.transitions, { step: "pinned" as const }] } : {}) };
    }).pipe(Effect.mapError(cause => cause instanceof LinkOutlivedRemove
      ? new MachineSetupError({ message: cause.message, retryable: false, installed: receipt, ownWords: true })
      : cause instanceof LinkNotOpened
      ? new MachineSetupError({ message: LINK_NOT_OPENED_WORDS, retryable: true, installed: receipt, ownWords: true })
      : cause instanceof PinnedElsewhere
      ? new MachineSetupError({ message: PINNED_ELSEWHERE_WORDS, retryable: false, installed: receipt, ownWords: true,
        // The name is the selected host's id, checked closed; never a far string.
        ...Option.match(Schema.decodeUnknownOption(MachineTakeoverRemoteHint)({ machineName: host.id }), { onNone: () => ({}), onSome: (takeoverRemote) => ({ takeoverRemote }) }) })
      : new MachineSetupError({
        message: `Junto is installed, but could not ${pin === undefined ? "finish setup" : "connect"}: ${cause instanceof Error ? cause.message : String(cause)}. Check this machine before sending again`,
        retryable: false, installed: receipt,
      })));
  }));
});
