import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime, Result, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, expect, it } from "vitest";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";
import { MODEL_STATE_SCHEMA_SQL } from "../src/main/junto/model/state-schema";
import { MACHINE_STATE_SCHEMA_SQL } from "../src/main/junto/machines/state-schema";
import { makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { MACHINE_REGISTRY_STATE_SCHEMA_SQL } from "../src/main/junto/hosts/state-schema";
import { HostRegistryRows, resetDefaultHostsRegistryForTests } from "../src/main/junto/hosts/registry";
import { HostsServiceLive } from "../src/main/junto/hosts/service";
import { makeMachineOwnerActions } from "../src/main/junto/hosts/machine-owner";
import { SshTransport } from "../src/main/junto/ssh";
import { MachineOwnStatus } from "../src/shared/machine-control";
import { OPERATOR_PROTOCOL_VERSION, decodeOperatorRequest } from "../src/shared/operator-control";
import { hostsSnapshot, setHostsSnapshot } from "../src/main/junto/hosts/snapshot";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); resetDefaultHostsRegistryForTests(); setHostsSnapshot([]); });
const fixture = async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(MACHINE_STATE_SCHEMA_SQL + MACHINE_REGISTRY_STATE_SCHEMA_SQL + MODEL_STATE_SCHEMA_SQL);
  database.exec("CREATE TABLE host_registry_state(singleton INTEGER PRIMARY KEY, version INTEGER, initialized_at TEXT) STRICT");
  const sql = Layer.effect(SqlClient.SqlClient, makeSqliteClient(database)).pipe(Layer.provide(Reactivity.layer));
  const machines = makeMachineRepositoryLive({ defaultName: () => "macbook" }).pipe(Layer.provideMerge(sql));
  const ssh = Layer.succeed(SshTransport, SshTransport.of({ run: () => Effect.die("no dial"), transfer: () => Effect.die("no transfer"), connect: () => Effect.die("no link"), forward: () => Effect.die("no forward"), warm: () => Effect.void, teardown: () => Effect.void }));
  const runtime = ManagedRuntime.make(Layer.mergeAll(HostsServiceLive, HostRegistryRows.layer).pipe(Layer.provideMerge(machines), Layer.provide(ssh)));
  cleanup.push(async () => { await runtime.dispose(); database.close(); });
  const disconnected: string[] = [];
  const probed: string[] = [];
  const owner = await runtime.runPromise(makeMachineOwnerActions({
    ownStatus: Effect.succeed(Schema.decodeUnknownSync(MachineOwnStatus)({ build: "a".repeat(64), installationId: "own-install", machineName: "macbook", juntoHome: "/home/user/probe", pid: 71, ready: true })),
    ownHarnesses: Effect.succeed({ machineName: "macbook", reachable: true, harnesses: [{ harness: "codex", installed: true }] }),
    peerStatus: name => Effect.sync(() => { probed.push(name); return { machineName: name, reachable: false, harnesses: [], missingSecrets: [] }; }),
    copy: () => Effect.die("copy not part of this fixture"),
    disconnect: name => Effect.sync(() => { disconnected.push(name); }),
  }));
  const call = (op: string, args: unknown) => {
    const request = decodeOperatorRequest({ protocol: OPERATOR_PROTOCOL_VERSION, id: "test", op, args });
    if (Result.isFailure(request)) throw new Error(request.failure.message);
    return runtime.runPromise(owner.dispatch(request.success));
  };
  return { database, call, disconnected, probed };
};

it("joins active pins on the list and retires the pin with route removal", async () => {
  const f = await fixture();
  await f.call("machine.add", { name: "mini", sshTarget: "mac-mini" });
  const before = await f.call("machine.list", {});
  expect(before.ok && before.op === "machine.list" && before.data.machines.find(row => row.machine.id === "mini")?.setUp).toBe(false);
  const unbound = await f.call("machine.status", { name: "mini" });
  expect(unbound.ok && unbound.op === "machine.status" && "detail" in unbound.data && unbound.data.detail).toBe("Set up this machine first");
  expect(f.probed).toEqual([]);
  await f.call("machine.setup", { machineName: "mini", installationId: "mini-install" });
  const bound = await f.call("machine.status", { name: "mini" });
  expect(bound.ok && bound.op === "machine.status" && bound.data.installationId).toBe("mini-install");
  const after = await f.call("machine.list", {});
  expect(after.ok && after.op === "machine.list" && after.data.machines.find(row => row.machine.id === "mini")?.setUp).toBe(true);
  expect((await f.call("machine.remove", { name: "mini" })).ok).toBe(true);
  expect(f.database.prepare("SELECT id FROM host_registry WHERE id='mini'").get()).toBeUndefined();
  expect(f.database.prepare("SELECT retired_at FROM machine_peers WHERE machine_name='mini'").get()?.retired_at).toBeTruthy();
  expect(f.disconnected).toEqual(["mini"]);
  await f.call("machine.add", { name: "mini", sshTarget: "mac-mini" });
  const changed = await f.call("machine.setup", { machineName: "mini", installationId: "another-install" });
  expect(changed.ok).toBe(false);
  if (!changed.ok) expect(changed.error.message).toContain("choose another name");
});

it("rolls back peer retirement if deleting the route fails", async () => {
  const f = await fixture();
  await f.call("machine.add", { name: "mini", sshTarget: "mac-mini" });
  await f.call("machine.setup", { machineName: "mini", installationId: "mini-install" });
  f.database.exec("CREATE TRIGGER refuse_test_remove BEFORE DELETE ON host_registry WHEN OLD.id='mini' BEGIN SELECT RAISE(ABORT,'test refuses removal'); END");
  expect((await f.call("machine.remove", { name: "mini" })).ok).toBe(false);
  expect(f.database.prepare("SELECT retired_at FROM machine_peers WHERE machine_name='mini'").get()?.retired_at).toBeNull();
  expect(f.database.prepare("SELECT id FROM host_registry WHERE id='mini'").get()?.id).toBe("mini");
  expect(f.disconnected).toEqual([]);
});

it("refreshes the hydrated routing name after initial configuration", async () => {
  const f = await fixture();
  expect((await f.call("machine.configure", { name: "studio" })).ok).toBe(true);
  expect(hostsSnapshot().find(row => row.isThisMachine)?.id).toBe("studio");
  expect((await f.call("machine.remove", { name: "studio" })).ok).toBe(false);
});
