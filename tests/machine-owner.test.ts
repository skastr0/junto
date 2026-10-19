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
import { HostsService, HostsServiceLive } from "../src/main/junto/hosts/service";
import { makeMachineOwnerActions, type MachineOwnerOptions } from "../src/main/junto/hosts/machine-owner";
import { MachineInstallError, MachineSetupError, MachineInstallResult } from "../src/shared/machine-install";
import { RemoteHostsError } from "../src/shared/remote-hosts";
import { SshTransport } from "../src/main/junto/ssh";
import { MachineOwnStatus, type MachinePeerStatus } from "../src/shared/machine-control";
import { OPERATOR_PROTOCOL_VERSION, decodeOperatorRequest, decodeOperatorResponse } from "../src/shared/operator-control";
import { hostsSnapshot, setHostsSnapshot } from "../src/main/junto/hosts/snapshot";

const cleanup: Array<() => Promise<void>> = [];
const readyInstall = () => Schema.decodeUnknownSync(MachineInstallResult)({
  build: "a".repeat(64), juntoHome: "/home/probe", installRoot: "/home/probe/install", directory: "/home/probe/install/builds/build",
  serviceLabel: "test-service", provider: "launchd", updated: false, disposition: "ready", installationId: "mini-install", machineName: "mini", pid: 71, transitions: [{ step: "ready", pid: 71 }],
});
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); resetDefaultHostsRegistryForTests(); setHostsSnapshot([]); });
const fixture = async (overrides: Partial<MachineOwnerOptions> = {}) => {
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
  let failReload = false;
  const hosts = await runtime.runPromise(HostsService);
  const owner = await runtime.runPromise(makeMachineOwnerActions({
    ownStatus: Effect.succeed(Schema.decodeUnknownSync(MachineOwnStatus)({ build: "a".repeat(64), installationId: "own-install", machineName: "macbook", juntoHome: "/home/user/probe", pid: 71, ready: true, form: "mac-mini" as const, keychain: "available" })),
    ownHarnesses: Effect.succeed({ machineName: "macbook", reachable: true, keychain: "available", harnesses: [{ harness: "codex", installed: true, signIn: "sign-in-unverified" }] }),
    peerBuild: () => Effect.succeed(undefined),
    peerStatus: name => Effect.sync(() => { probed.push(name); return { machineName: name, reachable: false, harnesses: [], missingSecrets: [] }; }),
    copy: () => Effect.die("copy not part of this fixture"),
    disconnect: name => Effect.sync(() => { disconnected.push(name); }),
    ownLogs: () => Effect.die("own logs not part of this fixture"),
    peerLogs: () => Effect.die("peer logs not part of this fixture"),
    ...overrides,
  }).pipe(Effect.provideService(HostsService, { ...hosts, list: Effect.suspend(() => failReload
    ? Effect.fail(new RemoteHostsError("io", "test reload failed")) : hosts.list) })));
  const call = (op: string, args: unknown) => {
    const request = decodeOperatorRequest({ protocol: OPERATOR_PROTOCOL_VERSION, id: "test", op, args });
    if (Result.isFailure(request)) throw new Error(request.failure.message);
    return runtime.runPromise(owner.dispatch(request.success));
  };
  return { database, call, disconnected, probed, failReload: () => { failReload = true; } };
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

it("preserves a peer's keychain and detect-only harness facts through owner commands", async () => {
  const f = await fixture({ peerStatus: name => Effect.succeed({
    machineName: name, reachable: true, keychain: "unavailable", missingSecrets: [],
    harnesses: [{ harness: "claude", installed: true, signIn: "keychain-login-unavailable" }],
  }) });
  await f.call("machine.add", { name: "mini", sshTarget: "mac-mini" });
  const unbound = await f.call("machine.harnesses", { name: "mini" });
  expect(unbound.ok && unbound.op === "machine.harnesses" && unbound.data.keychain).toBeUndefined();
  await f.call("machine.setup", { machineName: "mini", installationId: "mini-install" });
  for (const op of ["machine.status", "machine.harnesses"]) {
    const response = await f.call(op, { name: "mini" });
    expect(response).toMatchObject({ ok: true, op, data: {
      keychain: "unavailable", harnesses: [{ harness: "claude", installed: true, signIn: "keychain-login-unavailable" }],
    } });
  }
});

it("refreshes the hydrated routing name after initial configuration", async () => {
  const f = await fixture();
  expect((await f.call("machine.configure", { name: "studio" })).ok).toBe(true);
  expect(hostsSnapshot().find(row => row.isThisMachine)?.id).toBe("studio");
  expect((await f.call("machine.remove", { name: "studio" })).ok).toBe(false);
});

it("disconnects a removed peer even when refreshing the routing snapshot fails", async () => {
  const f = await fixture();
  await f.call("machine.add", { name: "mini", sshTarget: "mac-mini" });
  await f.call("machine.setup", { machineName: "mini", installationId: "mini-install" });
  f.failReload();
  expect((await f.call("machine.remove", { name: "mini" })).ok).toBe(false);
  expect(f.database.prepare("SELECT id FROM host_registry WHERE id='mini'").get()).toBeUndefined();
  expect(f.database.prepare("SELECT retired_at FROM machine_peers WHERE machine_name='mini'").get()?.retired_at).toBeTruthy();
  expect(f.disconnected).toEqual(["mini"]);
});

it("preserves an activated install failure and its transition receipt", async () => {
  const transitions = [{ step: "selected" as const, build: "b".repeat(64) }];
  const f = await fixture({ copy: () => Effect.fail(new MachineInstallError({ message: "service did not become ready", disposition: "activated", retryable: false, transitions })) });
  await f.call("machine.add", { name: "mini", sshTarget: "mac-mini" });
  const response = await f.call("machine.update", { name: "mini", bundle: "/tmp/package" });
  expect(response.ok).toBe(false);
  if (!response.ok) expect(response.error.details).toEqual({ retryable: false, disposition: "activated", transitions,
    failure: { tag: "MachineInstallError", machine: "macbook", message: "service did not become ready", causes: [] } });
  expect(Result.isSuccess(decodeOperatorResponse(response))).toBe(true);
});

it("refuses owner status and extra fields returned by a peer callback", async () => {
  for (const extra of [
    { build: "a".repeat(64), juntoHome: "/home/user/private", pid: 71, ready: true, form: "mac-mini" as const },
    { secretValue: "private" },
  ]) {
    const f = await fixture({ peerStatus: name => Effect.succeed({ machineName: name, installationId: Schema.decodeUnknownSync(MachineOwnStatus)({ build: "a".repeat(64), machineName: name, installationId: "mini-install", juntoHome: "/home/user/private", pid: 71, ready: true, form: "mac-mini" as const, keychain: "available" }).installationId, reachable: true, harnesses: [], missingSecrets: [], ...extra }) });
    await f.call("machine.add", { name: "mini", sshTarget: "mac-mini" });
    await f.call("machine.setup", { machineName: "mini", installationId: "mini-install" });
    const response = await f.call("machine.status", { name: "mini" });
    expect(response.ok).toBe(false);
    expect(JSON.stringify(response)).not.toContain("/home/user/private");
    expect(JSON.stringify(response)).not.toContain("secretValue");
  }
});

it("refuses an exact owner-only status reply on the peer path", async () => {
  const f = await fixture({ peerStatus: name => Effect.succeed(Schema.decodeUnknownSync(MachineOwnStatus)({
    build: "a".repeat(64), machineName: name, installationId: "mini-install", form: "mac-mini" as const,
    juntoHome: "/home/user/private", pid: 71, ready: true, keychain: "available",
  })) as unknown as Effect.Effect<MachinePeerStatus> });
  await f.call("machine.add", { name: "mini", sshTarget: "mac-mini" });
  await f.call("machine.setup", { machineName: "mini", installationId: "mini-install" });
  const response = await f.call("machine.status", { name: "mini" });
  expect(response.ok).toBe(false);
  expect(JSON.stringify(response)).not.toContain("/home/user/private");
});

it("marks only a bound peer with a known different hello build as needing an update", async () => {
  let build: string | undefined = "b".repeat(64);
  const f = await fixture({ peerBuild: () => Effect.succeed(build) });
  await f.call("machine.add", { name: "mini", sshTarget: "mac-mini" });
  const flag = async () => {
    const response = await f.call("machine.list", {});
    if (!response.ok || response.op !== "machine.list") throw new Error("list failed");
    expect(response.data.machines.find(row => row.machine.isThisMachine)?.needsUpdate).toBe(false);
    return response.data.machines.find(row => row.machine.id === "mini")?.needsUpdate;
  };
  expect(await flag()).toBe(false);
  await f.call("machine.setup", { machineName: "mini", installationId: "mini-install" });
  expect(await flag()).toBe(true);
  build = "a".repeat(64);
  expect(await flag()).toBe(false);
  build = undefined;
  expect(await flag()).toBe(false);
  build = "invalid-peer-build";
  expect((await f.call("machine.list", {})).ok).toBe(false);
});

it("returns the installed receipt when setup failed after a successful copy", async () => {
  const installed = readyInstall();
  const f = await fixture({ copy: () => Effect.fail(new MachineSetupError({ message: "Junto is installed, but the name is bound to another installation; choose another name", retryable: false, installed })) });
  await f.call("machine.add", { name: "mini", sshTarget: "mac-mini" });
  const response = await f.call("machine.send", { name: "mini" });
  expect(response.ok).toBe(false);
  if (!response.ok) expect(response.error.details).toEqual({ retryable: false, installed, failure: expect.objectContaining({ tag: "MachineSetupError", machine: "macbook" }) });
  expect(Result.isSuccess(decodeOperatorResponse(response))).toBe(true);
});

it("holds removal until an in-flight copy completes so setup cannot revive a removed route", async () => {
  let announce!: () => void;
  let finish!: (receipt: MachineInstallResult) => void;
  const started = new Promise<void>(resolve => { announce = resolve; });
  const copying = new Promise<MachineInstallResult>(resolve => { finish = resolve; });
  const f = await fixture({ copy: () => Effect.promise(() => { announce(); return copying; }) });
  await f.call("machine.add", { name: "mini", sshTarget: "mac-mini" });
  await f.call("machine.setup", { machineName: "mini", installationId: "mini-install" });
  const sent = f.call("machine.update", { name: "mini" });
  await started;
  const removed = f.call("machine.remove", { name: "mini" });
  await Promise.resolve();
  expect(f.database.prepare("SELECT retired_at FROM machine_peers WHERE machine_name='mini'").get()?.retired_at).toBeNull();
  expect(f.disconnected).toEqual([]);
  finish(readyInstall());
  expect((await sent).ok).toBe(true);
  expect((await removed).ok).toBe(true);
  expect(f.disconnected).toEqual(["mini"]);
});

it("reads this machine's log whole and a linked machine's through that machine", async () => {
  const reads: Array<{ readonly machine: string; readonly query: unknown }> = [];
  const read = (machine: string) => ({ machine, rows: [], cut: false, unreadable: 0 });
  const f = await fixture({
    ownLogs: query => Effect.sync(() => { reads.push({ machine: "macbook", query }); return read("macbook"); }),
    peerLogs: (name, query) => Effect.sync(() => { reads.push({ machine: name, query }); return read(name); }),
  });
  expect(await f.call("machine.logs", { name: "macbook", query: { level: "error" } }))
    .toMatchObject({ ok: true, op: "machine.logs", data: { machine: "macbook" } });
  await f.call("machine.add", { name: "mini", sshTarget: "mac-mini" });
  expect(await f.call("machine.logs", { name: "mini", query: { area: "seats", limit: 1 } }))
    .toMatchObject({ ok: true, op: "machine.logs", data: { machine: "mini" } });
  expect(reads).toEqual([
    { machine: "macbook", query: { level: "error" } },
    { machine: "mini", query: { area: "seats", limit: 1 } },
  ]);
  expect(await f.call("machine.logs", { name: "ghost", query: {} })).toMatchObject({ ok: false, error: { type: "not_found" } });
});

it("starts and stops a seat by canvas and seat id, scrubbing the exit message", async () => {
  const seen: unknown[] = [];
  const f = await fixture({
    seatStart: input => Effect.sync(() => {
      seen.push(input);
      return { bindingId: "b1", epoch: "e1", hostId: "macbook", status: "exited" as const, detached: false, createdAt: 1,
        exitReason: "cli-missing" as const, exitMessage: "codex is not installed; token=sk-live-0123456789abcdef0123" };
    }),
    seatStop: input => Effect.sync(() => { seen.push(input); return { outcome: "vacant" as const }; }),
  });
  const started = await f.call("machine.seat-start", { canvas: "default", seatId: "seat-1" });
  expect(started).toMatchObject({ ok: true, op: "machine.seat-start", data: { canvas: "default", seatId: "seat-1", status: "exited", exitReason: "cli-missing" } });
  expect(started.ok && started.op === "machine.seat-start" && started.data.exitMessage).not.toContain("sk-live");
  expect(await f.call("machine.seat-stop", { canvas: "default", seatId: "seat-1" }))
    .toMatchObject({ ok: true, op: "machine.seat-stop", data: { outcome: "vacant" } });
  expect(seen).toEqual([{ canvas: "default", seatId: "seat-1" }, { canvas: "default", seatId: "seat-1" }]);
});

it("reads a seat's terminal by canvas and seat id, and refuses where seats cannot be read", async () => {
  const seen: unknown[] = [];
  const f = await fixture({ seatRead: input => Effect.sync(() => {
    seen.push(input);
    return { hostId: "mini", vacant: false, generation: "g1", text: "$ ready", lines: 1, cols: 80, rows: 24, truncated: false };
  }) });
  expect(await f.call("machine.seat-read", { canvas: "default", seatId: "seat-1", lines: 5 })).toMatchObject({
    ok: true, op: "machine.seat-read", data: { canvas: "default", seatId: "seat-1", hostId: "mini", text: "$ ready", lines: 1 },
  });
  expect(seen).toEqual([{ canvas: "default", seatId: "seat-1", lines: 5 }]);
  // The owner contract refuses a read outside 1..2000 lines before it is sent.
  await expect((async () => f.call("machine.seat-read", { canvas: "default", seatId: "seat-1", lines: 0 }))()).rejects.toThrow(/between 1 and 2000/);
  const unwired = await fixture();
  expect(await unwired.call("machine.seat-read", { canvas: "default", seatId: "seat-1" }))
    .toMatchObject({ ok: false, error: { details: { failure: { tag: "SeatControlUnavailable" } } } });
});

it("never answers a seat's own exit text: no exitReason, no exitMessage", async () => {
  const f = await fixture({ seatStart: () => Effect.succeed({ bindingId: "b1", epoch: "e1", hostId: "macbook", status: "exited" as const,
    detached: false, createdAt: 1, exitMessage: "screen text" }) });
  const started = await f.call("machine.seat-start", { canvas: "default", seatId: "seat-1" });
  expect(started).toMatchObject({ ok: true, data: { status: "exited" } });
  expect(started.ok && started.op === "machine.seat-start" && "exitMessage" in started.data).toBe(false);
});

it("answers a seat start's typed failure with the failure encoded", async () => {
  class SeatNotFound extends Schema.TaggedError<SeatNotFound>()("SeatNotFound", { canvas: Schema.String, seatId: Schema.String, message: Schema.String }) {}
  const f = await fixture({ seatStart: () => Effect.fail(new SeatNotFound({ canvas: "default", seatId: "ghost", message: "No seat ghost on default" })) });
  expect(await f.call("machine.seat-start", { canvas: "default", seatId: "ghost" })).toMatchObject({
    ok: false, error: { type: "io", message: "No seat ghost on default", details: { failure: { tag: "SeatNotFound", machine: "macbook", message: "No seat ghost on default" } } },
  });
  const unwired = await fixture();
  expect(await unwired.call("machine.seat-stop", { canvas: "default", seatId: "seat-1" }))
    .toMatchObject({ ok: false, error: { details: { failure: { tag: "SeatControlUnavailable" } } } });
});

it("answers a peer status failure as itself, not as a contract mismatch", async () => {
  class LinkClosedProbe extends Schema.TaggedError<LinkClosedProbe>()("LinkClosed", { message: Schema.String }) {}
  const f = await fixture({ peerStatus: () => Effect.fail(new LinkClosedProbe({ message: "The link to mini closed, its SSH process ended: exit code 127" })) });
  await f.call("machine.add", { name: "mini", sshTarget: "mac-mini" });
  await f.call("machine.setup", { machineName: "mini", installationId: "mini-install" });
  expect(await f.call("machine.status", { name: "mini" })).toMatchObject({ ok: false, error: {
    message: "The link to mini closed, its SSH process ended: exit code 127", details: { failure: { tag: "LinkClosed" } } } });
});
