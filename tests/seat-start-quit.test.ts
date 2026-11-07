import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { RpcTest } from "effect/rpc";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { Command } from "../src/shared/model";
import { ModelService } from "../src/core/model/service";
import { ModelDependents } from "../src/core/model/dependents";
import { makeStateEngineLive } from "../src/core/state/engine";
import { MachineRepository, makeMachineRepositoryLive } from "../src/core/machines/repository";
import { SeatSessionRepository, makeSeatSessionRepositoryLive } from "../src/core/seat-sessions/repository";
import { makeThisMachine } from "../src/shared/remote-hosts";
import { hostsSnapshot, setHostsSnapshot } from "../src/core/hosts/snapshot";
import { ActorSeatOccupy, makeActorSeatOccupy } from "../src/core/term/actor-seat-occupy";
import { LocalSessionHost } from "../src/core/term/local-host";
import { TermPlane } from "../src/core/term/plane";
import { makeRemoteSeatState } from "../src/core/term/remote-seat-state";
import { EMPTY_LAUNCH_RECORD } from "../src/shared/region-environment";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";
import { seat } from "./support/model-nodes";

const app = vi.hoisted(() => ({ runPromise: vi.fn(), runPromiseExit: vi.fn() }));
// Spread the real module: a later export must not break this file at load.
vi.mock("../src/core/core-runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/core-runner")>()),
  coreRunner: app,
  installCoreReads: vi.fn(),
}));
vi.mock("../src/app/runtime", () => ({ AppRuntime: app }));
import { registerTerminalIpc } from "../src/app/term/ipc";
import { TermCore, TermRpcs } from "../src/contract/core/term-ipc";
import { TermTemplatesCore, TermTemplatesRpcs } from "../src/contract/core/term-templates";
import { bindTermIpcPlane, TermIpcPlane, TermPlaneHandlers } from "../src/core/ops/term-ipc";
import { inProcessPushesShape } from "./support/in-process-pushes";
import { TermTemplatesHandlers } from "../src/core/ops/term-templates";
import { writeSeatSessionId } from "../src/core/term/seat-session-id";

// The handlers on the test's plane and model. A handler that reads a service
// this test does not give fails when it is asked; none of those is asked here.
const termHandlers = TermPlaneHandlers as never as Layer.Layer<
  Layer.Success<typeof TermPlaneHandlers>,
  never,
  TermIpcPlane | ModelService
>;

// Main runs no handler: its clients reach the core's terminal handlers on the
// fixture's runtime, as the app's reach the core's over the port.
const termClients = (plane: TermPlane) => Layer.mergeAll(
  Layer.effect(TermCore, RpcTest.makeClient(TermRpcs)),
  Layer.effect(TermTemplatesCore, RpcTest.makeClient(TermTemplatesRpcs)),
).pipe(
  Layer.provide(Layer.mergeAll(termHandlers, TermTemplatesHandlers)),
  Layer.provide(Layer.succeed(TermIpcPlane, plane)),
);

const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((yes) => { resolve = yes; });
  return { promise, resolve };
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  app.runPromise.mockReset();
  app.runPromiseExit.mockReset();
  vi.restoreAllMocks();
});

const fixture = async () => {
  const previousHosts = hostsSnapshot();
  setHostsSnapshot([makeThisMachine("workbench")]);
  cleanups.push(async () => setHostsSnapshot(previousHosts));
  const root = await mkdtemp(join(tmpdir(), "junto-start-quit-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const entered = deferred<void>();
  const environment = deferred<{ env: {}; folders: []; record: typeof EMPTY_LAUNCH_RECORD }>();
  const fake = makeFakeTerminalProcessAuthority(() => ({ pid: undefined, exitOnSignal: "SIGTERM" }));
  const host = new LocalSessionHost(fake.authority, { shutdownGraceMs: 5, killGraceMs: 5, lateExitGraceMs: 5 });
  const plane = new TermPlane(host);
  const occupy = makeActorSeatOccupy({
    local: host, localHostId: () => Effect.succeed("workbench"),
    clientForOccupy: async () => { throw new Error("unexpected remote start"); },
    seatEnvironment: () => { entered.resolve(); return environment.promise; },
  });
  const runtime = ManagedRuntime.make(termClients(plane).pipe(Layer.provideMerge(Layer.mergeAll(
    Layer.succeed(ActorSeatOccupy, occupy),
    Layer.provideMerge(
      Layer.provide(ModelService.layer, ModelDependents.empty),
      Layer.provideMerge(Layer.mergeAll(makeMachineRepositoryLive({ defaultName: () => "workbench" }), makeSeatSessionRepositoryLive()), makeStateEngineLive(join(root, "state.db"))),
    ),
  ))));
  cleanups.push(async () => {
    environment.resolve({ env: {}, folders: [], record: EMPTY_LAUNCH_RECORD });
    await plane.drainOnQuit("test cleanup");
    await runtime.dispose();
  });
  app.runPromise.mockImplementation((effect) => runtime.runPromise(effect));
  app.runPromiseExit.mockImplementation((effect) => runtime.runPromiseExit(effect));
  const model = await runtime.runPromise(ModelService);
  const node = seat("seat", { harness: "codex", launch: { kind: "harness", argv: ["codex"], cwd: root } });
  const command = (input: unknown) => runtime.runPromise(model.command(Schema.decodeUnknownSync(Command)(input), "operator"));
  await command({ _tag: "CreateCanvas", canvas: "quit" });
  const sql = await runtime.runPromise(SqlClient.SqlClient);
  await runtime.runPromise(Effect.flatMap(MachineRepository, machine => machine.configureName("workbench")));
  await command({ _tag: "Add", canvas: "quit", nodes: [{ ...node, host: "workbench" }], wires: [] });
  type Handler = (...args: readonly unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  bindTermIpcPlane(plane, inProcessPushesShape, makeRemoteSeatState());
  registerTerminalIpc({ handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never, {
    isTrustedSender: () => true, broadcast: () => {}, surfacePlane: () => undefined,
  }, await runtime.context());
  const start = () => Promise.resolve(handlers.get(IPC_CHANNELS.modelStart)!(
    { sender: { isDestroyed: () => false, send: () => {} } },
    { canvas: "quit", id: "seat" },
  ));
  return { runtime, model, plane, fake, entered, environment, node, start, command };
};

describe("seat start across quit", () => {
  it("modelStart releases the SQL lease before occupation and drains without waiting for region resolution", async () => {
    const f = await fixture();
    const starting = f.start();
    // Observe failures immediately even when quit races the continuation.
    const outcome = starting.then((value) => ({ value }), (error: unknown) => ({ error }));
    await f.entered.promise;
    await f.command({ _tag: "Edit", canvas: "quit", id: "seat", change: { kind: "agent", label: "Edited while starting" } });
    expect((await f.runtime.runPromise(f.model.open("quit"))).nodes[0]).toMatchObject({ label: "Edited while starting" });

    await expect(f.plane.drainOnQuit("quit during start")).resolves.toMatchObject({ clean: true, retainedLabels: [] });
    expect(f.fake.controllers).toHaveLength(0);
    f.environment.resolve({ env: {}, folders: [], record: EMPTY_LAUNCH_RECORD });
    expect(await outcome).toHaveProperty("error", expect.objectContaining({ message: expect.stringMatching(/shutting down/) }));
    expect(f.fake.controllers).toHaveLength(0);
    await f.runtime.dispose();
  });

  it("disposes the runtime while occupation is still awaiting an external resolver", async () => {
    const f = await fixture();
    const outcome = f.start().then((value) => ({ value }), (error: unknown) => ({ error }));
    await f.entered.promise;
    await f.plane.drainOnQuit("quit during unresolved start");
    await f.runtime.dispose();
    expect(await outcome).toHaveProperty("error");
    f.environment.resolve({ env: {}, folders: [], record: EMPTY_LAUNCH_RECORD });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.fake.controllers).toHaveLength(0);
  });

  it("finishes a still-current session receipt after the terminal admission cut, before runtime disposal", async () => {
    const f = await fixture();
    await f.plane.drainOnQuit("quit before session receipt");
    await expect(writeSeatSessionId({ canvasName: "quit", nodeId: "seat", sessionId: "captured-session", onlyIfAbsent: true,
      capture: { bindingId: f.node.bindingId, harness: "codex", isCurrent: () => true },
    })).resolves.toEqual({ ok: true });
    expect(await f.runtime.runPromise(Effect.flatMap(SeatSessionRepository, sessions => sessions.current("seat", f.node.bindingId)))).toMatchObject({ sessionId: "captured-session" });
    await f.runtime.dispose();
  });

  it("revalidates a queued capture at its SQL lease after quit and refuses an invalidated generation", async () => {
    const f = await fixture();
    const sql = await f.runtime.runPromise(SqlClient.SqlClient);
    const leased = deferred<void>();
    const release = deferred<void>();
    const transaction = f.runtime.runPromise(sql.withTransaction(Effect.promise(async () => { leased.resolve(); await release.promise; })));
    await leased.promise;
    let current = true;
    const stored = writeSeatSessionId({ canvasName: "quit", nodeId: "seat", sessionId: "captured-session", onlyIfAbsent: true,
      capture: { bindingId: f.node.bindingId, harness: "codex", isCurrent: () => current },
    });
    await f.plane.drainOnQuit("quit while capture queued");
    current = false;
    release.resolve();
    await transaction;
    await expect(stored).resolves.toEqual({ ok: false, reason: "session capture generation changed" });
    expect((await f.runtime.runPromise(f.model.open("quit"))).nodes[0]).not.toHaveProperty("sessionId");
    await f.runtime.dispose();
    await expect(writeSeatSessionId({ canvasName: "quit", nodeId: "seat", sessionId: "late-session" })).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("disposed") });
  });
});
