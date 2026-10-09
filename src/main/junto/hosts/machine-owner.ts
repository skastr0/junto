import { Context, Effect, Result, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  OPERATOR_PROTOCOL_VERSION, decodeOperatorResponse,
  type OperatorRequestEnvelope, type OperatorResponseEnvelope,
} from "@shared/operator-control";
import { MachineBuild, MachinePeerStatus, type MachineOwnStatus, type MachineHarnesses, type MachineCopyInput } from "@shared/machine-control";
import { MachineInstallError, MachineSetupError, type MachineInstallResult } from "@shared/machine-install";
import type { MachineSendEvent } from "@shared/machine-progress";
import { RemoteHostsError, type RemoteHost } from "@shared/remote-hosts";
import { MachineRepository } from "../machines/repository";
import { StateTransactionOperation } from "../state/service";
import { HostsService } from "./service";
import { HostRegistryRows } from "./registry";

export interface MachineOwnerOptions {
  readonly ownStatus: Effect.Effect<MachineOwnStatus, unknown>;
  readonly ownHarnesses: Effect.Effect<MachineHarnesses, unknown>;
  readonly peerStatus: (name: string) => Effect.Effect<MachinePeerStatus, unknown>;
  readonly peerBuild: (name: string) => Effect.Effect<string | undefined, unknown>;
  readonly copy: (host: RemoteHost, input: MachineCopyInput, mode: "send" | "update", onTransition?: (event: MachineSendEvent) => void) => Effect.Effect<MachineInstallResult, unknown>;
  readonly disconnect: (name: string) => Effect.Effect<void, unknown>;
}
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
    const status = yield* options.peerStatus(name).pipe(Effect.flatMap(value =>
      Schema.decodeUnknownEffect(MachinePeerStatus, { onExcessProperty: "error" })(value)),
      Effect.mapError(() => new RemoteHostsError("validation", "machine status did not match the peer contract")));
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
        return { machines: yield* Effect.forEach(listed, machine => Effect.gen(function* () {
          const pin = pins.find(row => row.machineName === machine.id);
          const reportedBuild = machine.isThisMachine || pin === undefined ? undefined : yield* options.peerBuild(machine.id);
          const peerBuild = reportedBuild === undefined ? undefined : yield* Schema.decodeUnknownEffect(MachineBuild)(reportedBuild);
          return { machine, setUp: machine.isThisMachine || pin !== undefined, needsUpdate: peerBuild !== undefined && peerBuild !== ownBuild,
            ...(machine.isThisMachine ? { installationId: ownId } : pin === undefined ? {} : { installationId: pin.installationId }) };
        })) };
      }
      case "machine.add": {
        const input = request.args;
        const previous = yield* hosts.get(input.name);
        yield* hosts.upsert({
          id: input.name, label: input.label ?? previous?.label ?? input.name, isThisMachine: false,
          ...(previous?.appearance === undefined ? {} : { appearance: previous.appearance }),
          ...(previous?.hermesId === undefined ? {} : { hermesId: previous.hermesId }),
          sshEndpoint: input.sshTarget, capabilities: ["terminal", "hermes"],
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
      case "machine.send":
      case "machine.update": return yield* options.copy(yield* other(request.args.name), request.args, request.op === "machine.send" ? "send" : "update", onTransition);
      case "machine.remove": {
        const name = request.args.name;
        yield* Effect.uninterruptible(sql.withTransaction(Effect.gen(function* () {
          const current = yield* rows.read;
          const host = current.hosts.find(row => row.id === name);
          if (host === undefined) return yield* Effect.fail(notFound(name));
          if (host.isThisMachine) return yield* Effect.fail(new RemoteHostsError("conflict", "cannot remove this machine"));
          yield* machines.retirePeer(name);
          yield* rows.delete(name);
        })).pipe(Effect.provideService(StateTransactionOperation, "machine.remove"),
          Effect.tap(() => options.disconnect(name))));
        yield* hosts.list;
        return { machineName: name, removed: true };
      }
      default: return yield* Effect.fail(new RemoteHostsError("validation", "unsupported machine operation"));
    }
  });
  return {
    dispatch: (request: OperatorRequestEnvelope, onTransition?: (event: MachineSendEvent) => void) =>
      (request.op === "machine.list" || request.op === "machine.status" || request.op === "machine.harnesses"
        ? run(request, onTransition) : mutationLock.withPermits(1)(run(request, onTransition))).pipe(
      Effect.map(data => {
        const decoded = decodeOperatorResponse({ protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: true, data });
        if (Result.isSuccess(decoded)) return decoded.success;
        return { protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: false,
          error: { type: "internal_error", message: "machine result did not match its contract", details: { retryable: false } } } as const;
      }),
      Effect.catch(cause => Effect.succeed({ protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: false,
        error: { type: cause instanceof RemoteHostsError ? cause.code : "io",
          message: cause instanceof Error ? (cause.message.includes("pinned to another installation") ? `${cause.message}; choose another name` : cause.message).slice(0, 4096) : "machine operation failed",
          details: {
            retryable: request.op === "machine.status" || request.op === "machine.list" || request.op === "machine.harnesses",
            ...(cause instanceof MachineInstallError ? {
              disposition: cause.disposition,
              ...(cause.transitions === undefined ? {} : { transitions: cause.transitions }),
            } : {}),
            ...(cause instanceof MachineSetupError ? { installed: cause.installed } : {}),
          } },
      } as const)),
    ),
  } satisfies MachineOwnerActions;
});
