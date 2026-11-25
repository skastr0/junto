import { Context, Effect, Fiber, Option, Result, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import {
  OPERATOR_PROTOCOL_VERSION, decodeOperatorResponse,
  type OperatorRequestEnvelope, type OperatorResponseEnvelope,
} from "@shared/operator-control";
import { MachineBuild, MachinePeerStatus, machineUpdateDirection, type MachineRelease, type MachineOwnStatus, type MachineHarnesses, type MachineCopyInput, type MachineAutoUpdateView } from "@shared/machine-control";
import { decideMachineUpdate } from "@shared/machine-updates";
import type { MachineLogQuery, MachineLogRead } from "@shared/machine-log";
import type { MachineSeatInput, MachineSeatRead, MachineSeatReadInput, MachineSeatStartInput, MachineSeatStarted, MachineSeatStopped } from "@shared/machine-seat";
import type { TerminalSessionSummary } from "@shared/terminal";
import { scrubMessage, scrubText } from "../../node/credentials/scrub";
import { encodeFailure } from "../../node/failure-encode";
import { MachineInstallError, MachineSetupError, type MachineInstallResult } from "@shared/machine-install";
import type { MachineSendEvent } from "@shared/machine-progress";
import { RemoteHostsError, type RemoteHost } from "@shared/remote-hosts";
import { MachineRepository } from "../machines/repository";
import { StateTransactionOperation } from "../state/service";
import { HostsService } from "./service";
import { parseHostSshRoute } from "../ssh/domain";
import { noteMachinesChanged } from "./machine-changes";
import type { InstallOpsServiceShape } from "../install-ops/service";
import { SshTransport } from "../ssh";
import { machineStatusProgram } from "../ssh/machine-owner-commands";
import { decodeMachineOwnStatus } from "./machine-status";
import { HostRegistryRows } from "./registry";
import type { MachineLinkSetup } from "./machine-link";
import type { VaultSetup } from "../vault/setup";

export interface MachineOwnerOptions {
  readonly ownStatus: Effect.Effect<MachineOwnStatus, unknown>;
  readonly ownHarnesses: Effect.Effect<MachineHarnesses, unknown>;
  readonly peerStatus: (name: string) => Effect.Effect<MachinePeerStatus, unknown>;
  /** This machine's whole log; the owner is not scoped. */
  readonly ownLogs: (query: MachineLogQuery) => Effect.Effect<MachineLogRead, unknown>;
  /** A linked machine's log, scoped by that machine to the canvases this one holds. */
  readonly peerLogs: (name: string, query: MachineLogQuery) => Effect.Effect<MachineLogRead, unknown>;
  readonly peerBuild: (name: string) => Effect.Effect<string | undefined, unknown>;
  /** What this build says it is, to say which of two machines on different builds is behind. */
  readonly release?: MachineRelease;
  readonly copy: (host: RemoteHost, input: MachineCopyInput, mode: "send" | "update", onTransition?: (event: MachineSendEvent) => void) => Effect.Effect<MachineInstallResult, unknown>;
  readonly disconnect: (name: string) => Effect.Effect<void, unknown>;
  /** Starts a seat by canvas and seat id through the code the window uses. */
  readonly seatStart?: (input: MachineSeatStartInput) => Effect.Effect<TerminalSessionSummary, unknown>;
  /** Stops a seat by canvas and seat id; the node stays on the canvas. */
  readonly seatStop?: (input: MachineSeatInput) => Effect.Effect<Pick<MachineSeatStopped, "outcome">, unknown>;
  /** Reads a seat's settled terminal grid, here or on the machine that runs it. */
  readonly seatRead?: (input: MachineSeatReadInput) => Effect.Effect<Omit<MachineSeatRead, "canvas" | "seatId">, unknown>;
  /** Links bound to their opener's key (`junto machine link`). */
  readonly linkSetup?: MachineLinkSetup;
  /** Vault tokens (`junto machine vault-token`), refused while VAULT_ENABLED is off. */
  readonly vaultSetup?: VaultSetup;
  /** Automatic update is allowed only for an own build, or a signed release. */
  readonly autoUpdate?: {
    readonly downloadsBundles: boolean;
    readonly signedRelease: boolean;
  };
  /** The install-local attempt store; without it no automatic push starts. */
  readonly installOps?: Pick<InstallOpsServiceShape, "updateLatch" | "recordUpdateLatch">;
}
export class SeatControlUnavailable extends Schema.TaggedError<SeatControlUnavailable>()("SeatControlUnavailable", {
  message: Schema.String.pipe(Schema.check(Schema.isMaxLength(1024))),
}) {}
export interface MachineOwnerActions {
  readonly dispatch: (request: OperatorRequestEnvelope, onTransition?: (event: MachineSendEvent) => void) => Effect.Effect<OperatorResponseEnvelope>;
  /** Starts the idle automatic updater; the return stops it. */
  readonly startAutoUpdates?: () => Effect.Effect<() => void>;
}
export class MachineOwnerControl extends Context.Service<MachineOwnerControl, MachineOwnerActions>()("@junto/MachineOwnerControl") {}

/** One action implementation for the owner socket and window IPC. */
export const makeMachineOwnerActions = (options: MachineOwnerOptions) => Effect.gen(function* () {
  const machines = yield* MachineRepository;
  const hosts = yield* HostsService;
  const rows = yield* HostRegistryRows;
  const sql = yield* SqlClient.SqlClient;
  const ssh = yield* SshTransport;
  const autoUpdateViews = new Map<string, MachineAutoUpdateView>();
  const mutationLock = yield* Semaphore.make(1);
  const updateViews = (name: string, view: MachineAutoUpdateView): void => {
    autoUpdateViews.set(name, view);
    noteMachinesChanged();
  };
  const startAutoUpdates = (): Effect.Effect<() => void> => Effect.gen(function* () {
    const auto = options.autoUpdate;
    const store = options.installOps;
    if (auto === undefined || store === undefined) return () => undefined;
    let stopped = false;
    const inFlight = new Set<string>();
    const once = Effect.gen(function* () {
      const own = yield* options.ownStatus;
      if (own.ready !== true) return;
      const pins = yield* machines.peers;
      for (const pin of pins) {
        if (stopped || inFlight.has(pin.machineName)) continue;
        const host = yield* hosts.get(pin.machineName).pipe(Effect.orElseSucceed(() => undefined));
        if (host === undefined || host.isThisMachine || host.sshEndpoint === undefined) continue;
        const peerBuild = yield* options.peerBuild(pin.machineName).pipe(Effect.orElseSucceed(() => undefined));
        if (peerBuild === undefined || peerBuild === own.build) continue;
        if (host.juntoHome === undefined || host.installRoot === undefined) continue;
        // Never update a machine that edits a canvas this one holds; its name
        // is not authority, its installation id is.
        const edited = yield* sql`SELECT canvas_name FROM canvases WHERE editor_installation_id = ${pin.installationId} LIMIT 1`;
        // A latch that cannot be read is not an empty latch: skip the push.
        const latch = yield* store.updateLatch(pin.installationId).pipe(Effect.match({
          onFailure: () => "unreadable" as const,
          onSuccess: value => value,
        }));
        if (latch === "unreadable") continue;
        const route = yield* parseHostSshRoute(host).pipe(Effect.orElseSucceed(() => undefined));
        if (route === undefined) continue;
        const status = yield* machineStatusProgram(route, { juntoHome: host.juntoHome, installRoot: host.installRoot })
          .pipe(Effect.flatMap(program => ssh.run(program)), Effect.flatMap(answer => decodeMachineOwnStatus(answer.stdout)), Effect.orElseSucceed(() => undefined));
        if (status === undefined || status.installationId !== pin.installationId) continue;
        const decision = decideMachineUpdate({
          peerBuild,
          ownBuild: own.build,
          peerRelease: { version: status.version, builtAt: status.builtAt },
          ownRelease: { version: own.version, builtAt: own.builtAt },
          runningSeats: status.runningSeats,
          editedHere: edited.length > 0,
          latchedForBuild: latch !== undefined && latch.targetBuild === own.build,
          downloadsBundles: auto.downloadsBundles,
          signedRelease: auto.signedRelease,
        });
        if (decision.kind === "skip") continue;
        if (decision.kind === "click") {
          updateViews(pin.machineName, {
            state: "refused-busy",
            targetBuild: own.build,
            at: new Date().toISOString(),
            ...(status.runningSeats === undefined ? { detail: "could not count running seats" } : { runningSeats: status.runningSeats }),
          });
          continue;
        }
        if (decision.kind === "tell") {
          updateViews(pin.machineName, { state: decision.reason === "this-older" ? "this-older" : "needs-signed-release", targetBuild: own.build, at: new Date().toISOString() });
          continue;
        }
        // Every attempt is latched before any byte moves, whatever the outcome.
        const attemptAt = new Date().toISOString();
        const recorded = yield* store.recordUpdateLatch({
          installationId: pin.installationId,
          targetBuild: own.build,
          outcome: "attempting",
          at: attemptAt,
        }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
        if (!recorded) continue;
        inFlight.add(pin.machineName);
        updateViews(pin.machineName, { state: "updating", targetBuild: own.build, at: attemptAt });
        yield* options.copy(host, { name: pin.machineName }, "update").pipe(
          Effect.matchEffect({
            onSuccess: () => Effect.gen(function* () {
              yield* store.recordUpdateLatch({ installationId: pin.installationId, targetBuild: own.build, outcome: "activated", at: new Date().toISOString() }).pipe(Effect.ignore);
              updateViews(pin.machineName, { state: "updated", targetBuild: own.build, at: new Date().toISOString() });
            }),
            onFailure: (cause: unknown) => Effect.gen(function* () {
              const at = new Date().toISOString();
              const outcome = cause instanceof MachineInstallError
                ? cause.disposition === "rolled-back" ? "rolled-back" as const
                  : cause.disposition === "uncertain" ? "stop-unconfirmed" as const
                    : "start-failed" as const
                : "failed" as const;
              yield* store.recordUpdateLatch({ installationId: pin.installationId, targetBuild: own.build, outcome, at }).pipe(Effect.ignore);
              if (cause instanceof MachineInstallError && cause.disposition === "staged" && (cause.runningSeats !== undefined || cause.runningSeatsUnknown === true)) {
                updateViews(pin.machineName, { state: "refused-busy", targetBuild: own.build, at, ...(cause.runningSeats === undefined ? {} : { runningSeats: cause.runningSeats }) });
                return;
              }
              updateViews(pin.machineName, { state: outcome, targetBuild: own.build, at, detail: cause instanceof Error ? cause.message.slice(0, 512) : String(cause).slice(0, 512) });
            }),
          }),
          Effect.ensuring(Effect.sync(() => inFlight.delete(pin.machineName))),
        );
      }
    }).pipe(Effect.catchCause(cause => Effect.sync(() => { if (!stopped) console.error("[machine-updates] pass failed", cause); })));
    const fiber = yield* Effect.forkDetach(Effect.forever(Effect.gen(function* () {
      yield* once;
      yield* Effect.sleep("60 seconds");
    })));
    return () => { stopped = true; void Effect.runFork(Fiber.interrupt(fiber)); };
  });
  const notFound = (name: string) => new RemoteHostsError("not_found", `unknown machine: ${name}`);
  const selected = (name: string) => hosts.get(name).pipe(Effect.flatMap(host =>
    host === undefined ? Effect.fail(notFound(name)) : Effect.succeed(host)));
  const other = (name: string) => selected(name).pipe(Effect.flatMap(host => host.isThisMachine
    ? Effect.fail(new RemoteHostsError("conflict", "choose another machine")) : Effect.succeed(host)));
  const peerStatus = (name: string) => Effect.gen(function* () {
    yield* other(name);
    const pin = yield* machines.peer(name);
    if (pin === undefined) {
      // A machine removed and added again names both machines: it was set up once, so "first" would be wrong.
      const removed = (yield* machines.retiredPeers).includes(name);
      const own = removed ? yield* machines.machineName : undefined;
      return { machineName: name, reachable: false, harnesses: [], missingSecrets: [],
        detail: own === undefined ? "Set up this machine first" : `${name} was removed from ${own}. Set ${name} up again from ${own} to link them.` } satisfies MachinePeerStatus;
    }
    // Only the decode maps to the contract refusal; a link or registry failure arrives as itself.
    const status = yield* options.peerStatus(name).pipe(Effect.flatMap(value =>
      Schema.decodeUnknownEffect(MachinePeerStatus, { onExcessProperty: "error" })(value).pipe(
        Effect.mapError(() => new RemoteHostsError("validation", "machine status did not match the peer contract")))));
    if (status.machineName !== name || (status.installationId !== undefined && status.installationId !== pin.installationId)) {
      return yield* Effect.fail(new RemoteHostsError("conflict", "machine status does not match its setup binding"));
    }
    return { ...status, installationId: pin.installationId };
  });
  const run = (request: OperatorRequestEnvelope, onTransition?: (event: MachineSendEvent) => void): Effect.Effect<unknown, unknown> => Effect.gen(function* () {
    switch (request.op) {
      case "machine.list": {
        const listed = yield* hosts.list;
        const pins = yield* machines.peers;
        const retired = new Set(yield* machines.retiredPeers);
        const seen = new Map((yield* machines.peersSeen).map((row) => [row.machineName, row]));
        const ownId = yield* machines.installationId;
        const ownBuild = yield* options.ownStatus.pipe(Effect.flatMap(status => Schema.decodeUnknownEffect(MachineBuild)(status.build)));
        const pending = options.linkSetup?.pending() ?? [];
        const vaults = options.vaultSetup === undefined ? new Map() : yield* options.vaultSetup.views;
        return { machines: yield* Effect.forEach(listed, machine => Effect.gen(function* () {
          const pin = pins.find(row => row.machineName === machine.id);
          // The live link's word first; what the peer said in its last admitted hello, kept, after a restart.
          const said = pin === undefined ? undefined : seen.get(machine.id);
          const reportedBuild = machine.isThisMachine || pin === undefined ? undefined : (yield* options.peerBuild(machine.id)) ?? said?.build;
          const peerBuild = reportedBuild === undefined ? undefined : yield* Schema.decodeUnknownEffect(MachineBuild)(reportedBuild);
          const claim = said !== undefined && said.build === peerBuild ? said : undefined;
          const needsUpdate = peerBuild !== undefined && peerBuild !== ownBuild;
          const setUp = machine.isThisMachine || pin !== undefined;
          const setupState = setUp ? "set-up" as const
            : retired.has(machine.id) || machine.installRoot !== undefined ? "installed-not-linked" as const : "not-installed" as const;
          const held = pending.filter((row) => row.holder === machine.id).map((row) => row.machineName);
          const vault = vaults.get(machine.id);
          return { machine, setUp, needsUpdate, setupState,
            // Only from a kept hello of this very build: a peer that named no release there is an older build.
            ...(!needsUpdate || claim === undefined ? {} : { updateDirection: machineUpdateDirection(claim, options.release ?? {}) }),
            ...(claim?.version === undefined ? {} : { peerVersion: claim.version }),
            ...(claim?.builtAt === undefined ? {} : { peerBuiltAt: claim.builtAt }),
            ...(machine.isThisMachine ? { installationId: ownId } : pin === undefined ? {} : { installationId: pin.installationId }),
            ...(pin?.binding !== "key" || options.linkSetup === undefined ? {} : { linkKey: options.linkSetup.lineHeld(pin.installationId) ? "bound" as const : "line-missing" as const }),
            ...(held.length === 0 ? {} : { holdsRevokedKeys: held }),
            ...(vault === undefined ? {} : { vault }),
            ...(autoUpdateViews.get(machine.id) === undefined ? {} : { autoUpdate: autoUpdateViews.get(machine.id)! }) };
        })) };
      }
      case "machine.add": {
        const input = request.args;
        const previous = yield* hosts.get(input.name);
        yield* hosts.upsert({
          id: input.name, label: input.label ?? previous?.label ?? input.name, isThisMachine: false,
          ...(previous?.appearance === undefined ? {} : { appearance: previous.appearance }),
          sshEndpoint: input.sshTarget, capabilities: ["terminal"],
          ...(input.sshPort === undefined ? {} : { sshPort: input.sshPort }),
          ...(input.sshIdentityFile === undefined ? {} : { sshIdentityFile: input.sshIdentityFile }),
          ...(input.sshKnownHostsFile === undefined ? {} : { sshKnownHostsFile: input.sshKnownHostsFile }),
          ...(input.sshHostKeyAlias === undefined ? {} : { sshHostKeyAlias: input.sshHostKeyAlias }),
          ...(input.juntoHome === undefined ? {} : { juntoHome: input.juntoHome }),
          ...(input.installRoot === undefined ? {} : { installRoot: input.installRoot }),
        });
        return yield* selected(input.name);
      }
      case "machine.configure": {
        yield* machines.configureName(request.args.name);
        yield* hosts.list;
        return { machineName: yield* machines.machineName, installationId: yield* machines.installationId };
      }
      case "machine.setup": {
        // The answer is the pin's public projection (MachinePeerPin): a pin a
        // link bound to its key keeps that binding in the store, and only the
        // closed fact that it is key-bound leaves in this answer.
        const pin = yield* machines.pinPeer(request.args);
        return { machineName: pin.machineName, installationId: pin.installationId, boundAt: pin.boundAt, keyBound: pin.binding === "key" };
      }
      case "machine.status": {
        const name = request.args.name;
        if (name === undefined || name === (yield* machines.machineName)) return yield* options.ownStatus;
        return yield* peerStatus(name);
      }
      case "machine.harnesses": {
        const name = request.args.name;
        if (name === undefined || name === (yield* machines.machineName)) return yield* options.ownHarnesses;
        const status = yield* peerStatus(name);
        return { machineName: status.machineName, reachable: status.reachable, harnesses: status.harnesses,
          ...("keychain" in status && status.keychain !== undefined ? { keychain: status.keychain } : {}) };
      }
      case "machine.logs": {
        const { name, query } = request.args;
        if (name === (yield* machines.machineName)) return yield* options.ownLogs(query);
        yield* other(name);
        return yield* options.peerLogs(name, query);
      }
      case "machine.seat-start": {
        const { canvas, seatId } = request.args;
        if (options.seatStart === undefined) return yield* Effect.fail(new SeatControlUnavailable({ message: "This Junto process cannot start seats" }));
        const summary = yield* options.seatStart(request.args);
        return {
          canvas, seatId, hostId: summary.hostId, bindingId: summary.bindingId, status: summary.status,
          ...(summary.stopping === true ? { stopping: true } : {}),
          ...(summary.exitReason === undefined ? {} : { exitReason: summary.exitReason }),
          // Without an exitReason the message is built from the seat's terminal output, which never leaves.
          ...(summary.exitReason !== undefined && summary.exitMessage !== undefined ? { exitMessage: scrubMessage(summary.exitMessage) } : {}),
        } satisfies MachineSeatStarted;
      }
      case "machine.seat-stop": {
        const { canvas, seatId } = request.args;
        if (options.seatStop === undefined) return yield* Effect.fail(new SeatControlUnavailable({ message: "This Junto process cannot stop seats" }));
        const { outcome } = yield* options.seatStop(request.args);
        return { canvas, seatId, outcome } satisfies MachineSeatStopped;
      }
      case "machine.seat-read": {
        const { canvas, seatId } = request.args;
        if (options.seatRead === undefined) return yield* Effect.fail(new SeatControlUnavailable({ message: "This Junto process cannot read seats" }));
        return { canvas, seatId, ...(yield* options.seatRead(request.args)) } satisfies MachineSeatRead;
      }
      case "machine.link":
      case "machine.link-key":
      case "machine.link-accept":
      case "machine.link-open":
      case "machine.link-revoke": {
        const setup = options.linkSetup;
        if (setup === undefined) return yield* Effect.fail(new RemoteHostsError("conflict", "This Junto process sets up no link keys"));
        if (request.op === "machine.link") return yield* setup.link(request.args);
        if (request.op === "machine.link-key") return yield* setup.key(request.args);
        if (request.op === "machine.link-accept") return yield* setup.accept(request.args);
        if (request.op === "machine.link-open") return yield* setup.open(request.args);
        return yield* setup.revoke(request.args);
      }
      case "machine.vault-token":
      case "machine.vault-receive": {
        const setup = options.vaultSetup;
        if (setup === undefined) return yield* Effect.fail(new RemoteHostsError("conflict", "This Junto process places no vault tokens"));
        return request.op === "machine.vault-token" ? yield* setup.place(request.args) : yield* setup.receive(request.args);
      }
      case "machine.send":
      case "machine.update": return yield* options.copy(yield* other(request.args.name), request.args, request.op === "machine.send" ? "send" : "update", onTransition);
      case "machine.remove": {
        const name = request.args.name;
        const removed = yield* machines.peer(name);
        const removedHost = yield* Effect.uninterruptible(sql.withTransaction(Effect.gen(function* () {
          const current = yield* rows.read;
          const host = current.hosts.find(row => row.id === name);
          if (host === undefined) return yield* Effect.fail(notFound(name));
          if (host.isThisMachine) return yield* Effect.fail(new RemoteHostsError("conflict", "cannot remove this machine"));
          yield* machines.retirePeer(name);
          yield* rows.delete(name);
          // The owed finishes it was named in go with it: a machine that is
          // removed is never "next seen", so the debt is no longer owed to it.
          yield* sql`DELETE FROM terminal_delete_owed WHERE machine_name = ${name}`;
          return host;
        })).pipe(Effect.provideService(StateTransactionOperation, "machine.remove"),
          Effect.tap(() => options.disconnect(name))));
        // The removed machine first lets go of this machine's link key, over the
        // operator's route while it is still known; one it cannot reach now is
        // kept and cleared the next time Junto reaches it. Then its key comes off
        // here and off every machine this one reaches; one it cannot reach stays listed.
        let cleared: "clear" | "kept" | "unconfirmed" = "clear";
        if (options.linkSetup !== undefined) {
          yield* options.linkSetup.settleRemoved().pipe(Effect.ignore);
          cleared = yield* options.linkSetup.clearRemoved(removedHost, removed?.installationId).pipe(Effect.orElseSucceed(() => "unconfirmed" as const));
        }
        // The key goes with or without a pin: a send that failed before the machine was saved left a key and no pin.
        let keyDropped = true;
        if (options.linkSetup !== undefined) {
          keyDropped = removed === undefined ? yield* options.linkSetup.dropKey(name) : yield* options.linkSetup.forget(name, removed.installationId);
          if (removed !== undefined) yield* options.linkSetup.revokeEverywhere(removed).pipe(Effect.ignore);
        }
        // The record of the token it was given goes with it; revoking that token is the operator's, in 1Password.
        if (options.vaultSetup !== undefined) yield* options.vaultSetup.forget(name).pipe(Effect.ignore);
        yield* hosts.list;
        const setAside = options.linkSetup?.takeSetAside() ?? [];
        if (cleared === "clear" && keyDropped && setAside.length === 0) return { machineName: name, removed: true };
        const self = yield* machines.machineName;
        return { machineName: name, removed: true,
          ...(cleared === "kept" ? { linkKept: { ownWords: true as const,
            message: `${name} is removed, but it still accepts ${self}'s link key. Junto clears it the next time it reaches ${name}.` } } : {}),
          // No key here, and nothing said the far one lets go: never claimed clear, and never claimed it still holds the key.
          ...(!keyDropped ? { linkKeyKept: { ownWords: true as const,
            message: `${name} is removed, but Junto could not delete the link key ${self} holds for it. Add ${name} again, then remove it.` } } : {}),
          ...(cleared === "unconfirmed" ? { linkKept: { ownWords: true as const,
            message: `${name} is removed, but Junto could not confirm it stopped accepting links from ${self}. To clear that, add it again and send Junto to it.` } } : {}),
          // remote-design c72bde3ce: the words carry no path; the path is its own field.
          ...(setAside.length === 0 ? {} : { unlinkSetAside: { ownWords: true as const, paths: setAside,
            message: `Junto could not read its list of removed machines that still accept ${self}'s link key, and set the list aside unchanged. Machines on it may still accept the key until you link them again or remove them again.` } }),
        };
      }
      default: return yield* Effect.fail(new RemoteHostsError("validation", "unsupported machine operation"));
    }
  });
  // Reads and seat control take no machine mutation lock: a seat start must not wait behind a send.
  const unlocked = new Set<string>(["machine.list", "machine.status", "machine.harnesses", "machine.logs", "machine.seat-start", "machine.seat-stop", "machine.seat-read"]);
  return {
    startAutoUpdates,
    dispatch: (request: OperatorRequestEnvelope, onTransition?: (event: MachineSendEvent) => void) =>
      (unlocked.has(request.op) ? run(request, onTransition) : mutationLock.withPermits(1)(run(request, onTransition)).pipe(
        // A send or update that failed part way may still have changed the machine.
        Effect.ensuring(Effect.sync(noteMachinesChanged)))).pipe(
      Effect.map(data => {
        const decoded = decodeOperatorResponse({ protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: true, data });
        if (Result.isSuccess(decoded)) return decoded.success;
        return { protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: false,
          error: { type: "internal_error", message: "machine result did not match its contract", details: { retryable: false } } } as const;
      }),
      Effect.catch(cause => machines.machineName.pipe(Effect.option, Effect.map(machine => encodeFailure(cause, { machine: Option.getOrElse(machine, () => "this machine") })),
        Effect.map(failure => ({ protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: false,
        error: { type: cause instanceof RemoteHostsError ? cause.code : "io",
          // Each message is written by hand, and still passes the scrub: a value a cause carried never leaves.
          message: cause instanceof Error ? scrubText(cause.message.includes("choose another name") || !cause.message.includes("pinned to another installation")
            ? cause.message : `${cause.message}; choose another name`).slice(0, 4096) : "machine operation failed",
          details: {
            retryable: request.op === "machine.status" || request.op === "machine.list" || request.op === "machine.harnesses" || request.op === "machine.logs",
            ...(cause instanceof MachineInstallError ? {
              disposition: cause.disposition,
              ...(cause.transitions === undefined ? {} : { transitions: cause.transitions }),
              ...(cause.runningSeats === undefined ? {} : { runningSeats: cause.runningSeats }),
              ...(cause.runningSeatsUnknown === undefined ? {} : { runningSeatsUnknown: cause.runningSeatsUnknown }),
              ...(cause.ownWords === true ? { ownWords: true as const } : {}),
            } : {}),
            ...(cause instanceof MachineSetupError ? { installed: cause.installed, ...(cause.ownWords === true ? { ownWords: true as const } : {}) } : {}),
            ...(failure === undefined ? {} : { failure }),
          } },
      } as const)))),
    ),
  } satisfies MachineOwnerActions;
});
