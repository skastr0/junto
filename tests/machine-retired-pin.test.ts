/**
 * A name this machine removed binds nothing (remote-lead, receipt 28; remote-
 * security P1 to P6): remove a machine, reinstall Junto there and add it back,
 * and the first send pins the new installation in place of the retired row,
 * with the old link-key line removed first and what the old installation
 * held here swept. A live pin under another installation still refuses, and
 * so does a retired name that work here is still placed on.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Result, Schema, Stream } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, it } from "vitest";
import { makeSqliteClient } from "../src/core/state/sqlite-client";
import { MACHINE_STATE_SCHEMA_SQL } from "../src/core/machines/state-schema";
import { MACHINE_VAULT_TOKENS_SQL } from "../src/core/vault/state-schema";
import { TERMINAL_DELETE_STATE_SCHEMA_SQL } from "../src/core/term/node-delete-state-schema";
import { MachineRepository, makeMachineRepositoryLive, RETIRED_PLACED_MESSAGE, type RetiredPinRule } from "../src/core/machines/repository";
import { coreControlSocketPath } from "../src/core/link/listener";
import { machineLinkLayer } from "../src/core/link/live";
import { MachineLink } from "../src/core/link/service";
import { LinkClosed } from "../src/core/link/types";
import { SshTransport, type SshLease, type SshTransportShape } from "../src/core/ssh/service";
import { makeStateEngineLive } from "../src/core/state/engine";
import { HostsServiceLive } from "../src/core/hosts/service";
import { HostRegistryRows, resetDefaultHostsRegistryForTests } from "../src/core/hosts/registry";
import { makeMachineOwnerActions } from "../src/core/hosts/machine-owner";
import { MachineOwnStatus, type MachinePeerStatus } from "../src/shared/machine-control";
import { OPERATOR_PROTOCOL_VERSION, decodeOperatorRequest } from "../src/shared/operator-control";
import { InstallationId } from "../src/shared/installation-id";
import { RemoteHost } from "../src/shared/remote-hosts";
import { allChannels } from "./support/link-channels";
import { noBoatRoutesLayer } from "./support/no-boat";
import { makeTestLog } from "./support/test-log";

const id = Schema.decodeUnknownSync(InstallationId);
const OLD = id("mini-old-install");
const NEW = id("mini-new-install");
const NONE = { seats: 0, automations: 0, files: 0 };

const cleanups: Array<() => Promise<void>> = [];
const testLog = makeTestLog();
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); resetDefaultHostsRegistryForTests(); });

/** This machine, macbook, with mini pinned under OLD and then removed, and what OLD left here. */
const fixture = async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(MACHINE_STATE_SCHEMA_SQL + MACHINE_VAULT_TOKENS_SQL + TERMINAL_DELETE_STATE_SCHEMA_SQL);
  const sql = Layer.effect(SqlClient.SqlClient, makeSqliteClient(database)).pipe(Layer.provide(Reactivity.layer));
  const runtime = ManagedRuntime.make(makeMachineRepositoryLive({
    makeInstallationId: () => id("macbook-install"), defaultName: () => "macbook", now: () => "2026-11-25T20:00:00.000Z",
  }).pipe(Layer.provideMerge(sql)));
  cleanups.push(async () => { await runtime.dispose(); database.close(); });
  const machines = await runtime.runPromise(MachineRepository);
  await runtime.runPromise(machines.pinPeer({ machineName: "mini", installationId: OLD }));
  await runtime.runPromise(machines.pinPeer({ machineName: "studio", installationId: id("studio-install") }));
  database.exec(`INSERT INTO machine_peer_seen(installation_id, build, version, built_at, seen_at) VALUES ('${OLD}', '${"a".repeat(64)}', NULL, NULL, 'then')`);
  for (const name of ["mini", "studio"]) {
    database.exec(`INSERT INTO machine_vault_tokens(machine_name, vault, permissions, origin, account_name, set_at_epoch_ms) VALUES ('${name}', 'ops', 'read_items', 'pasted', NULL, 1)`);
    database.exec(`INSERT INTO terminal_delete_owed(lease_id, binding_id, machine_name, canvas_name, seat_id, reason, created_at) VALUES ('lease', 'binding', '${name}', 'factory', 'seat', 'unreachable', 1)`);
  }
  await runtime.runPromise(machines.retirePeer("mini"));
  const forgotten: Array<readonly [string, string]> = [];
  const rule = (input: { readonly placed?: typeof NONE; readonly forgetFails?: boolean } = {}): RetiredPinRule => ({
    forget: (name, installationId) => Effect.suspend(() => {
      forgotten.push([name, installationId]);
      return input.forgetFails === true ? Effect.fail(new Error("authorized_keys is read-only")) : Effect.void;
    }),
    placements: () => Effect.succeed(input.placed ?? NONE),
  });
  const rows = () => ({
    peers: database.prepare("SELECT machine_name, installation_id, retired_at, binding FROM machine_peers ORDER BY machine_name").all(),
    tokens: database.prepare("SELECT machine_name FROM machine_vault_tokens ORDER BY machine_name").all().map((row) => row.machine_name),
    owed: database.prepare("SELECT machine_name FROM terminal_delete_owed ORDER BY machine_name").all().map((row) => row.machine_name),
    seen: database.prepare("SELECT installation_id FROM machine_peer_seen").all().map((row) => row.installation_id),
    known: database.prepare("SELECT installation_id FROM known_installations ORDER BY installation_id").all().map((row) => row.installation_id),
  });
  const pin = (installationId: InstallationId, retired?: RetiredPinRule, machineName = "mini") =>
    runtime.runPromise(machines.pinPeer({ machineName, installationId }, retired === undefined ? undefined : { retired }));
  const refused = (installationId: InstallationId, retired?: RetiredPinRule, machineName = "mini") =>
    runtime.runPromise(Effect.flip(machines.pinPeer({ machineName, installationId }, retired === undefined ? undefined : { retired })))
      .then((error) => error.cause as { readonly check: string; readonly message: string });
  return { database, runtime, machines, forgotten, rule, rows, pin, refused };
};

describe("a retired pin under another installation", () => {
  it("is replaced by the new installation, its old line removed first and what it held here swept", async () => {
    const f = await fixture();
    const before = f.rows();
    expect(before.peers[0]).toMatchObject({ machine_name: "mini", installation_id: OLD, retired_at: "2026-11-25T20:00:00.000Z" });
    const pinned = await f.pin(NEW, f.rule());
    expect(pinned).toEqual({ machineName: "mini", installationId: NEW, boundAt: "2026-11-25T20:00:00.000Z" });
    expect(f.forgotten).toEqual([["mini", OLD]]);
    const after = f.rows();
    // One row for the name, a plain live pin of the new installation.
    expect(after.peers).toEqual([
      { machine_name: "mini", installation_id: NEW, retired_at: null, binding: null },
      { machine_name: "studio", installation_id: "studio-install", retired_at: null, binding: null },
    ]);
    // What the old installation held goes; another machine's rows stay, and known_installations keeps both.
    expect(after.tokens).toEqual(["studio"]);
    expect(after.owed).toEqual(["studio"]);
    expect(after.seen).toEqual([]);
    expect(after.known).toEqual(expect.arrayContaining([OLD, NEW]));
    expect(await f.runtime.runPromise(f.machines.peer("mini"))).toMatchObject({ installationId: NEW });
    expect(await f.runtime.runPromise(f.machines.retiredPeers)).toEqual([]);
  });

  for (const placed of [{ seats: 1, automations: 0, files: 0 }, { seats: 0, automations: 2, files: 0 }, { seats: 0, automations: 0, files: 1 }]) {
    it(`refuses, changing nothing and keeping the old line, while work here is placed on the name (${JSON.stringify(placed)})`, async () => {
      const f = await fixture();
      const before = f.rows();
      const error = await f.refused(NEW, f.rule({ placed }));
      expect(error).toMatchObject({ check: "name-retired-placed", message: RETIRED_PLACED_MESSAGE("mini") });
      expect(f.forgotten).toEqual([]);
      expect(f.rows()).toEqual(before);
    });
  }

  it("refuses, with the row intact, when the old line cannot be removed", async () => {
    const f = await fixture();
    const before = f.rows();
    const error = await f.refused(NEW, f.rule({ forgetFails: true }));
    expect(error.check).toBe("retired-line-kept");
    expect(f.forgotten).toEqual([["mini", OLD]]);
    expect(f.rows()).toEqual(before);
  });

  it("refuses as before when the caller brings no rule", async () => {
    const f = await fixture();
    const before = f.rows();
    expect((await f.refused(NEW)).check).toBe("name-pinned-elsewhere");
    expect(f.rows()).toEqual(before);
  });

  it("refuses a new installation already pinned under another name, as before", async () => {
    const f = await fixture();
    const before = f.rows();
    expect((await f.refused(id("studio-install"), f.rule())).check).toBe("installation-pinned-elsewhere");
    expect(f.rows()).toEqual(before);
  });

  it("revives the same installation as before, with nothing swept", async () => {
    const f = await fixture();
    expect(await f.pin(OLD, f.rule())).toMatchObject({ machineName: "mini", installationId: OLD });
    expect(f.forgotten).toEqual([]);
    expect(f.rows().tokens).toEqual(["mini", "studio"]);
  });

  it("is replaced only while it is still retired under that installation", async () => {
    const f = await fixture();
    const before = f.rows();
    expect(await f.runtime.runPromise(f.machines.replaceRetiredPin({ machineName: "mini", previous: id("someone-else"), installationId: NEW }))).toBeUndefined();
    expect(await f.runtime.runPromise(f.machines.replaceRetiredPin({ machineName: "studio", previous: id("studio-install"), installationId: NEW }))).toBeUndefined();
    expect(f.rows()).toEqual(before);
  });
});

describe("a live pin under another installation", () => {
  it("always refuses, rule or not, and its line is never touched", async () => {
    const f = await fixture();
    const before = f.rows();
    expect((await f.refused(NEW, f.rule(), "studio")).check).toBe("name-pinned-elsewhere");
    expect(f.forgotten).toEqual([]);
    expect(f.rows()).toEqual(before);
  });
});

/** An SSH double whose dial reaches the peer's owner socket, as `junto link` relays it. */
const relayTo = (peerHome: () => string, status?: string): SshTransportShape => SshTransport.of({
  run: () => status === undefined ? Effect.die("no one-shot commands in this test") : Effect.succeed({ stdout: status, stderr: "", exitCode: 0 }),
  transfer: () => Effect.die("no transfers in this test"),
  forward: () => Effect.die("no forwards in this test"),
  warm: () => Effect.void,
  teardown: () => Effect.void,
  connect: ((_program: unknown, awaitReady: (lease: SshLease, confirm: <A>(value: A) => never) => Effect.Effect<{ value: unknown }>) => Effect.gen(function* () {
    const socket = yield* Effect.callback<Socket>((resume) => {
      const opened = createConnection(coreControlSocketPath(peerHome()));
      opened.once("connect", () => resume(Effect.succeed(opened)));
      opened.once("error", (cause) => resume(Effect.die(cause)));
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => socket.destroy()));
    const lease: SshLease = {
      write: (bytes) => Effect.callback<void>((resume) => { socket.write(bytes, () => resume(Effect.void)); }),
      writeSensitive: () => Effect.die("no secrets in this test"),
      closeInput: Effect.sync(() => { socket.end(); }),
      stdout: Stream.fromAsyncIterable(socket as AsyncIterable<Uint8Array>, (cause) => cause as never),
      stderr: Stream.empty,
      exitCode: Effect.never,
      close: Effect.sync(() => { socket.destroy(); }),
    };
    return (yield* awaitReady(lease, (<A>(value: A) => ({ value })) as never)).value;
  })) as unknown as SshTransportShape["connect"],
});

describe("a first send to a reinstalled machine", () => {
  /** macbook, which pinned mini under OLD and removed it; mini, a fresh install that trusts macbook. */
  const machines = async (placed = NONE) => {
    let miniHome = "";
    const machine = async (name: string, installationId?: InstallationId, owned = false) => {
      const home = await mkdtemp(`/tmp/junto-retired-pin-${name}-`);
      const status = name === "macbook" ? JSON.stringify({ ok: true, command: "machine status", data: {
        build: "c".repeat(64), installationId: NEW, machineName: "mini", juntoHome: "/home/mini/junto", pid: 72, ready: true, form: "mac-mini" } }) : undefined;
      const runtime = ManagedRuntime.make(Layer.provideMerge(machineLinkLayer("c".repeat(64), home), Layer.mergeAll(
        noBoatRoutesLayer,
        Layer.provide(makeMachineRepositoryLive({ defaultName: () => name, ...(installationId === undefined ? {} : { makeInstallationId: () => installationId }) }), makeStateEngineLive(join(home, "junto.db"))),
        Layer.succeed(SshTransport, relayTo(() => miniHome, status)),
        ...(owned ? [HostRegistryRows.layer, HostsServiceLive, testLog.log.loggerLayer] : []),
      )));
      cleanups.push(async () => { await runtime.dispose(); await rm(home, { recursive: true, force: true }); });
      const self = await runtime.runPromise(Effect.flatMap(MachineRepository, (repository) => repository.installationId));
      await runtime.runPromise(Effect.gen(function* () {
        const link = yield* MachineLink;
        yield* link.setChannels(allChannels());
        yield* link.listen(home);
      }));
      return { name, home, runtime, self };
    };
    const macbook = await machine("macbook", undefined, true);
    const mini = await machine("mini", NEW);
    miniHome = mini.home;
    await macbook.runtime.runPromise(Effect.gen(function* () {
      const repository = yield* MachineRepository;
      yield* repository.pinPeer({ machineName: "mini", installationId: OLD });
      yield* repository.retirePeer("mini");
    }));
    // The far's setup pinned macbook during its install.
    await mini.runtime.runPromise(Effect.flatMap(MachineRepository, (repository) => repository.pinPeer({ machineName: "macbook", installationId: macbook.self })));
    const host = Schema.decodeUnknownSync(RemoteHost)({ id: "mini", label: "mini", isThisMachine: false, sshEndpoint: "mac-mini", capabilities: ["terminal"],
      juntoHome: "/home/mini/junto", installRoot: "/home/mini/.local/junto" });
    const forgotten: Array<readonly [string, string]> = [];
    const owner = await macbook.runtime.runPromise(makeMachineOwnerActions({
      ownStatus: Effect.succeed(Schema.decodeUnknownSync(MachineOwnStatus)({ build: "c".repeat(64), installationId: macbook.self, machineName: "macbook", juntoHome: macbook.home, pid: 71, ready: true, form: "mac-mini" })),
      ownHarnesses: Effect.succeed({ machineName: "macbook", reachable: true, keychain: "available", harnesses: [] }),
      peerStatus: (name: string) => Effect.succeed({ machineName: name, reachable: false, harnesses: [], missingSecrets: [] } satisfies MachinePeerStatus),
      peerBuild: () => Effect.succeed(undefined),
      ownLogs: () => Effect.die("own logs not part of this test"),
      peerLogs: () => Effect.die("peer logs not part of this test"),
      copy: () => Effect.die("copy not part of this test"),
      disconnect: () => Effect.void,
      takeoverCounts: () => Effect.succeed(placed),
      takeoverForget: (name, previous) => Effect.sync(() => { forgotten.push([name, previous]); }),
      now: () => new Date("2026-11-25T20:00:00.000Z"),
    }));
    const call = (op: string, args: unknown) => {
      const request = decodeOperatorRequest({ protocol: OPERATOR_PROTOCOL_VERSION, id: "test", op, args });
      if (Result.isFailure(request)) throw new Error(request.failure.message);
      return macbook.runtime.runPromise(owner.dispatch(request.success));
    };
    const send = (placed = NONE) => macbook.runtime.runPromise(Effect.flatMap(MachineLink, (link) => link.connectSetup(host, NEW, {
      forget: (name, previous) => Effect.sync(() => { forgotten.push([name, previous]); }),
      placements: () => Effect.succeed(placed),
    })));
    const pinOfMini = () => macbook.runtime.runPromise(Effect.flatMap(MachineRepository, (repository) => repository.peer("mini")));
    return { macbook, mini, send, forgotten, pinOfMini, call };
  };

  it("closes the whole way: remove, reinstall, add, send refused, take over, send ready", async () => {
    const placed = { seats: 1, automations: 0, files: 0 };
    const { call, send, forgotten, pinOfMini } = await machines(placed);
    expect(await call("machine.add", { name: "mini", sshTarget: "mac-mini",
      juntoHome: "/home/mini/junto", installRoot: "/home/mini/.local/junto" })).toMatchObject({ ok: true, op: "machine.add" });

    const refused = await send(placed).then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(LinkClosed);
    expect((refused as LinkClosed).causes).toEqual(expect.arrayContaining([
      expect.objectContaining({ tag: "MachineRefused", message: RETIRED_PLACED_MESSAGE("mini") })]));
    expect(await pinOfMini()).toBeUndefined();

    const preview = await call("machine.takeover", { machineName: "mini", installationId: NEW });
    expect(preview).toMatchObject({ ok: true, op: "machine.takeover", data: {
      previousInstallationId: OLD, previousRetiredAt: expect.any(String), seats: 1, automations: 0, files: 0, takenOver: false } });
    const confirmed = await call("machine.takeover", { machineName: "mini", installationId: NEW,
      expectedInstallationId: OLD, confirm: placed });
    expect(confirmed).toMatchObject({ ok: true, op: "machine.takeover", data: { takenOver: true } });
    expect(await pinOfMini()).toMatchObject({ machineName: "mini", installationId: NEW });
    expect(forgotten).toEqual([["mini", OLD]]);

    const ready = await send(NONE);
    expect(ready).toMatchObject({ machineName: "mini", installationId: NEW });
    expect(await pinOfMini()).toMatchObject({ installationId: NEW });
  });

  it("pins the new installation at the checked hello, in place of the retired row", async () => {
    const { send, forgotten, pinOfMini } = await machines();
    expect(await send()).toMatchObject({ machineName: "mini", installationId: NEW });
    expect(forgotten).toEqual([["mini", OLD]]);
    expect(await pinOfMini()).toMatchObject({ installationId: NEW });
  });

  it("closes the link at this end with the placed-work refusal, and keeps the retired row", async () => {
    const { macbook, send, forgotten, pinOfMini } = await machines();
    const closed = await send({ seats: 1, automations: 0, files: 0 }).then(() => undefined, (error: unknown) => error);
    expect(closed).toBeInstanceOf(LinkClosed);
    expect(closed).toMatchObject({ by: "this-end" });
    expect((closed as LinkClosed).causes).toEqual(expect.arrayContaining([expect.objectContaining({ tag: "MachineRefused", message: RETIRED_PLACED_MESSAGE("mini") })]));
    expect(forgotten).toEqual([]);
    expect(await pinOfMini()).toBeUndefined();
    expect(await macbook.runtime.runPromise(Effect.flatMap(MachineRepository, (repository) => repository.retiredPeers))).toEqual(["mini"]);
  });
});
