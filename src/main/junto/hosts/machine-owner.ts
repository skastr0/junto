import { Context, Effect, Option, Result, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  OPERATOR_PROTOCOL_VERSION, decodeOperatorResponse,
  type OperatorRequestEnvelope, type OperatorResponseEnvelope,
} from "@shared/operator-control";
import { MachineBuild, MachinePeerStatus, type MachineOwnStatus, type MachineHarnesses, type MachineCopyInput } from "@shared/machine-control";
import type { MachineLogQuery, MachineLogRead } from "@shared/machine-log";
import type { MachineSeatInput, MachineSeatRead, MachineSeatReadInput, MachineSeatStartInput, MachineSeatStarted, MachineSeatStopped } from "@shared/machine-seat";
import type { TerminalSessionSummary } from "@shared/terminal";
import { scrubMessage } from "../credentials/scrub";
import { encodeFailure } from "../failure-encode";
import { MachineInstallError, MachineSetupError, type MachineInstallResult } from "@shared/machine-install";
import type { MachineSendEvent } from "@shared/machine-progress";
import { RemoteHostsError, type RemoteHost } from "@shared/remote-hosts";
import { MachineRepository } from "../machines/repository";
import { StateTransactionOperation } from "../state/service";
import { HostsService } from "./service";
import { noteMachinesChanged } from "./machine-changes";
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
}
export class SeatControlUnavailable extends Schema.TaggedError<SeatControlUnavailable>()("SeatControlUnavailable", {
  message: Schema.String.pipe(Schema.check(Schema.isMaxLength(1024))),
}) {}
export interface MachineOwnerActions {
  readonly dispatch: (request: OperatorRequestEnvelope, onTransition?: (event: MachineSendEvent) => void) => Effect.Effect<OperatorResponseEnvelope>;
}
export class MachineOwnerControl extends Context.Service<MachineOwnerControl, MachineOwnerActions>()("@junto/MachineOwnerControl") {}

/** One action implementation for the owner socket and window IPC. */
export const makeMachineOwnerActions = (options: MachineOwnerOptions) => Effect.gen(function* () {
  const machines = yield* MachineRepository;
  const hosts = yield* HostsService;
  const rows = yield* HostRegistryRows;
  const sql = yield* SqlClient.SqlClient;
  const mutationLock = yield* Semaphore.make(1);
  const notFound = (name: string) => new RemoteHostsError("not_found", `unknown machine: ${name}`);
  const selected = (name: string) => hosts.get(name).pipe(Effect.flatMap(host =>
    host === undefined ? Effect.fail(notFound(name)) : Effect.succeed(host)));
  const other = (name: string) => selected(name).pipe(Effect.flatMap(host => host.isThisMachine
    ? Effect.fail(new RemoteHostsError("conflict", "choose another machine")) : Effect.succeed(host)));
  const peerStatus = (name: string) => Effect.gen(function* () {
    yield* other(name);
    const pin = yield* machines.peer(name);
    if (pin === undefined) return { machineName: name, reachable: false, harnesses: [], missingSecrets: [], detail: "Set up this machine first" } satisfies MachinePeerStatus;
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
        const ownId = yield* machines.installationId;
        const ownBuild = yield* options.ownStatus.pipe(Effect.flatMap(status => Schema.decodeUnknownEffect(MachineBuild)(status.build)));
        const pending = options.linkSetup?.pending() ?? [];
        const vaults = options.vaultSetup === undefined ? new Map() : yield* options.vaultSetup.views;
        return { machines: yield* Effect.forEach(listed, machine => Effect.gen(function* () {
          const pin = pins.find(row => row.machineName === machine.id);
          const reportedBuild = machine.isThisMachine || pin === undefined ? undefined : yield* options.peerBuild(machine.id);
          const peerBuild = reportedBuild === undefined ? undefined : yield* Schema.decodeUnknownEffect(MachineBuild)(reportedBuild);
          const held = pending.filter((row) => row.holder === machine.id).map((row) => row.machineName);
          const vault = vaults.get(machine.id);
          return { machine, setUp: machine.isThisMachine || pin !== undefined, needsUpdate: peerBuild !== undefined && peerBuild !== ownBuild,
            ...(machine.isThisMachine ? { installationId: ownId } : pin === undefined ? {} : { installationId: pin.installationId }),
            ...(pin?.binding !== "key" || options.linkSetup === undefined ? {} : { linkKey: options.linkSetup.lineHeld(pin.installationId) ? "bound" as const : "line-missing" as const }),
            ...(held.length === 0 ? {} : { holdsRevokedKeys: held }),
            ...(vault === undefined ? {} : { vault }) };
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
      case "machine.setup": return yield* machines.pinPeer(request.args);
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
        yield* Effect.uninterruptible(sql.withTransaction(Effect.gen(function* () {
          const current = yield* rows.read;
          const host = current.hosts.find(row => row.id === name);
          if (host === undefined) return yield* Effect.fail(notFound(name));
          if (host.isThisMachine) return yield* Effect.fail(new RemoteHostsError("conflict", "cannot remove this machine"));
          yield* machines.retirePeer(name);
          yield* rows.delete(name);
        })).pipe(Effect.provideService(StateTransactionOperation, "machine.remove"),
          Effect.tap(() => options.disconnect(name))));
        // Its key comes off here and off every machine this one reaches; one it cannot reach stays listed.
        if (removed !== undefined && options.linkSetup !== undefined) {
          yield* options.linkSetup.forget(name, removed.installationId);
          yield* options.linkSetup.revokeEverywhere(removed).pipe(Effect.ignore);
        }
        // The record of the token it was given goes with it; revoking that token is the operator's, in 1Password.
        if (options.vaultSetup !== undefined) yield* options.vaultSetup.forget(name).pipe(Effect.ignore);
        yield* hosts.list;
        return { machineName: name, removed: true };
      }
      default: return yield* Effect.fail(new RemoteHostsError("validation", "unsupported machine operation"));
    }
  });
  // Reads and seat control take no machine mutation lock: a seat start must not wait behind a send.
  const unlocked = new Set<string>(["machine.list", "machine.status", "machine.harnesses", "machine.logs", "machine.seat-start", "machine.seat-stop", "machine.seat-read"]);
  return {
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
          message: cause instanceof Error ? (cause.message.includes("pinned to another installation") ? `${cause.message}; choose another name` : cause.message).slice(0, 4096) : "machine operation failed",
          details: {
            retryable: request.op === "machine.status" || request.op === "machine.list" || request.op === "machine.harnesses" || request.op === "machine.logs",
            ...(cause instanceof MachineInstallError ? {
              disposition: cause.disposition,
              ...(cause.transitions === undefined ? {} : { transitions: cause.transitions }),
            } : {}),
            ...(cause instanceof MachineSetupError ? { installed: cause.installed } : {}),
            ...(failure === undefined ? {} : { failure }),
          } },
      } as const)))),
    ),
  } satisfies MachineOwnerActions;
});
