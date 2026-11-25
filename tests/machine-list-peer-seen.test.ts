/**
 * machine.list says how far each machine is set up, and for one on another
 * build which of the two is behind, from what that machine last said in a
 * hello this one admitted, kept across a restart (remote-verify receipt 3).
 */
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime, Result, Schema } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient } from "effect/sql";
import { afterEach, expect, it } from "vitest";
import { makeSqliteClient } from "../src/core/state/sqlite-client";
import { MODEL_STATE_SCHEMA_SQL } from "../src/core/model/state-schema";
import { MACHINE_STATE_SCHEMA_SQL } from "../src/core/machines/state-schema";
import { MachineRepository, makeMachineRepositoryLive } from "../src/core/machines/repository";
import { MACHINE_REGISTRY_STATE_SCHEMA_SQL } from "../src/core/hosts/state-schema";
import { TERMINAL_DELETE_STATE_SCHEMA_SQL } from "../src/core/term/node-delete-state-schema";
import { HostRegistryRows, resetDefaultHostsRegistryForTests } from "../src/core/hosts/registry";
import { HostsServiceLive } from "../src/core/hosts/service";
import { makeMachineOwnerActions, type MachineOwnerOptions } from "../src/core/hosts/machine-owner";
import { SshTransport } from "../src/core/ssh";
import { InstallationId } from "../src/shared/installation-id";
import { MachineOwnStatus } from "../src/shared/machine-control";
import { OPERATOR_PROTOCOL_VERSION, decodeOperatorRequest } from "../src/shared/operator-control";
import { setHostsSnapshot } from "../src/core/hosts/snapshot";
import { makeTestLog } from "./support/test-log";

const testLog = makeTestLog();
const OWN = "a".repeat(64);
const OLD = "c".repeat(64);
const NEWER = "d".repeat(64);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); resetDefaultHostsRegistryForTests(); setHostsSnapshot([]); });

/** One machine's owner over a real store; `live` stands for the builds its links heard since it started. */
const owner = async (overrides: Partial<MachineOwnerOptions> = {}) => {
  const database = new DatabaseSync(":memory:");
  database.exec(MACHINE_STATE_SCHEMA_SQL + MACHINE_REGISTRY_STATE_SCHEMA_SQL + MODEL_STATE_SCHEMA_SQL + TERMINAL_DELETE_STATE_SCHEMA_SQL);
  database.exec("CREATE TABLE host_registry_state(singleton INTEGER PRIMARY KEY, version INTEGER, initialized_at TEXT) STRICT");
  const sql = Layer.effect(SqlClient.SqlClient, makeSqliteClient(database)).pipe(Layer.provide(Reactivity.layer));
  const machines = makeMachineRepositoryLive({ defaultName: () => "studio" }).pipe(Layer.provideMerge(sql));
  const ssh = Layer.succeed(SshTransport, SshTransport.of({ run: () => Effect.die("no dial"), transfer: () => Effect.die("no transfer"), connect: () => Effect.die("no link"), forward: () => Effect.die("no forward"), warm: () => Effect.void, teardown: () => Effect.void }));
  const runtime = ManagedRuntime.make(Layer.mergeAll(HostsServiceLive, HostRegistryRows.layer).pipe(Layer.provideMerge(testLog.log.loggerLayer), Layer.provideMerge(machines), Layer.provideMerge(ssh)));
  cleanup.push(async () => { await runtime.dispose(); database.close(); });
  const live = new Map<string, string>();
  const actions = await runtime.runPromise(makeMachineOwnerActions({
    ownStatus: Effect.succeed(Schema.decodeUnknownSync(MachineOwnStatus)({ build: OWN, installationId: "own-install", machineName: "studio", juntoHome: "/home/user/probe", pid: 71, ready: true, form: "mac-mini" as const, keychain: "available" })),
    ownHarnesses: Effect.die("not part of this fixture"),
    peerBuild: (name) => Effect.sync(() => live.get(name)),
    peerStatus: () => Effect.die("no status is read in this fixture"),
    copy: () => Effect.die("not part of this fixture"),
    disconnect: () => Effect.void,
    ownLogs: () => Effect.die("not part of this fixture"),
    peerLogs: () => Effect.die("not part of this fixture"),
    release: { version: "0.12.0", builtAt: "2026-11-24T10:00:00Z" },
    ...overrides,
  }));
  const call = async (op: string, args: unknown) => {
    const request = decodeOperatorRequest({ protocol: OPERATOR_PROTOCOL_VERSION, id: "test", op, args });
    if (Result.isFailure(request)) throw new Error(request.failure.message);
    return runtime.runPromise(actions.dispatch(request.success));
  };
  const rowOf = async (name: string) => {
    const listed = await call("machine.list", {});
    if (!listed.ok || listed.op !== "machine.list") throw new Error(JSON.stringify(listed));
    return listed.data.machines.find((row) => row.machine.id === name);
  };
  const repo = <A>(use: (machines: MachineRepository["Service"]) => Effect.Effect<A, unknown>) => runtime.runPromise(Effect.flatMap(MachineRepository, use));
  const pin = (name: string) => repo((machines) => machines.pinPeer({ machineName: name, installationId: Schema.decodeUnknownSync(InstallationId)(`${name}-install`) }));
  return { call, rowOf, repo, pin, live, database };
};

it("says not-installed for a machine only added, installed-not-linked for one with an install root or once removed, and set-up when pinned", async () => {
  const f = await owner();
  await f.call("machine.add", { name: "box", sshTarget: "box" });
  await f.call("machine.add", { name: "far", sshTarget: "far", installRoot: "/opt/junto" });
  await f.call("machine.add", { name: "mini", sshTarget: "mini" });
  expect((await f.rowOf("studio"))?.setupState).toBe("set-up");
  expect((await f.rowOf("box"))?.setupState).toBe("not-installed");
  expect((await f.rowOf("far"))?.setupState).toBe("installed-not-linked");
  await f.pin("mini");
  expect((await f.rowOf("mini"))).toMatchObject({ setUp: true, setupState: "set-up" });
  // Removed, then added again: Junto is still there, and the words name both machines.
  await f.call("machine.remove", { name: "mini" });
  await f.call("machine.add", { name: "mini", sshTarget: "mini" });
  expect((await f.rowOf("mini"))).toMatchObject({ setUp: false, setupState: "installed-not-linked" });
  const status = await f.call("machine.status", { name: "mini" });
  expect(status.ok && status.op === "machine.status" && "detail" in status.data && status.data.detail)
    .toBe("mini was removed from studio. Set mini up again from studio to link them.");
  // One never set up keeps its words.
  const never = await f.call("machine.status", { name: "box" });
  expect(never.ok && never.op === "machine.status" && "detail" in never.data && never.data.detail).toBe("Set up this machine first");
});

it("says a machine needs an update after a restart, from the hello it kept, and which one is behind", async () => {
  const f = await owner();
  await f.call("machine.add", { name: "mini", sshTarget: "mini" });
  await f.call("machine.add", { name: "book", sshTarget: "book" });
  await f.pin("mini");
  await f.pin("book");
  await f.repo((machines) => machines.notePeerHello({ machineName: "mini", installationId: "mini-install" as InstallationId, build: OLD, version: "0.11.15", builtAt: "2026-11-10T10:00:00Z" }));
  await f.repo((machines) => machines.notePeerHello({ machineName: "book", installationId: "book-install" as InstallationId, build: NEWER, version: "0.12.1" }));
  // No link has opened since this machine started: the kept hellos still say who is behind.
  expect(f.live.size).toBe(0);
  expect(await f.rowOf("mini")).toMatchObject({ needsUpdate: true, updateDirection: "peer-older", peerVersion: "0.11.15", peerBuiltAt: "2026-11-10T10:00:00Z" });
  expect(await f.rowOf("book")).toMatchObject({ needsUpdate: true, updateDirection: "this-older", peerVersion: "0.12.1" });
  expect((await f.rowOf("book"))?.peerBuiltAt).toBeUndefined();
});

it("takes the live link's build over the kept one, and says no direction from a hello of another build", async () => {
  const f = await owner();
  await f.call("machine.add", { name: "mini", sshTarget: "mini" });
  await f.pin("mini");
  await f.repo((machines) => machines.notePeerHello({ machineName: "mini", installationId: "mini-install" as InstallationId, build: OLD, version: "0.11.15" }));
  // Updated since: the live link heard this machine's own build.
  f.live.set("mini", OWN);
  expect(await f.rowOf("mini")).toMatchObject({ needsUpdate: false });
  expect((await f.rowOf("mini"))?.peerVersion).toBeUndefined();
  // Another build, not yet kept: it needs an update, and which way is not guessed.
  f.live.set("mini", NEWER);
  const row = await f.rowOf("mini");
  expect(row).toMatchObject({ needsUpdate: true });
  expect(row?.updateDirection).toBeUndefined();
});

it("keeps a hello only for an active peer under its pinned installation, and forgets it when the peer is retired", async () => {
  const f = await owner();
  await f.call("machine.add", { name: "mini", sshTarget: "mini" });
  await f.repo((machines) => machines.notePeerHello({ machineName: "mini", installationId: "mini-install" as InstallationId, build: OLD }));
  expect(await f.repo((machines) => machines.peersSeen)).toEqual([]);
  await f.pin("mini");
  await f.repo((machines) => machines.notePeerHello({ machineName: "mini", installationId: "other-install" as InstallationId, build: OLD }));
  expect(await f.repo((machines) => machines.peersSeen)).toEqual([]);
  // A release its schema refuses is left out, the rest kept.
  await f.repo((machines) => machines.notePeerHello({ machineName: "mini", installationId: "mini-install" as InstallationId, build: OLD, version: "dev" }));
  expect(await f.repo((machines) => machines.peersSeen)).toEqual([expect.objectContaining({ machineName: "mini", build: OLD })]);
  expect((await f.repo((machines) => machines.peersSeen))[0]?.version).toBeUndefined();
  await f.call("machine.remove", { name: "mini" });
  expect(f.database.prepare("SELECT COUNT(*) AS n FROM machine_peer_seen").get()).toEqual({ n: 0 });
  expect(await f.repo((machines) => machines.retiredPeers)).toEqual(["mini"]);
});

it("keeps a true last-live time for an unchanged build, moving a stale one and not a fresh one", async () => {
  const f = await owner();
  await f.call("machine.add", { name: "mini", sshTarget: "mini" });
  await f.pin("mini");
  const hello = { machineName: "mini", installationId: "mini-install" as InstallationId, build: OLD };
  const seen = async () => (await f.repo((machines) => machines.peersSeen))[0]?.seenAt;
  await f.repo((machines) => machines.notePeerHello(hello));
  const first = await seen();
  expect(first).toBeDefined();

  f.database.prepare("UPDATE machine_peer_seen SET seen_at = ? WHERE installation_id = 'mini-install'").run("2026-11-25T10:00:00.000Z");
  await f.repo((machines) => machines.notePeerHello(hello));
  const moved = await seen();
  expect(moved).not.toBe("2026-11-25T10:00:00.000Z");
  await f.repo((machines) => machines.notePeerHello(hello));
  expect(await seen()).toBe(moved);

  f.database.prepare("UPDATE machine_peer_seen SET seen_at = ? WHERE installation_id = 'mini-install'").run("2026-11-25T10:00:00.000Z");
  await f.repo((machines) => machines.notePeerHello({ ...hello, build: NEWER }));
  expect(await seen()).not.toBe("2026-11-25T10:00:00.000Z");
});

it("keys what a peer said by its installation, never its name: a retired installation's hello writes nothing, and its words go with it", async () => {
  const f = await owner();
  expect(f.database.prepare("SELECT name FROM pragma_table_info('machine_peer_seen') ORDER BY cid").all().map((row) => String(row.name)))
    .toEqual(["installation_id", "build", "version", "built_at", "seen_at"]);
  await f.call("machine.add", { name: "mini", sshTarget: "mini" });
  await f.pin("mini");
  await f.repo((machines) => machines.notePeerHello({ machineName: "mini", installationId: "mini-install" as InstallationId, build: OLD }));
  expect(await f.repo((machines) => machines.peersSeen)).toEqual([expect.objectContaining({ machineName: "mini", installationId: "mini-install" })]);
  // A hello naming the pinned name under another installation writes nothing.
  await f.repo((machines) => machines.notePeerHello({ machineName: "mini", installationId: "rebuilt-install" as InstallationId, build: NEWER }));
  expect(await f.repo((machines) => machines.peersSeen)).toEqual([expect.objectContaining({ installationId: "mini-install", build: OLD })]);
  // Retired: the old words go, and the retired installation's hello writes nothing.
  await f.repo((machines) => machines.retirePeer("mini"));
  expect(await f.repo((machines) => machines.peersSeen)).toEqual([]);
  await f.repo((machines) => machines.notePeerHello({ machineName: "mini", installationId: "mini-install" as InstallationId, build: OLD }));
  expect(f.database.prepare("SELECT COUNT(*) AS n FROM machine_peer_seen").get()).toEqual({ n: 0 });
});
