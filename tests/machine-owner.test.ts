import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime, Result, Schema } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient } from "effect/sql";
import { afterEach, expect, it, vi } from "vitest";
import { makeSqliteClient } from "../src/core/state/sqlite-client";
import { MODEL_STATE_SCHEMA_SQL } from "../src/core/model/state-schema";
import { MACHINE_STATE_SCHEMA_SQL } from "../src/core/machines/state-schema";
import { MACHINE_VAULT_TOKENS_SQL } from "../src/core/vault/state-schema";
import { makeMachineRepositoryLive } from "../src/core/machines/repository";
import { MACHINE_REGISTRY_STATE_SCHEMA_SQL } from "../src/core/hosts/state-schema";
import { HostRegistryRows, resetDefaultHostsRegistryForTests } from "../src/core/hosts/registry";
import { HostsService, HostsServiceLive } from "../src/core/hosts/service";
import { makeMachineOwnerActions, type MachineOwnerOptions } from "../src/core/hosts/machine-owner";
import { MachineInstallError, MachineSetupError, MachineInstallResult } from "../src/shared/machine-install";
import { RemoteHostsError } from "../src/shared/remote-hosts";
import { SshTransport } from "../src/core/ssh";
import type { MachineUpdateLatch } from "../src/core/install-ops/service";
import { MachineOwnStatus, type MachinePeerStatus } from "../src/shared/machine-control";
import { OPERATOR_PROTOCOL_VERSION, decodeOperatorRequest, decodeOperatorResponse } from "../src/shared/operator-control";
import { hostsSnapshot, setHostsSnapshot } from "../src/core/hosts/snapshot";
import { TERMINAL_DELETE_STATE_SCHEMA_SQL } from "../src/core/term/node-delete-state-schema";
import { makeTestLog } from "./support/test-log";

const testLog = makeTestLog();

const cleanup: Array<() => Promise<void>> = [];
const readyInstall = () => Schema.decodeUnknownSync(MachineInstallResult)({
  build: "a".repeat(64), juntoHome: "/home/probe", installRoot: "/home/probe/install", directory: "/home/probe/install/builds/build",
  serviceLabel: "test-service", provider: "launchd", updated: false, disposition: "ready", installationId: "mini-install", machineName: "mini", pid: 71, transitions: [{ step: "ready", pid: 71 }],
});
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); resetDefaultHostsRegistryForTests(); setHostsSnapshot([]); });
const fixture = async (overrides: Partial<MachineOwnerOptions> = {}, sshRun?: (program: unknown) => Effect.Effect<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>, sshTransfer?: (program: unknown) => Effect.Effect<{ readonly stdout: string; readonly stderr: string }>) => {
  const database = new DatabaseSync(":memory:");
  database.exec(MACHINE_STATE_SCHEMA_SQL + MACHINE_REGISTRY_STATE_SCHEMA_SQL + MODEL_STATE_SCHEMA_SQL + TERMINAL_DELETE_STATE_SCHEMA_SQL + MACHINE_VAULT_TOKENS_SQL);
  database.exec("CREATE TABLE host_registry_state(singleton INTEGER PRIMARY KEY, version INTEGER, initialized_at TEXT) STRICT");
  const sql = Layer.effect(SqlClient.SqlClient, makeSqliteClient(database)).pipe(Layer.provide(Reactivity.layer));
  const machines = makeMachineRepositoryLive({ defaultName: () => "macbook" }).pipe(Layer.provideMerge(sql));
  const ssh = Layer.succeed(SshTransport, SshTransport.of({ run: sshRun ?? (() => Effect.die("no dial")), transfer: sshTransfer ?? (() => Effect.die("no transfer")), connect: () => Effect.die("no link"), forward: () => Effect.die("no forward"), warm: () => Effect.void, teardown: () => Effect.void }));
  const runtime = ManagedRuntime.make(Layer.mergeAll(HostsServiceLive, HostRegistryRows.layer).pipe(Layer.provideMerge(testLog.log.loggerLayer), Layer.provideMerge(machines), Layer.provideMerge(ssh)));
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
  return { database, call, disconnected, probed, failReload: () => { failReload = true; }, start: () => runtime.runPromise(owner.startAutoUpdates?.() ?? Effect.succeed(() => undefined)) };
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
  if (!changed.ok) {
    expect(changed.error.message).toContain("choose another name");
    expect(changed.error.message.match(/choose another name/g)).toHaveLength(1);
  }
});

it("answers setup on a pin a link bound to its key with the pin's contract, and keeps the binding in the store", async () => {
  // remote-verify receipt 8: this machine linked with the editing machine, so
  // its pin of the editor is key-bound (machine-link.ts pins with binding
  // "key"). The editor then removed this machine, added it again and sent to
  // it: the send runs setup here again, which answered a pin carrying its
  // binding and failed its own contract.
  const f = await fixture();
  const first = await f.call("machine.setup", { machineName: "studio", installationId: "studio-install" });
  expect(first.ok).toBe(true);
  f.database.exec("UPDATE machine_peers SET binding = 'key' WHERE machine_name = 'studio'");
  const again = await f.call("machine.setup", { machineName: "studio", installationId: "studio-install" });
  expect(again).toMatchObject({ ok: true, op: "machine.setup" });
  if (again.ok && again.op === "machine.setup") {
    expect(Object.keys(again.data).sort()).toEqual(["boundAt", "installationId", "machineName"]);
    expect(again.data).toMatchObject({ machineName: "studio", installationId: "studio-install" });
  }
  expect(f.database.prepare("SELECT binding, retired_at FROM machine_peers WHERE machine_name = 'studio'").get()).toEqual({ binding: "key", retired_at: null });
});

it("marks a copy refusal as the core's own words only when its message is the core's fixed sentence", async () => {
  // remote-design 356400e7b: a failed-copy row shows a third line only for ownWords.
  const own = new MachineInstallError({ message: "This machine's Junto did not say how many seats it runs, so nothing was changed. Check this machine before updating",
    disposition: "staged", retryable: true, runningSeatsUnknown: true, ownWords: true });
  const raw = new MachineInstallError({ message: "tar: /home/probe/x: Cannot open: Permission denied", disposition: "staged", retryable: false });
  for (const [cause, marked] of [[own, true], [raw, false]] as const) {
    const f = await fixture({ copy: () => Effect.fail(cause) });
    await f.call("machine.add", { name: "mini", sshTarget: "mac-mini" });
    const response = await f.call("machine.update", { name: "mini", bundle: "/tmp/package" });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.message).not.toBe("machine result did not match its contract");
      expect(response.error.details?.ownWords).toBe(marked ? true : undefined);
      expect(Object.hasOwn(response.error.details ?? {}, "ownWords")).toBe(marked);
    }
  }
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

it("passes the operator's stop-confirm through to the installer", async () => {
  let received: { readonly name: string; readonly stopRunningSeats?: boolean } | undefined;
  const f = await fixture({ copy: (_host, input) => Effect.sync(() => { received = input; return readyInstall(); }) });
  await f.call("machine.add", { name: "mini", sshTarget: "mac-mini" });
  await f.call("machine.setup", { machineName: "mini", installationId: "mini-install" });
  expect((await f.call("machine.update", { name: "mini", stopRunningSeats: true })).ok).toBe(true);
  expect(received).toMatchObject({ name: "mini", stopRunningSeats: true });
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

it("passes a failure's message through the scrub before it leaves the owner", async () => {
  const leaked = "ops_test-only-leaked-in-a-cause-AbC+/=0123456789";
  const f = await fixture({ ownLogs: () => Effect.fail(new RemoteHostsError("io", `the log read failed near ${leaked}`)) });
  const response = await f.call("machine.logs", { name: "macbook", query: { level: "error" } });
  expect(response).toMatchObject({ ok: false, error: { type: "io" } });
  expect(JSON.stringify(response)).not.toContain("ops_test-only");
  expect(JSON.stringify(response)).toContain("the log read failed near");
});

const latchStore = () => {
  const latches = new Map<string, MachineUpdateLatch>();
  return {
    latches,
    installOps: {
      updateLatch: (installationId: string) => Effect.sync(() => latches.get(installationId)),
      recordUpdateLatch: (latch: MachineUpdateLatch) => Effect.sync(() => { latches.set(latch.installationId, latch); }),
    },
  };
};

it("updates an idle pinned peer with no click and records the attempt", async () => {
  let copies = 0;
  let dials = 0;
  const store = latchStore();
  const peerStatus = {
    build: "b".repeat(64), version: "0.10.0", builtAt: "2026-01-01T00:00:00.000Z",
    form: "mac-mini" as const, keychain: "available" as const, installationId: "mini-install", machineName: "mini",
    juntoHome: "/home/probe", pid: 72, ready: true, runningSeats: 0,
  };
  const f = await fixture({
    autoUpdate: { downloadsBundles: false, signedRelease: false },
    ownStatus: Effect.succeed(Schema.decodeUnknownSync(MachineOwnStatus)({ build: "a".repeat(64), version: "0.11.0", builtAt: "2026-02-01T00:00:00.000Z", installationId: "own-install", machineName: "macbook", juntoHome: "/home/user/probe", pid: 71, ready: true, form: "mac-mini", keychain: "available" })),
    peerBuild: () => Effect.succeed("b".repeat(64)),
    installOps: store.installOps,
    copy: () => Effect.sync(() => { copies += 1; return readyInstall(); }),
  }, () => Effect.sync(() => { dials += 1; return { stdout: JSON.stringify({ ok: true, command: "machine status", data: peerStatus }), stderr: "", exitCode: 0 }; }));
  await f.call("machine.add", { name: "mini", sshTarget: "mac-mini", juntoHome: "/home/probe", installRoot: "/home/probe/install" });
  await f.call("machine.setup", { machineName: "mini", installationId: "mini-install" });
  const stop = await f.start();
  await vi.waitFor(() => expect(copies).toBe(1));
  stop();
  const listed = await f.call("machine.list", {});
  expect(listed.ok && listed.op === "machine.list" && listed.data.machines.find(row => row.machine.id === "mini")?.autoUpdate).toMatchObject({ state: "updated", targetBuild: "a".repeat(64) });
  expect(store.latches.get("mini-install")).toMatchObject({ targetBuild: "a".repeat(64), outcome: "activated" });
});

it("pushes an installed but not reconnected peer once across three passes", async () => {
  let copies = 0;
  let dials = 0;
  const store = latchStore();
  const peerStatus = {
    build: "b".repeat(64), version: "0.10.0", builtAt: "2026-01-01T00:00:00.000Z",
    form: "mac-mini" as const, keychain: "available" as const, installationId: "mini-install", machineName: "mini",
    juntoHome: "/home/probe", pid: 72, ready: true, runningSeats: 0,
  };
  const f = await fixture({
    autoUpdate: { downloadsBundles: false, signedRelease: false },
    ownStatus: Effect.succeed(Schema.decodeUnknownSync(MachineOwnStatus)({ build: "a".repeat(64), version: "0.11.0", builtAt: "2026-02-01T00:00:00.000Z", installationId: "own-install", machineName: "macbook", juntoHome: "/home/user/probe", pid: 71, ready: true, form: "mac-mini", keychain: "available" })),
    peerBuild: () => Effect.succeed("b".repeat(64)),
    installOps: store.installOps,
    copy: () => Effect.sync(() => { copies += 1; return readyInstall(); }),
  }, () => Effect.sync(() => { dials += 1; return { stdout: JSON.stringify({ ok: true, command: "machine status", data: peerStatus }), stderr: "", exitCode: 0 }; }));
  await f.call("machine.add", { name: "mini", sshTarget: "mac-mini", juntoHome: "/home/probe", installRoot: "/home/probe/install" });
  await f.call("machine.setup", { machineName: "mini", installationId: "mini-install" });

  for (let pass = 1; pass <= 3; pass += 1) {
    const stop = await f.start();
    await vi.waitFor(() => expect(dials).toBe(pass));
    stop();
  }
  expect(copies).toBe(1);
  expect(store.latches.get("mini-install")).toMatchObject({ installationId: "mini-install", targetBuild: "a".repeat(64) });
});

it("takes over a pin by installation id, sweeps its old debt, and closes its link", async () => {
  const forgotten: Array<{ readonly name: string; readonly installationId: string }> = [];
  const f = await fixture({
    ownStatus: Effect.succeed(Schema.decodeUnknownSync(MachineOwnStatus)({
      build: "a".repeat(64), installationId: "own-install", machineName: "macbook", juntoHome: "/home/user/probe",
      pid: 71, ready: true, form: "mac-mini", keychain: "available", runningSeats: 2,
    })),
    takeoverAutomations: () => Effect.succeed(3),
    takeoverForget: (name, installationId) => Effect.sync(() => { forgotten.push({ name, installationId }); }),
  });
  await f.call("machine.add", { name: "mini", sshTarget: "mac-mini" });
  await f.call("machine.setup", { machineName: "mini", installationId: "mini-install" });
  f.database.exec("INSERT INTO terminal_delete_owed(lease_id, binding_id, machine_name, canvas_name, seat_id, reason, created_at) VALUES ('lease', 'binding', 'mini', 'canvas', 'seat', 'unreachable', 1)");
  f.database.exec("INSERT INTO machine_vault_tokens(machine_name, vault, permissions, origin, account_name, set_at_epoch_ms) VALUES ('mini', 'vault', 'read_items', 'pasted', NULL, 1)");

  const preview = await f.call("machine.takeover", { machineName: "mini", installationId: "new-install", expectedInstallationId: "mini-install" });
  expect(preview).toMatchObject({ ok: true, op: "machine.takeover", data: { seats: 0, automations: 0, takenOver: false } });
  expect(f.database.prepare("SELECT installation_id FROM machine_peers WHERE machine_name = 'mini'").get()).toEqual({ installation_id: "mini-install" });

  const taken = await f.call("machine.takeover", { machineName: "mini", installationId: "new-install", expectedInstallationId: "mini-install", confirm: { seats: 2, automations: 3 } });
  expect(taken).toMatchObject({ ok: true, op: "machine.takeover", data: { takenOver: true, previousInstallationId: "mini-install", installationId: "new-install" } });
  expect(f.database.prepare("SELECT installation_id FROM machine_peers WHERE machine_name = 'mini'").get()).toEqual({ installation_id: "new-install" });
  expect(f.database.prepare("SELECT count(*) AS count FROM terminal_delete_owed WHERE machine_name = 'mini'").get()).toEqual({ count: 0 });
  expect(f.database.prepare("SELECT count(*) AS count FROM machine_vault_tokens WHERE machine_name = 'mini'").get()).toEqual({ count: 0 });
  expect(forgotten).toEqual([{ name: "mini", installationId: "mini-install" }]);
  expect(f.disconnected).toEqual(["mini"]);
  expect(await f.call("machine.setup", { machineName: "mini", installationId: "new-install" })).toMatchObject({ ok: true, op: "machine.setup" });
});

it("refuses a take-over before the commit when the old key cannot be removed", async () => {
  const f = await fixture({
    ownStatus: Effect.succeed(Schema.decodeUnknownSync(MachineOwnStatus)({ build: "a".repeat(64), installationId: "own-install", machineName: "macbook", juntoHome: "/home/user/probe", pid: 71, ready: true, form: "mac-mini", keychain: "available", runningSeats: 0 })),
    takeoverAutomations: () => Effect.succeed(0),
    takeoverForget: () => Effect.fail(new Error("could not rewrite authorized_keys")),
  });
  await f.call("machine.add", { name: "mini", sshTarget: "mac-mini" });
  await f.call("machine.setup", { machineName: "mini", installationId: "mini-install" });
  f.database.exec("INSERT INTO terminal_delete_owed(lease_id, binding_id, machine_name, canvas_name, seat_id, reason, created_at) VALUES ('lease', 'binding', 'mini', 'canvas', 'seat', 'unreachable', 1)");
  const response = await f.call("machine.takeover", { machineName: "mini", installationId: "new-install", expectedInstallationId: "mini-install", confirm: { seats: 0, automations: 0 } });
  expect(response).toMatchObject({ ok: false, error: { type: "io" } });
  expect(f.database.prepare("SELECT installation_id FROM machine_peers WHERE machine_name = 'mini'").get()).toEqual({ installation_id: "mini-install" });
  expect(f.database.prepare("SELECT count(*) AS count FROM terminal_delete_owed").get()).toEqual({ count: 1 });
});

it("previews and confirms a remote take-over through the far owner command", async () => {
  const far = {
    machineName: "mini", installationId: "old-mini", previousInstallationId: "old-mini",
    seats: 0, automations: 0, takenOver: false,
  };
  const f = await fixture({
    ownStatus: Effect.succeed(Schema.decodeUnknownSync(MachineOwnStatus)({ build: "a".repeat(64), installationId: "own-install", machineName: "macbook", juntoHome: "/home/user/probe", pid: 71, ready: true, form: "mac-mini", keychain: "available", runningSeats: 4 })),
    takeoverAutomations: () => Effect.succeed(5),
  }, undefined, () => Effect.succeed({ stdout: JSON.stringify({ ok: true, command: "machine takeover", data: far }), stderr: "" }));
  await f.call("machine.add", { name: "mini", sshTarget: "mac-mini", juntoHome: "/home/probe", installRoot: "/home/probe/install" });
  await f.call("machine.setup", { machineName: "mini", installationId: "mini-install" });
  const preview = await f.call("machine.takeover-remote", { name: "mini" });
  expect(preview).toMatchObject({ ok: true, op: "machine.takeover-remote", data: { seats: 4, automations: 5, takenOver: false } });
  const refused = await f.call("machine.takeover-remote", { name: "mini", expectedInstallationId: "mini-install", confirm: { seats: 0, automations: 0 } });
  expect(refused).toMatchObject({ ok: false, error: { type: "conflict" } });
  const confirmed = await f.call("machine.takeover-remote", { name: "mini", expectedInstallationId: "mini-install", confirm: { seats: 4, automations: 5 } });
  expect(confirmed).toMatchObject({ ok: true, op: "machine.takeover-remote" });
});
