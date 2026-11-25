import { Effect, Schema, Stream } from "effect";
import { MachineBuild, MachineConfigured, MachinePeerPin, type MachineCopyInput } from "@shared/machine-control";
import { MachineInstallError, MachineInstallResult, MachineSetupError } from "@shared/machine-install";
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

/** A machine still holds the link this one made before it was removed, and this one no longer holds the key. */
class LinkOutlivedRemove extends Schema.TaggedError<LinkOutlivedRemove>()("LinkOutlivedRemove", { message: Schema.String }) {}
/** Which check refused a copy, setup or update; the remote's own refusal arrives scrubbed. */
export const MachineCopyCheck = Schema.Literals(["release-download-only", "not-set-up", "platform-unsupported", "no-bundle", "bundle-mismatch",
  "identity-mismatch", "name-not-kept", "binding-not-kept", "name-changed", "remote-refused"]);
export class MachineCopyRefused extends Schema.TaggedError<MachineCopyRefused>()("MachineCopyRefused", {
  check: MachineCopyCheck,
  message: Schema.String,
}) {}
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
    ssh.transfer(program, Stream.empty, 30_000).pipe(Effect.catch((cause): Effect.Effect<never, MachineCopyRefused | SshError | SshTransferExitError> => {
      if (cause instanceof SshTransferExitError) {
        const failure = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Struct({
          ok: Schema.Literal(false), command: Schema.Literal(command), error: OperatorErrorBody,
        })), { onExcessProperty: "error" })(cause.stderr.trim().split("\n").at(-1));
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
    // The whole-machine count over the operator's SSH route, before the
    // transfer. The maintenance lease inside the install is the gate; this
    // check only saves the download and the copy.
    if (mode === "update" && input.stopRunningSeats !== true && host.juntoHome !== undefined && host.installRoot !== undefined) {
      const statusProgram = yield* machineStatusProgram(target, { juntoHome: host.juntoHome, installRoot: host.installRoot }).pipe(Effect.mapError(staged));
      const statusAnswer = yield* ssh.run(statusProgram).pipe(Effect.mapError(staged));
      const status = yield* decodeMachineOwnStatus(statusAnswer.stdout).pipe(Effect.mapError(staged));
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
    }, onTransition).pipe(Effect.provideService(SshTransport, ssh), Effect.provideService(LogService, log));
    const receipt = yield* Schema.decodeUnknownEffect(MachineInstallResult)(installed, { onExcessProperty: "error" });
    return yield* Effect.gen(function* () {
      if (receipt.build !== build || (pin !== undefined && receipt.installationId !== pin.installationId)) return yield* Effect.fail(refused("identity-mismatch", "The installed Junto identity does not match the selected machine"));
      if (pin === undefined) {
        const configuredProgram = yield* configureMachine(target, receipt, host.id);
        const configuredOutput = yield* ownerTransfer(configuredProgram, "machine configure");
        const configured = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ConfigureResponse))(configuredOutput.stdout.trim(), { onExcessProperty: "error" });
        if (configured.data.machineName !== host.id || configured.data.installationId !== receipt.installationId) return yield* Effect.fail(refused("name-not-kept", "The machine did not keep its selected name and installation identity"));
        const own = { machineName: yield* machines.machineName, installationId: yield* machines.installationId };
        // A remove that could not reach this machine left its line and pin of this one pending: they go first, so setup pins plainly.
        // It settles only against the installation this send reached, the one that held the line.
        if (options.settleRemovedLink !== undefined) yield* options.settleRemovedLink(host.id, { ...host, juntoHome: receipt.juntoHome, installRoot: receipt.installRoot }, receipt.installationId).pipe(Effect.ignore);
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
          if (!cleared || (yield* setUp).data.keyBound === true) return yield* Effect.fail(new LinkOutlivedRemove({ message: STALE_LINK_WORDS }));
        }
      } else if (receipt.machineName !== host.id) return yield* Effect.fail(refused("name-changed", "The machine calls itself another name; keep its setup binding and choose the correct machine"));
      const configuredHost = { ...host, juntoHome: receipt.juntoHome, installRoot: receipt.installRoot };
      yield* hosts.upsert(configuredHost);
      if (pin === undefined) yield* options.connectSetup(configuredHost, receipt.installationId);
      else yield* options.connect(configuredHost);
      return { ...receipt, machineName: host.id };
    }).pipe(Effect.mapError(cause => cause instanceof LinkOutlivedRemove
      ? new MachineSetupError({ message: cause.message, retryable: false, installed: receipt, ownWords: true })
      : new MachineSetupError({
        message: `Junto is installed, but could not ${pin === undefined ? "finish setup" : "connect"}: ${cause instanceof Error ? cause.message : String(cause)}. Check this machine before sending again`,
        retryable: false, installed: receipt,
      })));
  }));
});
