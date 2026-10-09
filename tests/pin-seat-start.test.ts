import { EventEmitter } from "node:events";
import * as crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { Command } from "../src/shared/model";
import { ModelService } from "../src/main/junto/model/service";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { StationRepositoryLive } from "../src/main/junto/station/repository";
import { ActorSeatOccupy, type ActorOccupySpec } from "../src/main/junto/term/actor-seat-occupy";
import { TerminalNodeDeleteService } from "../src/main/junto/term/node-delete";
import { launchForManagedSpawnIntent } from "../src/main/junto/term/managed-spawn-plan";
import { seat } from "./support/model-nodes";
import { managedHarnessEnabled } from "../src/shared/features";
import { InstallationId } from "../src/shared/installation-id";
import { deriveActorSeatId } from "../src/main/junto/station/actor-seat-compiler";
import { ensureManagedSeatRunning } from "../src/main/junto/term/ensure-managed-seat";
import { termPlane } from "../src/main/junto/term/plane";

const app = vi.hoisted(() => ({ runPromise: vi.fn() }));
vi.mock("../src/main/core-runner", () => ({ coreRunner: app }));
vi.mock("../src/main/runtime", () => ({ AppRuntime: app }));
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});
import { registerTerminalIpc } from "../src/main/junto/term/ipc";
import { ensureSeatSessionId } from "../src/main/junto/term/seat-session-before-start";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  app.runPromise.mockReset(); vi.restoreAllMocks(); vi.unstubAllEnvs();
});

const fixture = async () => {
  // Production planning must reuse the stored pin, without dev isolation.
  vi.stubEnv("JUNTO_HOME_OWNS_SESSIONS", "1");
  const root = await mkdtemp(join(tmpdir(), "junto-pin-start-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const occupied: ActorOccupySpec[] = [];
  const recordedAtOccupy: Array<string | undefined> = [];
  let model: ModelService["Service"];
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    Layer.succeed(ActorSeatOccupy, ActorSeatOccupy.of({
      occupancy: () => Effect.succeed({ kind: "vacant" } as never),
      occupy: (spec) => Effect.gen(function* () {
        const row = (yield* model.canvas(spec.canvasName!)).nodes.get(spec.nodeId as never);
        recordedAtOccupy.push(row?.kind === "agent" ? row.sessionId : undefined);
        occupied.push(spec);
        return { bindingId: spec.bindingId, status: "running" } as never;
      }),
    })),
    Layer.provideMerge(Layer.provide(ModelService.layer, ModelDependents.empty),
      Layer.provideMerge(StationRepositoryLive, makeStateEngineLive(join(root, "state.db")))),
  ));
  cleanups.push(() => runtime.dispose());
  app.runPromise.mockImplementation((effect) => runtime.runPromise(effect));
  model = await runtime.runPromise(ModelService);
  const command = (input: unknown) => runtime.runPromise(model.command(Schema.decodeUnknownSync(Command)(input), "operator"));
  await command({ _tag: "CreateCanvas", canvas: "proof" });
  const sql = await runtime.runPromise(SqlClient.SqlClient);
  await runtime.runPromise(sql`INSERT INTO station_configuration(singleton, role, host_id, supervised_preferred, configured_at)
    VALUES (1, 'command-center', 'local', 0, ${new Date().toISOString()})`);
  const node = seat("subject", { harness: "codex", launch: { kind: "harness", argv: ["codex"], cwd: root } });
  await command({ _tag: "Add", canvas: "proof", nodes: [node], wires: [] });
  const router = Object.assign(new EventEmitter(), { setTerminalEnvironment: () => {}, isLocalHostId: () => true });
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerTerminalIpc({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } as never,
    { router, nodeDelete: new TerminalNodeDeleteService(router as never) } as never,
    { isTrustedSender: () => true, broadcast: () => {} });
  const start = () => Promise.resolve(handlers.get(IPC_CHANNELS.modelStart)!(
    { sender: { isDestroyed: () => false, send: () => {} } }, { canvas: "proof", id: "subject" }));
  const current = async () => (await runtime.runPromise(model.open("proof"))).nodes[0]!;
  const reseat = (bindingId: string, harness = "grok") => command({ _tag: "Reseat", canvas: "proof", id: "subject",
    bindingId, harness, agentKey: `local:${harness}`, host: "local",
    launch: { kind: "harness", argv: [harness, "--session-id", "orphan-window-pin"], cwd: root } });
  return { runtime, model, sql, command, start, current, reseat, occupied, recordedAtOccupy, node };
};

for (const harness of ["grok", "claude", "pi", "cursor"] as const) {
it.skipIf(!managedHarnessEnabled(harness))(`a reseated ${harness} seat records its pin before start and reuses it`, async () => {
  const f = await fixture(); await f.reseat("new-binding", harness);
  const before = (await f.runtime.runPromise(f.model.open("proof"))).seq;
  await f.start();
  const node = await f.current();
  expect(node.kind).toBe("agent");
  expect(node).toHaveProperty("sessionId", expect.stringMatching(/^[0-9a-f-]{36}$/));
  const sessionId = node.kind === "agent" ? node.sessionId : undefined;
  expect(f.occupied[0]?.spawnIntent.sessionId).toBe(sessionId);
  expect(f.recordedAtOccupy[0]).toBe(sessionId);
  expect(f.occupied[0]?.spawnIntent.resumeRequested).toBe(false);
  const planned = launchForManagedSpawnIntent(f.occupied[0]!, f.occupied[0]!.spawnIntent);
  expect(planned.launch?.argv).toContain(sessionId);
  expect(planned.launch?.argv).not.toContain("orphan-window-pin");
  expect((await f.runtime.runPromise(f.model.open("proof"))).seq).toBe(before + 1);
  await f.start();
  expect((await f.current())).toMatchObject({ sessionId });
  expect(f.occupied[1]?.spawnIntent.sessionId).toBe(sessionId);
  expect((await f.runtime.runPromise(f.model.open("proof"))).seq).toBe(before + 1);
});
}

it.skipIf(!managedHarnessEnabled("claude"))("a first automatic wake records the pin before occupation", async () => {
  const f = await fixture(); await f.reseat("wake-binding", "claude");
  const node = await f.current();
  if (node.kind !== "agent") throw new Error("expected seat");
  vi.spyOn(termPlane.host, "get").mockReturnValue(undefined);
  const installationId = Schema.decodeUnknownSync(InstallationId)("pin-test-installation");
  const actor = { canvasName: "proof", nodeId: node.id, seatId: deriveActorSeatId(installationId, node.bindingId) };
  const occupy = await f.runtime.runPromise(ActorSeatOccupy);
  expect(await f.runtime.runPromise(ensureManagedSeatRunning("proof", node, { actor, installationId, hostId: "local" }, occupy))).toBe(true);
  expect(f.occupied[0]?.spawnIntent.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(f.recordedAtOccupy[0]).toBe(f.occupied[0]?.spawnIntent.sessionId);
  expect(await f.current()).toHaveProperty("sessionId", f.occupied[0]?.spawnIntent.sessionId);
});

it("a non-pin harness is unchanged", async () => {
  const f = await fixture(); const before = (await f.runtime.runPromise(f.model.open("proof"))).seq;
  await f.start(); expect(await f.current()).not.toHaveProperty("sessionId");
  expect(f.occupied[0]?.spawnIntent).not.toHaveProperty("sessionId");
  expect((await f.runtime.runPromise(f.model.open("proof"))).seq).toBe(before);
});

it.skipIf(!managedHarnessEnabled("claude"))("an added pin seat with no id gets one before its first start", async () => {
  const f = await fixture();
  await f.command({ _tag: "Remove", canvas: "proof", nodes: ["subject"], wires: [] });
  await f.command({ _tag: "Add", canvas: "proof", nodes: [seat("subject", { harness: "claude", launch: { kind: "harness", argv: ["claude"] } })], wires: [] });
  await f.start();
  expect(await f.current()).toHaveProperty("sessionId", f.occupied[0]?.spawnIntent.sessionId);
  expect(f.occupied[0]?.spawnIntent.sessionId).toMatch(/^[0-9a-f-]{36}$/);
});

it.skipIf(!managedHarnessEnabled("claude"))("concurrent starts record one pin and carry the same id", async () => {
  const f = await fixture(); await f.reseat("new-binding", "claude");
  const before = (await f.runtime.runPromise(f.model.open("proof"))).seq;
  await Promise.all([f.start(), f.start()]);
  const node = await f.current();
  expect(node).toHaveProperty("sessionId", expect.stringMatching(/^[0-9a-f-]{36}$/));
  const sessionId = node.kind === "agent" ? node.sessionId : undefined;
  expect(f.occupied.map(spec => spec.spawnIntent.sessionId)).toEqual([sessionId, sessionId]);
  expect((await f.runtime.runPromise(f.model.open("proof"))).seq).toBe(before + 1);
});

it("a reseat between mint and record cannot give the new binding the old pin", async () => {
  const f = await fixture(); await f.reseat("first-binding", "claude");
  const node = await f.current();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const lease = f.runtime.runPromise(f.sql.withTransaction(Effect.gen(function* () {
    enter(); yield* Effect.promise(() => released);
    yield* f.model.command(Schema.decodeUnknownSync(Command)({ _tag: "Reseat", canvas: "proof", id: "subject",
      bindingId: "replacement-binding", harness: "claude", agentKey: "local:claude", host: "local",
      launch: { kind: "harness", argv: ["claude"] } }), "operator");
  })));
  await entered;
  const mint = vi.mocked(crypto.randomUUID); mint.mockClear();
  const pending = ensureSeatSessionId({ canvasName: "proof", nodeId: node.id, bindingId: "first-binding", harness: "claude" });
  try {
    await vi.waitFor(() => expect(mint).toHaveBeenCalledOnce());
  } finally { release(); }
  await lease;
  expect(await pending).toEqual({ ok: false, reason: "seat changed before its session was recorded" });
  expect(await f.current()).toMatchObject({ bindingId: "replacement-binding" });
  expect(await f.current()).not.toHaveProperty("sessionId");
  expect(f.occupied).toEqual([]);
});
