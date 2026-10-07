import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { Command } from "../src/shared/model";
import { nodeToDocument } from "../src/shared/model/from-document";
import { ModelService } from "../src/main/junto/model/service";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { StationRepositoryLive } from "../src/main/junto/station/repository";
import { ActorSeatOccupy, makeActorSeatOccupy } from "../src/main/junto/term/actor-seat-occupy";
import { LocalSessionHost } from "../src/main/junto/term/local-host";
import { TermPlane } from "../src/main/junto/term/plane";
import { EMPTY_LAUNCH_RECORD } from "../src/shared/region-environment";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";
import { seat } from "./support/model-nodes";

const app = vi.hoisted(() => ({ runPromise: vi.fn() }));
vi.mock("../src/main/runtime", () => ({ AppRuntime: app }));
import { registerTerminalIpc } from "../src/main/junto/term/ipc";
import { writeSeatSessionId } from "../src/main/junto/term/seat-session-id";

const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((yes) => { resolve = yes; });
  return { promise, resolve };
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  app.runPromise.mockReset();
  vi.restoreAllMocks();
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-start-quit-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const entered = deferred<void>();
  const environment = deferred<{ env: {}; folders: []; record: typeof EMPTY_LAUNCH_RECORD }>();
  const fake = makeFakeTerminalProcessAuthority(() => ({ pid: undefined, exitOnSignal: "SIGTERM" }));
  const host = new LocalSessionHost(fake.authority, { shutdownGraceMs: 5, killGraceMs: 5, lateExitGraceMs: 5 });
  const plane = new TermPlane(host);
  const occupy = makeActorSeatOccupy({
    local: host, localHostId: () => Effect.succeed("local"),
    clientForOccupy: async () => { throw new Error("unexpected remote start"); },
    remoteProjectionAdmission: () => Effect.void,
    seatEnvironment: () => { entered.resolve(); return environment.promise; },
  });
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    Layer.succeed(ActorSeatOccupy, occupy),
    Layer.provideMerge(
      Layer.provide(ModelService.layer, ModelDependents.empty),
      Layer.provideMerge(StationRepositoryLive, makeStateEngineLive(join(root, "state.db"))),
    ),
  ));
  cleanups.push(async () => {
    environment.resolve({ env: {}, folders: [], record: EMPTY_LAUNCH_RECORD });
    await plane.drainOnQuit("test cleanup");
    await runtime.dispose();
  });
  app.runPromise.mockImplementation((effect) => runtime.runPromise(effect));
  const model = await runtime.runPromise(ModelService);
  const node = seat("seat", { harness: "codex", launch: { kind: "harness", argv: ["codex"], cwd: root } });
  const command = (input: unknown) => runtime.runPromise(model.command(Schema.decodeUnknownSync(Command)(input), "operator"));
  await command({ _tag: "CreateCanvas", canvas: "quit" });
  const sql = await runtime.runPromise(SqlClient.SqlClient);
  await runtime.runPromise(sql`INSERT INTO station_configuration(singleton, role, host_id, supervised_preferred, configured_at)
    VALUES (1, 'command-center', 'local', 0, ${new Date().toISOString()})`);
  await command({ _tag: "Add", canvas: "quit", nodes: [node], wires: [] });
  type Handler = (...args: readonly unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  registerTerminalIpc({ handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never, plane, {
    isTrustedSender: () => true, broadcast: () => {},
  });
  const start = (route: "modelStart" | "terminalCreate" = "modelStart") => Promise.resolve(handlers.get(IPC_CHANNELS[route])!(
    { sender: { isDestroyed: () => false, send: () => {} } },
    route === "modelStart" ? { canvas: "quit", id: "seat" } : { canvasName: "quit", node: nodeToDocument(node) },
  ));
  return { runtime, model, plane, fake, entered, environment, node, start, command };
};

describe("seat start across quit", () => {
  it.each(["modelStart", "terminalCreate"] as const)("%s releases the SQL lease before occupation and drains without waiting for region resolution", async (route) => {
    const f = await fixture();
    const starting = f.start(route);
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
    expect((await f.runtime.runPromise(f.model.open("quit"))).nodes[0]).toMatchObject({ sessionId: "captured-session" });
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
