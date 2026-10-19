/**
 * The owner's Boat commands (docs/machines.md, Boat machines): connect and
 * disconnect the account, add a machine, wake it, put it to sleep, delete it,
 * and read where each one stands. A machine is added through the same
 * `machine.add` and `machine.send` every machine uses; Boat only makes the
 * sandbox, finds its route and places its machine key.
 */
import { randomUUID } from "node:crypto";
import { Effect, Result, Schema } from "effect";
import {
  BOAT_LEASE_SECONDS, type BoatAddInput, type BoatConnectData, type BoatDisconnectData, type BoatKeyId,
  type BoatMachineView, type BoatStatusData,
} from "@shared/boat";
import { MachineInstallResult } from "@shared/machine-install";
import type { MachineRemoved } from "@shared/machine-control";
import {
  decodeOperatorResponse, OPERATOR_PROTOCOL_VERSION, OperatorErrorType,
  type OperatorRequestEnvelope, type OperatorResponseEnvelope,
} from "@shared/operator-control";
import type { MachineSendEvent } from "@shared/machine-progress";
import type { RemoteHost } from "@shared/remote-hosts";
import { parseHostSshRoute, SshTransport } from "../ssh";
import { makeRemoteStdin } from "../ssh/domain";
import { placeBoatMachineKey } from "../ssh/machine-commands";
import {
  boatKeyFailed, deleteBoatAccountKey, mintBoatAccountKey, mintBoatMachineKey, readBoatAccountKey,
  requireBoatCliSignedIn, revokeBoatKey, storeBoatAccountKey,
} from "./account";
import { boatFailureMessage, type BoatClient, type BoatRun } from "./client";

export { boatFailureMessage };
import { readBoatRecords, updateBoatRecords, type BoatMachineRecord } from "./files";
import { BoatMachineRefused, type BoatMachines } from "./machines";

export interface BoatOwnerDeps {
  /** Runs a Boat request in the core's own runtime. */
  readonly run: BoatRun;
  readonly home: string;
  readonly machineName: () => Promise<string>;
  readonly client: BoatClient;
  readonly machines: BoatMachines;
  readonly getHost: (name: string) => Promise<RemoteHost | undefined>;
  /** The machine commands every machine uses, with their lock. */
  readonly dispatch: (request: OperatorRequestEnvelope, onTransition?: (event: MachineSendEvent) => void) => Promise<OperatorResponseEnvelope>;
  readonly log: (level: "Info" | "Warning", message: string, fields: Record<string, unknown>) => void;
}

class BoatMachineCommandFailed extends Schema.TaggedError<BoatMachineCommandFailed>()("BoatMachineCommandFailed", {
  op: Schema.String,
  type: Schema.String,
  message: Schema.String,
}) {}

const requestId = () => `boat-${randomUUID()}`;

export const makeBoatOwner = (deps: BoatOwnerDeps) => Effect.gen(function* () {
  const ssh = yield* SshTransport;

  /** A machine command through the owner's own dispatch; its refusal is passed on as it came. */
  const machineCommand = async <A>(op: string, args: unknown, onTransition?: (event: MachineSendEvent) => void): Promise<A> => {
    const response = await deps.dispatch({ protocol: OPERATOR_PROTOCOL_VERSION, id: requestId(), op, args } as OperatorRequestEnvelope, onTransition);
    if (!response.ok) throw new BoatMachineCommandFailed({ op, type: response.error.type, message: response.error.message });
    return (response as unknown as { readonly data: A }).data;
  };

  const revokeOrKeep = async (id: BoatKeyId | undefined): Promise<ReadonlyArray<BoatKeyId>> => {
    if (id === undefined) return [];
    try { await revokeBoatKey(id); return []; } catch {
      deps.log("Warning", "Boat key not revoked", { boatKeyId: id });
      return [id];
    }
  };

  const requireAccount = () => {
    if (readBoatAccountKey(deps.home) === undefined) throw boatKeyFailed("not-connected");
  };

  const connect = async (): Promise<BoatConnectData> => {
    await requireBoatCliSignedIn();
    const minted = await mintBoatAccountKey(await deps.machineName());
    try { storeBoatAccountKey(deps.home, minted.secret); } catch (cause) {
      await revokeOrKeep(minted.id);
      throw cause;
    }
    const before = (await readBoatRecords(deps.home)).accountKeyId;
    const unrevoked = before !== undefined && before !== minted.id ? await revokeOrKeep(before) : [];
    await updateBoatRecords(deps.home, (records) => ({
      ...records, accountKeyId: minted.id,
      ...(minted.expiresAt === undefined ? {} : { accountKeyExpiresAt: minted.expiresAt }),
      unrevokedKeyIds: [...(records.unrevokedKeyIds ?? []), ...unrevoked].slice(-16),
    }));
    deps.log("Info", "Boat account connected", { boatKeyId: minted.id });
    return { connected: true, keyId: minted.id, ...(minted.expiresAt === undefined ? {} : { expiresAt: minted.expiresAt }), unrevokedKeyIds: unrevoked };
  };

  const disconnect = async (): Promise<BoatDisconnectData> => {
    const records = await readBoatRecords(deps.home);
    const unrevoked = await revokeOrKeep(records.accountKeyId);
    deleteBoatAccountKey(deps.home);
    await updateBoatRecords(deps.home, ({ accountKeyId: _id, accountKeyExpiresAt: _at, ...rest }) => ({
      ...rest, unrevokedKeyIds: [...(rest.unrevokedKeyIds ?? []), ...unrevoked].slice(-16),
    }));
    return { connected: false, unrevokedKeyIds: unrevoked };
  };

  const status = async (): Promise<BoatStatusData> => {
    const records = await readBoatRecords(deps.home);
    const machines = await Promise.all(records.machines.map(async (row) => {
      try { return await deps.machines.view(row.name); } catch {
        return { machineName: row.name, sandboxId: row.sandboxId, size: row.size, power: "failed" as const, unreadable: true as const };
      }
    }));
    return {
      connected: readBoatAccountKey(deps.home) !== undefined,
      ...(records.accountKeyId === undefined ? {} : { keyId: records.accountKeyId }),
      ...(records.accountKeyExpiresAt === undefined ? {} : { expiresAt: records.accountKeyExpiresAt }),
      unrevokedKeyIds: [...(records.unrevokedKeyIds ?? []), ...records.machines.flatMap((row) => row.unrevokedKeyIds ?? [])],
      machines,
    };
  };

  const setRecord = (name: string, change: (row: BoatMachineRecord) => BoatMachineRecord) =>
    updateBoatRecords(deps.home, (records) => ({ ...records, machines: records.machines.map((row) => row.name === name ? change(row) : row) }));

  /**
   * Mints a key for this one sandbox and has the machine's own Junto write it
   * from stdin, over the dialled session; the old key is revoked after.
   */
  const placeMachineKey = async (row: BoatMachineRecord): Promise<void> => {
    const host = await deps.getHost(row.name);
    if (host?.juntoHome === undefined || host.installRoot === undefined) {
      throw new BoatMachineRefused({ machine: row.name, check: "failed", message: `Send Junto to ${row.name} before its machine key` });
    }
    const minted = await mintBoatMachineKey(row.name, row.sandboxId);
    try {
      const place: Effect.Effect<void, unknown> = Effect.gen(function* () {
        const target = yield* parseHostSshRoute(host);
        const input = yield* makeRemoteStdin(JSON.stringify({ sandboxId: row.sandboxId, keyId: minted.id, key: minted.secret }));
        const program = yield* placeBoatMachineKey(target, { juntoHome: host.juntoHome!, installRoot: host.installRoot! }, input);
        yield* ssh.run(program);
      });
      await deps.run(place);
    } catch {
      await revokeOrKeep(minted.id);
      throw new BoatMachineRefused({ machine: row.name, check: "failed", message: `The machine key could not be placed on ${row.name}` });
    }
    const unrevoked = await revokeOrKeep(row.machineKeyId);
    await setRecord(row.name, (current) => ({
      ...current, machineKeyId: minted.id, unrevokedKeyIds: [...(current.unrevokedKeyIds ?? []), ...unrevoked].slice(-16),
    }));
    deps.log("Info", "Boat machine key placed", { machine: row.name, sandboxId: row.sandboxId, boatKeyId: minted.id });
  };

  const add = async (input: BoatAddInput, onTransition?: (event: MachineSendEvent) => void) => {
    requireAccount();
    // Nothing is made until the CLI that mints the machine key is known to work.
    await requireBoatCliSignedIn();
    let row = (await readBoatRecords(deps.home)).machines.find((machine) => machine.name === input.name);
    if (row === undefined && await deps.getHost(input.name) !== undefined) {
      throw new BoatMachineRefused({ machine: input.name, check: "failed", message: `A machine named ${input.name} already exists; choose another name` });
    }
    if (row === undefined) {
      const size = input.size ?? "small";
      const sandboxId = await deps.run(deps.client.create({
        size, ttlSeconds: BOAT_LEASE_SECONDS, idempotencyKey: `junto-${randomUUID()}`,
        ...(input.environment === undefined ? {} : { environment: input.environment }),
      }));
      const made: BoatMachineRecord = { name: input.name, sandboxId, size, ...(input.environment === undefined ? {} : { environment: input.environment }) };
      await updateBoatRecords(deps.home, (records) => ({ ...records, machines: [...records.machines, made] }));
      deps.log("Info", "Boat machine created", { machine: input.name, sandboxId });
      row = made;
    }
    await deps.machines.wake(input.name, { core: false });
    const route = await deps.machines.routeFields(input.name);
    await machineCommand("machine.add", {
      name: input.name, ...(input.label === undefined ? {} : { label: input.label }),
      sshTarget: route.sshEndpoint, sshPort: route.sshPort, sshIdentityFile: route.sshIdentityFile,
      sshKnownHostsFile: route.sshKnownHostsFile, sshHostKeyAlias: route.sshHostKeyAlias,
    });
    const installed = Schema.decodeUnknownSync(MachineInstallResult)(await machineCommand("machine.send", { name: input.name }, onTransition));
    await placeMachineKey((await readBoatRecords(deps.home)).machines.find((machine) => machine.name === input.name)!);
    return { machine: await deps.machines.view(input.name), installed };
  };

  /** After an update: a new machine key, the old revoked. The update stands when the CLI cannot mint. */
  const renewKey = async (name: string): Promise<void> => {
    const row = await deps.machines.record(name);
    if (row === undefined) return;
    await placeMachineKey(row).catch((cause: unknown) => {
      deps.log("Warning", "Boat machine key kept: a new one could not be placed", {
        machine: name, sandboxId: row.sandboxId, detail: boatFailureMessage(cause, "failed"),
      });
    });
  };

  /**
   * Leaves Boat's side of a removed machine: its key revoked, the sandbox
   * deleted (`deleteSandbox`) or stopped and kept, and the record dropped.
   */
  const retire = async (name: string, deleteSandbox: boolean): Promise<void> => {
    const row = await deps.machines.record(name);
    if (row === undefined) return;
    const unrevoked = [...(row.unrevokedKeyIds ?? []), ...await revokeOrKeep(row.machineKeyId)];
    if (deleteSandbox) await deps.run(deps.client.remove(row.sandboxId));
    else await deps.run(deps.client.stop(row.sandboxId)).catch(() => undefined);
    await updateBoatRecords(deps.home, (records) => ({
      ...records, machines: records.machines.filter((machine) => machine.name !== name),
      unrevokedKeyIds: [...(records.unrevokedKeyIds ?? []), ...unrevoked].slice(-16),
    }));
    deps.log("Info", deleteSandbox ? "Boat machine deleted" : "Boat machine removed, its sandbox kept asleep", { machine: name, sandboxId: row.sandboxId });
  };

  const boatDelete = async (name: string): Promise<MachineRemoved> => {
    requireAccount();
    if (await deps.machines.record(name) === undefined) throw new BoatMachineRefused({ machine: name, check: "not-boat", message: `${name} is not a Boat machine` });
    // An add that failed before machine.add leaves a sandbox with no machine to remove.
    const removed = await deps.getHost(name) === undefined
      ? { machineName: name, removed: true as const }
      : await machineCommand<MachineRemoved>("machine.remove", { name });
    await retire(name, true);
    return removed;
  };

  const handle = async (request: OperatorRequestEnvelope, onTransition?: (event: MachineSendEvent) => void): Promise<unknown> => {
    const args = request.args as { readonly name?: string };
    switch (request.op) {
      case "machine.boat-connect": return connect();
      case "machine.boat-disconnect": return disconnect();
      case "machine.boat-status": return status();
      case "machine.boat-add": return add(request.args as BoatAddInput, onTransition);
      case "machine.boat-delete": return boatDelete(args.name!);
      case "machine.wake": { requireAccount(); return deps.machines.wake(args.name!) satisfies Promise<BoatMachineView>; }
      case "machine.sleep": { requireAccount(); return deps.machines.sleep(args.name!); }
      default: throw new BoatMachineRefused({ machine: args.name ?? "", check: "failed", message: "Not a Boat command" });
    }
  };

  /** The route an awake machine has now, kept in the machine list. */
  const refreshRoute = async (name: string): Promise<void> => {
    const host = await deps.getHost(name);
    if (host !== undefined) await deps.machines.route(host);
  };

  return { handle, renewKey, retire, refreshRoute };
});

export const BOAT_OWNER_OPS: ReadonlySet<string> = new Set([
  "machine.boat-connect", "machine.boat-disconnect", "machine.boat-status", "machine.boat-add", "machine.boat-delete", "machine.wake", "machine.sleep",
]);


type BoatOwner = Effect.Success<ReturnType<typeof makeBoatOwner>>;
type Dispatch = (request: OperatorRequestEnvelope, onTransition?: (event: MachineSendEvent) => void) => Effect.Effect<OperatorResponseEnvelope>;

const errorType = (cause: unknown): OperatorErrorType => {
  const tag = (cause as { _tag?: string } | undefined)?._tag;
  if (tag === "BoatMachineCommandFailed") {
    const type = (cause as { type: string }).type;
    return Schema.is(OperatorErrorType)(type) ? type : "io";
  }
  if (tag === "BoatMachineRefused" && (cause as { check?: string }).check === "not-boat") return "not_found";
  if (tag === "BoatKeyFailed" && (cause as { check?: string }).check === "not-connected") return "conflict";
  return "io";
};

/**
 * The owner's dispatch with Boat in it: Boat's own commands, and around the
 * commands every machine uses, a wake before a send or an update, a new
 * machine key after an update, and Boat's side of a removed machine.
 */
export const boatOwnerDispatch = (owner: BoatOwner, machines: BoatMachines, dispatch: Dispatch): Dispatch =>
  (request, onTransition) => {
    const fail = (cause: unknown): OperatorResponseEnvelope => ({
      protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: false,
      error: { type: errorType(cause), message: boatFailureMessage(cause), details: { retryable: request.op === "machine.boat-status" } },
    });
    if (BOAT_OWNER_OPS.has(request.op)) {
      return Effect.promise(() => owner.handle(request, onTransition).then((data) => {
        const decoded = decodeOperatorResponse({ protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: true, data });
        return Result.isSuccess(decoded) ? decoded.success : fail(new Error("contract"));
      }, fail));
    }
    const name = (request.args as { readonly name?: unknown }).name;
    if (typeof name !== "string" || !["machine.send", "machine.update", "machine.remove"].includes(request.op)) return dispatch(request, onTransition);
    return Effect.gen(function* () {
      if ((yield* Effect.promise(() => machines.record(name))) === undefined) return yield* dispatch(request, onTransition);
      if (request.op !== "machine.remove") {
        // The send dials the route a woken machine has now.
        const woke = yield* Effect.promise(() => machines.wake(name, { core: false }).then(
          () => owner.refreshRoute(name).then(() => undefined),
          (cause: unknown) => cause,
        ));
        if (woke !== undefined) return fail(woke);
      }
      const response = yield* dispatch(request, onTransition);
      if (response.ok && request.op === "machine.update") yield* Effect.promise(() => owner.renewKey(name));
      if (response.ok && request.op === "machine.remove") yield* Effect.promise(() => owner.retire(name, false).catch(() => undefined));
      return response;
    });
  };
