import { EventEmitter } from "node:events";
import * as crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { RpcTest } from "effect/rpc";
import { SqlClient } from "effect/sql";
import { afterEach, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { Command } from "../src/shared/model";
import { ModelService } from "../src/core/model/service";
import { ModelDependents } from "../src/core/model/dependents";
import { makeStateEngineLive } from "../src/core/state/engine";
import { makeSeatSessionRepositoryLive, SeatSessionRepository } from "../src/core/seat-sessions/repository";
import { MachineRepository, makeMachineRepositoryLive } from "../src/core/machines/repository";
import { ActorSeatOccupy, type ActorOccupySpec } from "../src/core/term/actor-seat-occupy";
import { TerminalNodeDeleteService } from "../src/core/term/node-delete";
import { makeRemoteSeatState } from "../src/core/term/remote-seat-state";
import { launchForManagedSpawnIntent } from "../src/core/term/managed-spawn-plan";
import { seat } from "./support/model-nodes";
import { managedHarnessEnabled } from "../src/shared/managed-terminal-templates";
import { InstallationId } from "../src/shared/installation-id";
import { deriveActorSeatId } from "../src/core/actor-seat-id";
import { ensureManagedSeatRunning } from "../src/core/term/ensure-managed-seat";
import { termPlane } from "../src/core/term/plane";

const app = vi.hoisted(() => ({ runPromise: vi.fn(), runPromiseExit: vi.fn() }));
// Spread the real module: a later export must not break this file at load.
vi.mock("../src/core/core-runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/core-runner")>()),
  coreRunner: app,
  installCoreReads: vi.fn(),
}));
vi.mock("../src/app/runtime", () => ({ AppRuntime: app }));
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});
import { registerTerminalIpc } from "../src/app/term/ipc";
import { TermCore, TermRpcs } from "../src/contract/core/term-ipc";
import { TermTemplatesCore, TermTemplatesRpcs } from "../src/contract/core/term-templates";
import { bindTermIpcPlane, TermIpcPlane, TermPlaneHandlers } from "../src/core/ops/term-ipc";
import { TermTemplatesHandlers } from "../src/core/ops/term-templates";
import { ensureSeatSessionId } from "../src/core/term/seat-session-before-start";

// The handlers on the test's plane and model. A handler that reads a service
// this test does not give fails when it is asked; none of those is asked here.
const termHandlers = TermPlaneHandlers as never as Layer.Layer<
  Layer.Success<typeof TermPlaneHandlers>,
  never,
  TermIpcPlane | ModelService
>;

// Main runs no handler: its clients reach the core's terminal handlers on the
// fixture's runtime, as the app's reach the core's over the port.
const termClients = (plane: { readonly router: unknown; readonly nodeDelete: unknown }) => Layer.mergeAll(
  Layer.effect(TermCore, RpcTest.makeClient(TermRpcs)),
  Layer.effect(TermTemplatesCore, RpcTest.makeClient(TermTemplatesRpcs)),
).pipe(
  Layer.provide(Layer.mergeAll(termHandlers, TermTemplatesHandlers)),
  Layer.provide(Layer.succeed(TermIpcPlane, plane as never)),
);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  app.runPromise.mockReset();
  app.runPromiseExit.mockReset(); vi.restoreAllMocks(); vi.unstubAllEnvs();
});

const fixture = async () => {
  // Production planning must reuse the stored pin, without dev isolation.
  vi.stubEnv("JUNTO_HOME_OWNS_SESSIONS", "1");
  const root = await mkdtemp(join(tmpdir(), "junto-pin-start-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const occupied: ActorOccupySpec[] = [];
  const recordedAtOccupy: Array<string | undefined> = [];
  let model: ModelService["Service"];
  let sessions: SeatSessionRepository["Service"];
  const router = Object.assign(new EventEmitter(), { thisMachineName: () => "workbench", setTerminalEnvironment: () => {}, isLocalHostId: () => true });
  // The plane is the core's; the test binds it and gives it to the handlers.
  const plane = { router, nodeDelete: new TerminalNodeDeleteService(router as never) };
  const runtime = ManagedRuntime.make(termClients(plane).pipe(Layer.provideMerge(Layer.mergeAll(
    Layer.succeed(ActorSeatOccupy, ActorSeatOccupy.of({
      occupancy: () => Effect.succeed({ kind: "vacant" } as never),
      occupy: (spec) => Effect.gen(function* () {
        const row = (yield* model.canvas(spec.canvasName!)).nodes.get(spec.nodeId as never);
        const held = row?.kind === "agent" ? yield* sessions.current(row.id, row.bindingId) : undefined;
        recordedAtOccupy.push(held?.sessionId);
        occupied.push(spec);
        return { bindingId: spec.bindingId, status: "running" } as never;
      }),
    })),
    Layer.provideMerge(Layer.provide(ModelService.layer, ModelDependents.empty),
      Layer.provideMerge(Layer.mergeAll(makeSeatSessionRepositoryLive(), makeMachineRepositoryLive({ defaultName: () => "workbench" })), makeStateEngineLive(join(root, "state.db")))),
  ))));
  cleanups.push(() => runtime.dispose());
  app.runPromise.mockImplementation((effect) => runtime.runPromise(effect));
  app.runPromiseExit.mockImplementation((effect) => runtime.runPromiseExit(effect));
  model = await runtime.runPromise(ModelService);
  sessions = await runtime.runPromise(SeatSessionRepository);
  await runtime.runPromise(Effect.flatMap(MachineRepository, machine => machine.configureName("workbench")));
  const command = (input: unknown) => runtime.runPromise(model.command(Schema.decodeUnknownSync(Command)(input), "operator"));
  await command({ _tag: "CreateCanvas", canvas: "proof" });
  const sql = await runtime.runPromise(SqlClient.SqlClient);

  const node = seat("subject", { host: "workbench", harness: "codex", launch: { kind: "harness", argv: ["codex"], cwd: root } });
  await command({ _tag: "Add", canvas: "proof", nodes: [node], wires: [] });
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  bindTermIpcPlane(plane as never, makeRemoteSeatState());
  registerTerminalIpc({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } as never,
    { isTrustedSender: () => true, broadcast: () => {}, surfacePlane: () => undefined }, await runtime.context());
  const start = () => Promise.resolve(handlers.get(IPC_CHANNELS.modelStart)!(
    { sender: { isDestroyed: () => false, send: () => {} } }, { canvas: "proof", id: "subject" }));
  const current = async () => (await runtime.runPromise(model.open("proof"))).nodes[0]!;
  const reseat = (bindingId: string, harness = "grok") => command({ _tag: "Reseat", canvas: "proof", id: "subject",
    bindingId, harness, agentKey: `local:${harness}`, host: "workbench",
    launch: { kind: "harness", argv: [harness, "--session-id", "orphan-window-pin"], cwd: root } });
  const pin = async () => {
    const node = await current();
    return node.kind === "agent" ? runtime.runPromise(Effect.flatMap(SeatSessionRepository, repo => repo.current(node.id, node.bindingId))) : undefined;
  };
  return { runtime, model, sql, command, start, current, pin, reseat, occupied, recordedAtOccupy, node };
};

for (const harness of ["grok", "claude", "pi", "cursor"] as const) {
it.skipIf(!managedHarnessEnabled(harness))(`a reseated ${harness} seat records its pin before start and reuses it`, async () => {
  const f = await fixture(); await f.reseat("new-binding", harness);
  const before = (await f.runtime.runPromise(f.model.open("proof"))).seq;
  await f.start();
  const node = await f.current();
  expect(node.kind).toBe("agent");
  expect((await f.pin())?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  const sessionId = (await f.pin())?.sessionId;
  expect(f.occupied[0]?.spawnIntent.sessionId).toBe(sessionId);
  expect(f.recordedAtOccupy[0]).toBe(sessionId);
  expect(f.occupied[0]?.spawnIntent.resumeRequested).toBe(false);
  const planned = launchForManagedSpawnIntent(f.occupied[0]!, f.occupied[0]!.spawnIntent);
  expect(planned.launch?.argv).toContain(sessionId);
  expect(planned.launch?.argv).not.toContain("orphan-window-pin");
  expect((await f.runtime.runPromise(f.model.open("proof"))).seq).toBe(before);
  await f.start();
  expect(await f.pin()).toMatchObject({ sessionId });
  expect(f.occupied[1]?.spawnIntent.sessionId).toBe(sessionId);
  expect((await f.runtime.runPromise(f.model.open("proof"))).seq).toBe(before);
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
  expect(await f.runtime.runPromise(ensureManagedSeatRunning("proof", node, { actor, installationId, hostId: "workbench" }, occupy))).toBe(true);
  expect(f.occupied[0]?.spawnIntent.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(f.recordedAtOccupy[0]).toBe(f.occupied[0]?.spawnIntent.sessionId);
  expect(await f.pin()).toHaveProperty("sessionId", f.occupied[0]?.spawnIntent.sessionId);
});

it("a non-pin harness is unchanged", async () => {
  const f = await fixture(); const before = (await f.runtime.runPromise(f.model.open("proof"))).seq;
  await f.start(); expect(await f.pin()).toBeUndefined();
  expect(f.occupied[0]?.spawnIntent).not.toHaveProperty("sessionId");
  expect((await f.runtime.runPromise(f.model.open("proof"))).seq).toBe(before);
});

it.skipIf(!managedHarnessEnabled("claude"))("an added pin seat with no id gets one before its first start", async () => {
  const f = await fixture();
  await f.command({ _tag: "Remove", canvas: "proof", nodes: ["subject"], wires: [] });
  await f.command({ _tag: "Add", canvas: "proof", nodes: [seat("subject", { host: "workbench", harness: "claude", launch: { kind: "harness", argv: ["claude"] } })], wires: [] });
  await f.start();
  expect(await f.pin()).toHaveProperty("sessionId", f.occupied[0]?.spawnIntent.sessionId);
  expect(f.occupied[0]?.spawnIntent.sessionId).toMatch(/^[0-9a-f-]{36}$/);
});

it.skipIf(!managedHarnessEnabled("claude"))("concurrent starts record one pin and carry the same id", async () => {
  const f = await fixture(); await f.reseat("new-binding", "claude");
  const before = (await f.runtime.runPromise(f.model.open("proof"))).seq;
  await Promise.all([f.start(), f.start()]);
  const node = await f.current();
  expect((await f.pin())?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  const sessionId = (await f.pin())?.sessionId;
  expect(f.occupied.map(spec => spec.spawnIntent.sessionId)).toEqual([sessionId, sessionId]);
  expect((await f.runtime.runPromise(f.model.open("proof"))).seq).toBe(before);
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
      bindingId: "replacement-binding", harness: "claude", agentKey: "local:claude", host: "workbench",
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
