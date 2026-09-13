import { chmodSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import {
  createConnection,
  createServer as createNetServer,
  type Server as NetServer,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import {
  WORK_PROTOCOL_VERSION,
  decodeWorkResponse,
  encodeWorkFrame,
  workControlTokenPath,
} from "../src/shared/work-control";
import type { PreambleEvent } from "../src/shared/preamble";
import { CanvasesLive, CanvasesService } from "../src/main/vellum-command/canvases";
import {
  resolveProcessBoundActorRef,
  startWorkControlServer,
  workControlReadiness,
  type WorkControlRuntime,
  type WorkControlServer,
  type WorkControlServerOptions,
} from "../src/main/vellum-command/work/control";
import { mailboxMessageReadId } from "../src/main/vellum-command/work/mailbox-receipts";
import { WorkLive, WorkService } from "../src/main/vellum-command/work/service";
import {
  ContentService,
  makeContentServiceLive,
} from "../src/main/vellum-command/content/service";
import {
  createAuthorialTaskDependencyScopeCapability,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum-command/work/repository";
import { makeStateEngineLive } from "../src/main/vellum-command/state/engine";
import { makeInstallOpsLive } from "../src/main/vellum-command/install-ops/engine";
import { StationRepositoryLive } from "../src/main/vellum-command/station/repository";
import {
  StationFleetTargetRepositoryLive,
} from "../src/main/vellum-command/station/fleet-target-repository";
import {
  StationLivePeerRegistryLive,
} from "../src/main/vellum-command/station/session-registry";
import {
  SettingsLive,
  SettingsService,
} from "../src/main/vellum-command/settings/service";
import { PausePlane, PausePlaneAllPlaying } from "../src/main/vellum-command/pause-plane";
import {
  makeProcessIdentityMap,
  type ProcessIdentityMap,
} from "../src/main/vellum-command/process-identity";
import { resetSeatBlocks } from "../src/main/vellum-command/work/blocked-seat";
import type { CanvasDoc } from "../src/shared/canvas";
import type { ContentRef } from "../src/shared/content";
import {
  createMainAuthoringGate,
  type MainAuthoringGate,
} from "../src/main/vellum-command/main-authoring-gate";
import {
  actorRefFixture,
} from "./helpers/actor-ref-fixtures";
import {
  IntentFactBasis,
  type ActorRef,
  type IntentFactBasis as IntentFactBasisValue,
} from "../src/shared/work-protocol";

const roots: string[] = [];
const servers: WorkControlServer[] = [];
const rogueServers: NetServer[] = [];
const makeWorkTestRuntime = (root: string) => {
  const stateLive = makeStateEngineLive(join(root, "state", "vellum-command.db"));
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      StationRepositoryLive,
      StationFleetTargetRepositoryLive,
      SettingsLive,
      makeContentServiceLive({
        root: join(root, "content"),
        skipInlineMediaMigration: true,
      }),
    ),
    Layer.mergeAll(
      stateLive,
      makeInstallOpsLive(join(root, "state", "install-ops.db")),
    ),
  );
  const canvasesLive = Layer.provideMerge(CanvasesLive, repositoriesLive);
  const workLive = Layer.provideMerge(
    WorkLive,
    Layer.mergeAll(canvasesLive, StationLivePeerRegistryLive),
  );
  return ManagedRuntime.make(
    Layer.mergeAll(workLive, PausePlaneAllPlaying),
  );
};

const runtimes: Array<ReturnType<typeof makeWorkTestRuntime>> = [];
const authoringGates: MainAuthoringGate[] = [];
/** Peer PID for transport tests — must be a live process (epoch-checked). */
const TEST_PEER_PID = process.pid;

const authorialBasis = async (
  runtime: ReturnType<typeof makeWorkTestRuntime>,
): Promise<IntentFactBasisValue> => {
  const canvases = await runtime.runPromise(CanvasesService);
  const witness = await runtime.runPromise(canvases.activeIntentWitness());
  return Schema.decodeUnknownSync(IntentFactBasis, {
    onExcessProperty: "error",
  })({
    kind: "authorial-intent",
    ...witness,
  });
};

const taskDependencyAuthority = async (
  runtime: ReturnType<typeof makeWorkTestRuntime>,
  sink: { readonly canvasName: string; readonly nodeId: string },
) => {
  const canvases = await runtime.runPromise(CanvasesService);
  const authority = await runtime.runPromise(
    canvases.authorityMaterialSnapshot(),
  );
  const basis = Schema.decodeUnknownSync(IntentFactBasis, {
    onExcessProperty: "error",
  })({
    kind: "authorial-intent",
    generation: authority.generation,
    contentSha256: authority.intentSha256,
  });
  return {
    basis,
    dependencyScope: createAuthorialTaskDependencyScopeCapability({
      authority,
      authoringSink: sink,
    }),
  };
};

const deferred = <A>() => {
  let resolve!: (value: A | PromiseLike<A>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const seedDoc = (): CanvasDoc => ({
  nodes: [
    {
      id: "agent",
      type: "text",
      x: 0,
      y: 0,
      width: 120,
      height: 48,
      text: "agent",
      ether: {
        entity: { kind: "agent", name: "local:agent" },
        terminal: {
          bindingId: "bind-agent",
          harness: "claude",
          launch: { kind: "harness", argv: ["claude"] },
        },
      },
    },
    {
      id: "tasks",
      type: "text",
      x: 200,
      y: 0,
      width: 120,
      height: 48,
      text: "tasks",
      ether: {
        entity: { kind: "task" },
      },
    },
    {
      id: "req",
      type: "text",
      x: 400,
      y: 0,
      width: 120,
      height: 48,
      text: "requests",
      ether: { entity: { kind: "requests" } },
    },
    {
      id: "orphan-tasks",
      type: "text",
      x: 500,
      y: 200,
      width: 120,
      height: 48,
      text: "orphan",
      ether: { entity: { kind: "task" } },
    },
    {
      id: "artifacts",
      type: "text",
      x: 600,
      y: 0,
      width: 120,
      height: 48,
      text: "artifacts",
      ether: { entity: { kind: "artifacts" } },
    },
  ],
  edges: [
    { id: "e1", fromNode: "agent", toNode: "tasks" },
    { id: "e2", fromNode: "agent", toNode: "req" },
    { id: "e3", fromNode: "agent", toNode: "artifacts" },
  ],
});

const seedCanonicalWork = async (
  runtime: ReturnType<typeof makeWorkTestRuntime>,
): Promise<void> => {
  const settings = await runtime.runPromise(SettingsService);
  await runtime.runPromise(
    settings.setStationTopology({
      role: "command-center",
      hostId: "local",
      supervisedPreferred: true,
    }),
  );
  const canvases = await runtime.runPromise(CanvasesService);
  await runtime.runPromise(canvases.write("work-cli", seedDoc()));
  const repository = await runtime.runPromise(WorkRepository);
  const sink = { canvasName: "work-cli", nodeId: "tasks" };
  const { basis, dependencyScope } = await taskDependencyAuthority(runtime, sink);
  await runtime.runPromise(
    repository.createTask({
      sink,
      basis,
      dependencyScope,
      task: {
        id: "t1",
        state: "submitted",
        history: [
          {
            messageId: "m0",
            role: "user",
            parts: [{ kind: "text", text: "ship it" }],
            taskId: "t1",
          },
        ],
      },
    }),
  );
};

const call = (
  socketPath: string,
  body: unknown,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timeout"));
    }, 5_000);
    socket.on("connect", () => {
      socket.write(encodeWorkFrame(body));
    });
    socket.on("data", (chunk: Buffer | string) => {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buf = Buffer.concat([buf, part]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      clearTimeout(timer);
      const line = buf.subarray(0, nl).toString("utf8");
      socket.destroy();
      resolve(JSON.parse(line));
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

const startTestServer = async (options: {
  readonly runtime?: WorkControlRuntime;
  readonly onPreamble?: (event: PreambleEvent) => void;
  readonly onOverseer?: WorkControlServerOptions["onOverseer"];
  readonly onOverseerLive?: WorkControlServerOptions["onOverseerLive"];
  readonly validateOverseerLive?: WorkControlServerOptions["validateOverseerLive"];
  readonly processMap?: ProcessIdentityMap;
  readonly decorateRun?: (
    base: WorkControlServerOptions["run"],
  ) => WorkControlServerOptions["run"];
} = {}): Promise<{
  readonly server: WorkControlServer;
  readonly authoringGate: MainAuthoringGate;
  readonly processMap: ProcessIdentityMap;
}> => {
  const root = await mkdtemp(join(tmpdir(), "vellum-command-work-ctl-"));
  roots.push(root);
  const canvasesDir = join(root, "canvases");
  const workHome = join(root, "work");
  mkdirSync(canvasesDir, { recursive: true });
  mkdirSync(workHome, { recursive: true });
  process.env.VELLUM_COMMAND_CANVASES_DIR = canvasesDir;
  process.env.VELLUM_COMMAND_WORK_HOME = workHome;

  const runtime = makeWorkTestRuntime(root);
  runtimes.push(runtime);
  // Seed both authorial topology and durable work rows before any hung
  // dispatch so a shutdown timing assertion never includes database startup.
  await seedCanonicalWork(runtime);
  const baseRun: WorkControlServerOptions["run"] = (effect) =>
    runtime.runPromise(effect);

  const processMap = options.processMap ?? makeProcessIdentityMap();
  processMap.bind(TEST_PEER_PID, {
    agentKey: "local:agent",
  });

  const authoringGate = createMainAuthoringGate();
  authoringGates.push(authoringGate);
  const server = await startWorkControlServer({
    version: "test",
    workHome,
    home: root,
    processMap,
    readPeerPid: () => TEST_PEER_PID,
    run: options.decorateRun?.(baseRun) ?? baseRun,
    authoringGate,
    onPreamble: options.onPreamble,
    onOverseer: options.onOverseer,
    onOverseerLive: options.onOverseerLive,
    validateOverseerLive: options.validateOverseerLive,
  }, options.runtime);
  servers.push(server);
  return { server, authoringGate, processMap };
};

beforeEach(async () => {
  resetSeatBlocks();
  await startTestServer();
});

afterEach(async () => {
  resetSeatBlocks();
  while (rogueServers.length > 0) {
    const rogue = rogueServers.pop();
    if (rogue?.listening) {
      await new Promise<void>((resolveClose) => rogue.close(() => resolveClose()));
    }
  }
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) await server.close();
  }
  while (runtimes.length > 0) {
    const rt = runtimes.pop();
    if (rt) await rt.dispose();
  }
  authoringGates.length = 0;
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
  delete process.env.VELLUM_COMMAND_CANVASES_DIR;
  delete process.env.VELLUM_COMMAND_WORK_HOME;
});

const token = (): string => {
  const workHome = process.env.VELLUM_COMMAND_WORK_HOME!;
  return readFileSync(workControlTokenPath(workHome), "utf8").trim();
};

const projectedProcessActor = async (): Promise<ActorRef> => {
  const runtime = runtimes.at(-1);
  if (runtime === undefined) throw new Error("missing work-control runtime");
  const canvases = await runtime.runPromise(CanvasesService);
  const read = await runtime.runPromise(canvases.read("work-cli"));
  const actor = read.actorRefs.find((candidate) => candidate.nodeId === "agent");
  if (actor === undefined) throw new Error("missing projected process actor");
  return actor;
};

describe("work control transport", () => {
  it("binds the private Live protocol to the native occupant and fences uncorrelated or stale mutations", async () => {
    const assertCurrent = vi.fn();
    const validate = vi.fn<NonNullable<WorkControlServerOptions["validateOverseerLive"]>>(async () => ({ assertCurrent }));
    const bridge = vi.fn<NonNullable<WorkControlServerOptions["onOverseerLive"]>>(async () => ({ type: "idle" }));
    const execute = vi.fn<NonNullable<WorkControlServerOptions["onOverseer"]>>(async (request) => ({ ok: true, operation: request.operation, data: {} }));
    const { server, processMap } = await startTestServer({ onOverseer: execute, onOverseerLive: bridge, validateOverseerLive: validate });
    const request = { token: token(), op: "overseer.live", args: { type: "next" } };
    expect(await call(server.socketPath, request)).toMatchObject({ ok: false, error: { type: "AuthError" } });
    expect(bridge).not.toHaveBeenCalled();
    const runtime = runtimes.at(-1)!;
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.mutate("work-cli", (doc) => ({ ...doc, nodes: doc.nodes.map((node) => node.id !== "agent" ? node : ({
      ...node, ether: { ...node.ether, terminal: { ...node.ether!.terminal!, harness: "vellum-overseer" } },
    })) })));
    const read = await runtime.runPromise(canvases.read("work-cli"));
    await runtime.runPromise(canvases.canvasOverseerSet({ canvasName: "work-cli", nodeId: "agent", overseer: true, expectedRevision: read.revision }));
    expect(await call(server.socketPath, request)).toMatchObject({ ok: true, data: { type: "idle" } });
    expect(bridge.mock.calls[0]?.[1]).toMatchObject({ canvasName: "work-cli", nodeId: "agent", bindingId: "bind-agent", peerPid: TEST_PEER_PID,
      processGeneration: `${TEST_PEER_PID}:${processMap.snapshot()[0]!.startKey}` });
    const mutation = { token: token(), op: "overseer", args: { operation: "node.move", args: { nodeId: "tasks", x: 1, y: 2 } } };
    expect(await call(server.socketPath, mutation)).toMatchObject({ ok: false, error: { type: "AuthError" } });
    for (const op of ["tasks.create", "content.materialize", "pad.read"]) {
      expect(await call(server.socketPath, { token: token(), op, args: {} })).toMatchObject({ ok: false, error: { type: "AuthError" } });
    }
    expect(execute).not.toHaveBeenCalled();
    const correlated = { ...mutation, args: { ...mutation.args, live: { sessionId: "s", requestId: "r", intentRevision: 1, operationId: "op" } } };
    expect(await call(server.socketPath, correlated)).toMatchObject({ ok: true, data: { ok: true } });
    expect(assertCurrent).toHaveBeenCalledTimes(1);
    assertCurrent.mockImplementation(() => { throw new Error("request superseded"); });
    expect(await call(server.socketPath, correlated)).toMatchObject({ ok: false });
    expect(execute).toHaveBeenCalledTimes(1);
    processMap.unbind(TEST_PEER_PID);
    expect(await call(server.socketPath, request)).toMatchObject({ ok: false, error: { type: "AuthError" } });
  });
  it("bounds overseer correlation ids by encoded bytes before any dispatch", async () => {
    const execute = vi.fn<NonNullable<WorkControlServerOptions["onOverseer"]>>(async (request) => ({
      ok: true, operation: request.operation, data: {},
    }));
    const { server } = await startTestServer({ onOverseer: execute });
    const request = { token: token(), op: "overseer", args: { operation: "status" } };
    const acceptedId = "a".repeat(4094); // JSON quotes bring this to 4096 bytes.
    expect(await call(server.socketPath, { ...request, id: acceptedId })).toMatchObject({
      ok: false, id: acceptedId, error: { type: "ScopeError" },
    });
    for (const id of ["a".repeat(4095), "\0".repeat(683)]) {
      const refused = await call(server.socketPath, { ...request, id });
      expect(refused).toMatchObject({
        ok: false, error: { type: "InputError", details: { path: "id", retryable: false } },
      });
      expect(refused).not.toHaveProperty("id");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("admits only human-enabled overseers through the paused, no-edge administrative route", async () => {
    const execute = vi.fn<NonNullable<WorkControlServerOptions["onOverseer"]>>(async (request, caller) => ({
      ok: true, operation: request.operation, data: { caller },
    }));
    const { server, authoringGate } = await startTestServer({
      onOverseer: execute,
      decorateRun: (base) => (effect) => base(effect.pipe(Effect.provideService(PausePlane, {
        start: Effect.void,
        stateFor: () => ({ playing: false, everPlayed: true, pausedNodes: ["agent"], pausedRegions: [] }),
        setPlaying: () => Effect.void,
        setScopePaused: () => Effect.void,
        subscribe: () => () => {},
      }))),
    });
    const runtime = runtimes.at(-1)!;
    const canvases = await runtime.runPromise(CanvasesService);
    const request = { token: token(), op: "overseer", args: { operation: "node.list" } };
    expect(await call(server.socketPath, request)).toMatchObject({
      ok: false, error: { type: "ScopeError" },
    });
    expect(execute).not.toHaveBeenCalled();
    await runtime.runPromise(canvases.mutate("work-cli", (doc) => ({ ...doc, edges: [] })));
    const toggle = async (overseer: boolean) => {
      const read = await runtime.runPromise(canvases.read("work-cli"));
      await runtime.runPromise(canvases.canvasOverseerSet({
        canvasName: "work-cli", nodeId: "agent", overseer, expectedRevision: read.revision,
      }));
    };
    await toggle(true);
    expect(await call(server.socketPath, request)).toMatchObject({
      ok: true, data: { ok: true, data: { caller: { canvasName: "work-cli", nodeId: "agent" } } },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await call(server.socketPath, { ...request, args: {
      operation: "node.move", args: { nodeId: "agent", x: 2, y: 3, overseer: true },
    } })).toMatchObject({ ok: false, error: { type: "InputError" } });
    expect(execute).toHaveBeenCalledTimes(1);
    await toggle(false);
    expect(await call(server.socketPath, request)).toMatchObject({ ok: false, error: { type: "ScopeError" } });
    expect(execute).toHaveBeenCalledTimes(1);
    await toggle(true);
    authoringGate.beginFinalFlush();
    expect(await call(server.socketPath, request)).toMatchObject({ ok: false, error: { type: "RuntimeDown" } });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  const enableOverseer = async (): Promise<void> => {
    const runtime = runtimes.at(-1)!;
    const canvases = await runtime.runPromise(CanvasesService);
    const read = await runtime.runPromise(canvases.read("work-cli"));
    await runtime.runPromise(canvases.canvasOverseerSet({
      canvasName: "work-cli", nodeId: "agent", overseer: true, expectedRevision: read.revision,
    }));
  };

  const holdOverseerUntilRelease = (mode: "succeed" | "fail") => {
    let releaseInner!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseInner = resolve;
    });
    let started = 0;
    let finished = 0;
    const execute = vi.fn<NonNullable<WorkControlServerOptions["onOverseer"]>>(async (request) => {
      started += 1;
      await held;
      finished += 1;
      if (mode === "fail") throw new Error("inner overseer cleanup failed");
      return { ok: true, operation: request.operation, data: { drained: true } };
    });
    return {
      execute,
      started: () => started,
      finished: () => finished,
      releaseInner: () => releaseInner(),
    };
  };

  it("does not settle a revoked overseer dispatch until inner onOverseer cleanup finishes", async () => {
    const inner = holdOverseerUntilRelease("succeed");
    const processMap = makeProcessIdentityMap();
    let activeWatchers = 0;
    const tracked: ProcessIdentityMap = {
      ...processMap,
      subscribe: (listener) => {
        activeWatchers += 1;
        const stop = processMap.subscribe(listener);
        return () => {
          activeWatchers -= 1;
          stop();
        };
      },
    };
    const { server, authoringGate } = await startTestServer({
      onOverseer: inner.execute,
      processMap: tracked,
    });
    await enableOverseer();
    let settled = false;
    const responsePromise = call(server.socketPath, {
      token: token(),
      op: "overseer",
      args: { operation: "status" },
    }).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(inner.started()).toBe(1));
    expect(authoringGate.snapshot().activeLabels).toContain("control.overseer");
    expect(activeWatchers).toBe(1);

    tracked.unbind(TEST_PEER_PID);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(inner.finished()).toBe(0);
    expect(authoringGate.snapshot().activeLabels).toContain("control.overseer");

    inner.releaseInner();
    const response = await responsePromise as {
      readonly ok: false;
      readonly error: { readonly type: string };
    };
    expect(response).toMatchObject({
      ok: false,
      error: { type: "AuthError" },
    });
    expect(inner.execute).toHaveBeenCalledTimes(1);
    expect(inner.finished()).toBe(1);
    expect(authoringGate.snapshot().activeLabels).toEqual([]);
    expect(activeWatchers).toBe(0);
  });

  it("does not settle a revoked overseer dispatch until inner onOverseer failure cleanup finishes", async () => {
    const inner = holdOverseerUntilRelease("fail");
    const processMap = makeProcessIdentityMap();
    let activeWatchers = 0;
    const tracked: ProcessIdentityMap = {
      ...processMap,
      subscribe: (listener) => {
        activeWatchers += 1;
        const stop = processMap.subscribe(listener);
        return () => {
          activeWatchers -= 1;
          stop();
        };
      },
    };
    const { server, authoringGate } = await startTestServer({
      onOverseer: inner.execute,
      processMap: tracked,
    });
    await enableOverseer();
    let settled = false;
    const responsePromise = call(server.socketPath, {
      token: token(),
      op: "overseer",
      args: { operation: "status" },
    }).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(inner.started()).toBe(1));
    tracked.unbind(TEST_PEER_PID);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(inner.finished()).toBe(0);

    inner.releaseInner();
    const response = await responsePromise as {
      readonly ok: false;
      readonly error: { readonly type: string };
    };
    expect(response).toMatchObject({
      ok: false,
      error: { type: "AuthError" },
    });
    expect(inner.execute).toHaveBeenCalledTimes(1);
    expect(inner.finished()).toBe(1);
    expect(authoringGate.snapshot().activeLabels).toEqual([]);
    expect(activeWatchers).toBe(0);
  });

  it("resolves process-bound callers to exactly one projected actor reference", () => {
    const actor = actorRefFixture("agent", "work-cli");
    const caller = { canvasName: "work-cli", nodeId: "agent" };

    expect(resolveProcessBoundActorRef([actor], caller)).toMatchObject({
      _tag: "Success",
      success: actor,
    });
    expect(resolveProcessBoundActorRef([], caller)).toMatchObject({
      _tag: "Failure",
      failure: { type: "StaleNodeRef" },
    });
    expect(
      resolveProcessBoundActorRef(
        [
          actor,
          {
            ...actor,
            seatId: actorRefFixture("other", "work-cli").seatId,
          },
        ],
        caller,
      ),
    ).toMatchObject({
      _tag: "Failure",
      failure: { type: "StaleNodeRef" },
    });
  });

  it("caps accepted peers before frame parsing and recovers after close", async () => {
    const { server } = await startTestServer({ runtime: { maxActiveClients: 1 } });
    const first = createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => { first.once("connect", resolve); first.once("error", reject); });
    const excess = createConnection(server.socketPath);
    await new Promise<void>((resolve) => excess.once("close", resolve));
    first.destroy();
    await new Promise<void>((resolve) => first.once("close", resolve));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const recovered = await call(server.socketPath, { token: token(), op: "ping" }) as { ok: boolean };
    expect(recovered.ok).toBe(true);
  });
  it("mints 0600 socket + token", async () => {
    const server = servers[0]!;
    const sockMode = (await stat(server.socketPath)).mode & 0o777;
    const tokMode = (await stat(server.tokenPath)).mode & 0o777;
    expect(sockMode).toBe(0o600);
    expect(tokMode).toBe(0o600);
  });

  it("reports only a current owned listener, never stale paths or a foreign socket", async () => {
    const server = servers[0]!;
    expect(workControlReadiness.ready()).toBe(true);

    await expect(server.close()).resolves.toMatchObject({ clean: true });
    expect(workControlReadiness.ready()).toBe(false);
    await expect(stat(server.tokenPath)).resolves.toMatchObject({ mode: expect.any(Number) });

    const foreign = createNetServer();
    rogueServers.push(foreign);
    await new Promise<void>((resolveListen, rejectListen) => {
      foreign.once("error", rejectListen);
      foreign.listen({ path: server.socketPath }, () => {
        foreign.removeListener("error", rejectListen);
        resolveListen();
      });
    });

    expect(foreign.listening).toBe(true);
    expect(workControlReadiness.ready()).toBe(false);
  });

  it("idempotently closes admission and drains accepted sockets to a fixed point", async () => {
    const server = servers[0]!;
    const socket = createConnection({ path: server.socketPath });
    socket.on("error", () => undefined);
    await new Promise<void>((resolveConnect, rejectConnect) => {
      socket.once("connect", resolveConnect);
      socket.once("error", rejectConnect);
    });

    server.beginShutdown();
    server.beginShutdown();
    const first = server.drainOnQuit();
    expect(server.close()).toBe(first);

    const latePeer = await new Promise<"connected" | "refused">((resolveLate) => {
      const peer = createConnection({ path: server.socketPath });
      peer.once("connect", () => {
        peer.destroy();
        resolveLate("connected");
      });
      peer.once("error", () => resolveLate("refused"));
    });
    expect(latePeer).toBe("refused");
    await expect(first).resolves.toEqual({
      clean: true,
      rounds: expect.any(Number),
      settled: expect.any(Number),
      fulfilled: expect.any(Number),
      rejected: 0,
      retainedCounts: {
        lineHandlers: 0,
        dispatches: 0,
        listenerClosures: 0,
        sockets: 0,
        socketPaths: 0,
      },
      retainedLabels: [],
    });
    expect(socket.destroyed).toBe(true);
  });

  it("refuses frames written by an already-accepted peer after the shutdown cut line", async () => {
    let dispatches = 0;
    const { server } = await startTestServer({
      runtime: { shutdownGraceMs: 5, shutdownDeadlineMs: 50 },
      decorateRun: (base) => async (effect) => {
        dispatches += 1;
        return base(effect);
      },
    });
    const socket = createConnection({ path: server.socketPath });
    socket.on("error", () => undefined);
    await new Promise<void>((resolveConnect, rejectConnect) => {
      socket.once("connect", resolveConnect);
      socket.once("error", rejectConnect);
    });

    server.beginShutdown();
    socket.write(encodeWorkFrame({
      token: readFileSync(server.tokenPath, "utf8").trim(),
      op: "ping",
    }));
    await expect(server.drainOnQuit()).resolves.toMatchObject({ clean: true });
    expect(dispatches).toBe(0);
  });

  it("retains hung line and dispatch promises after their peer is destroyed", async () => {
    const dispatchStarted = deferred<void>();
    const releaseDispatch = deferred<void>();
    const { server } = await startTestServer({
      runtime: { shutdownGraceMs: 5, shutdownDeadlineMs: 30 },
      decorateRun: (base) => async (effect) => {
        dispatchStarted.resolve();
        await releaseDispatch.promise;
        return base(effect);
      },
    });
    const socket = createConnection({ path: server.socketPath });
    socket.on("error", () => undefined);
    await new Promise<void>((resolveConnect, rejectConnect) => {
      socket.once("connect", resolveConnect);
      socket.once("error", rejectConnect);
    });
    socket.write(encodeWorkFrame({
      token: readFileSync(server.tokenPath, "utf8").trim(),
      op: "ping",
    }));
    await dispatchStarted.promise;

    const receipt = await server.drainOnQuit();
    expect(receipt.clean).toBe(false);
    expect(receipt.retainedCounts).toMatchObject({
      lineHandlers: 1,
      dispatches: 1,
      listenerClosures: 0,
      sockets: 0,
      socketPaths: 0,
    });
    expect(receipt.retainedLabels).toEqual(
      expect.arrayContaining(["line-handler", "dispatch:ping"]),
    );

    releaseDispatch.resolve();
    await expect(server.close()).resolves.toMatchObject({
      clean: true,
      retainedLabels: [],
    });
  });

  it("keeps the shutdown deadline bounded when the wall clock moves backward", async () => {
    const dispatchStarted = deferred<void>();
    const releaseDispatch = deferred<void>();
    const { server } = await startTestServer({
      runtime: { shutdownGraceMs: 5, shutdownDeadlineMs: 30 },
      decorateRun: (base) => async (effect) => {
        dispatchStarted.resolve();
        await releaseDispatch.promise;
        return base(effect);
      },
    });
    const socket = createConnection({ path: server.socketPath });
    socket.on("error", () => undefined);
    await new Promise<void>((resolveConnect, rejectConnect) => {
      socket.once("connect", resolveConnect);
      socket.once("error", rejectConnect);
    });
    socket.write(encodeWorkFrame({
      token: readFileSync(server.tokenPath, "utf8").trim(),
      op: "ping",
    }));
    await dispatchStarted.promise;

    let wallClock = 1_000_000;
    const wallClockSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      wallClock -= 60_000;
      return wallClock;
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const receipt = await Promise.race([
        server.close(),
        new Promise<never>((_resolve, reject) => {
          watchdog = setTimeout(
            () => reject(new Error("work control drain exceeded its bounded deadline")),
            250,
          );
        }),
      ]);
      expect(receipt).toMatchObject({
        clean: false,
        retainedCounts: { lineHandlers: 1, dispatches: 1 },
      });
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
      wallClockSpy.mockRestore();
      releaseDispatch.resolve();
    }
    await expect(server.close()).resolves.toMatchObject({ clean: true });
  });

  it("publishes dispatch lifetime before caller code can re-enter shutdown", async () => {
    const entered = deferred<void>();
    let target!: WorkControlServer;
    let reentrantDrain: ReturnType<WorkControlServer["drainOnQuit"]> | undefined;
    let concurrentWasSame = false;
    const started = await startTestServer({
      runtime: { shutdownGraceMs: 5, shutdownDeadlineMs: 100 },
      decorateRun: (base) => async (effect) => {
        target.beginShutdown();
        reentrantDrain = target.drainOnQuit();
        concurrentWasSame = target.close() === reentrantDrain;
        entered.resolve();
        return base(effect);
      },
    });
    target = started.server;
    const socket = createConnection({ path: target.socketPath });
    socket.on("error", () => undefined);
    await new Promise<void>((resolveConnect, rejectConnect) => {
      socket.once("connect", resolveConnect);
      socket.once("error", rejectConnect);
    });
    socket.write(encodeWorkFrame({
      token: readFileSync(target.tokenPath, "utf8").trim(),
      op: "ping",
    }));

    await entered.promise;
    expect(concurrentWasSame).toBe(true);
    await expect(reentrantDrain).resolves.toMatchObject({
      clean: true,
      retainedCounts: { lineHandlers: 0, dispatches: 0 },
    });
  });

  it("preserves a replacement socket path and retries listener close after it leaves", async () => {
    const { server } = await startTestServer({
      runtime: { shutdownGraceMs: 5, shutdownDeadlineMs: 30 },
    });
    unlinkSync(server.socketPath);
    const replacement = createNetServer();
    rogueServers.push(replacement);
    await new Promise<void>((resolveListen, rejectListen) => {
      replacement.once("error", rejectListen);
      replacement.listen(server.socketPath, resolveListen);
    });

    const refused = await server.close();
    expect(refused.clean).toBe(false);
    expect(refused.retainedCounts).toMatchObject({
      listenerClosures: 1,
      socketPaths: 1,
    });
    expect((await stat(server.socketPath)).isSocket()).toBe(true);

    await new Promise<void>((resolveClose) => replacement.close(() => resolveClose()));
    rogueServers.splice(rogueServers.indexOf(replacement), 1);
    await expect(server.close()).resolves.toMatchObject({
      clean: true,
      retainedCounts: { listenerClosures: 0, socketPaths: 0 },
      retainedLabels: [],
    });
  });

  it("ping + doctor over NDJSON", async () => {
    const server = servers[0]!;
    const pong = await call(server.socketPath, {
      token: token(),
      op: "ping",
    });
    const decoded = decodeWorkResponse(pong);
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") {
      expect(decoded.success.ok).toBe(true);
      if (decoded.success.ok) {
        expect((decoded.success.data as { protocol_version: string }).protocol_version).toBe(
          WORK_PROTOCOL_VERSION,
        );
      }
    }

    const doctor = (await call(server.socketPath, {
      token: token(),
      op: "doctor",
    })) as {
      ok: true;
      data: {
        protocol_version: string;
        commands: {
          counts: { pending: number; applied: number; rejected: number };
          pending: ReadonlyArray<unknown>;
          rejections: ReadonlyArray<unknown>;
          truncated: { pending: boolean; rejections: boolean };
        };
      };
    };
    expect(doctor).toMatchObject({
      ok: true,
      data: {
        protocol_version: WORK_PROTOCOL_VERSION,
        commands: {
          counts: { pending: 0, applied: 0, rejected: 0 },
          pending: [],
          rejections: [],
          truncated: { pending: false, rejections: false },
        },
      },
    });
  });

  it("emits a bounded seat-local preamble without authoring the canvas", async () => {
    const events: PreambleEvent[] = [];
    const { server } = await startTestServer({
      onPreamble: (event) => events.push(event),
    });
    const response = (await call(server.socketPath, {
      token: token(),
      op: "preamble",
      args: { text: "  inspecting\n the task  " },
    })) as {
      ok: true;
      data: PreambleEvent & { readonly disposition: "applied" };
    };

    expect(response.ok).toBe(true);
    expect(response.data.text).toBe("inspecting the task");
    expect(response.data.disposition).toBe("applied");
    expect(response.data.expiresAt).toBeGreaterThan(Date.now());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      canvasName: "work-cli",
      nodeId: "agent",
      text: "inspecting the task",
      preambleId: response.data.preambleId,
      expiresAt: response.data.expiresAt,
    });

    const canvases = await runtimes.at(-1)!.runPromise(CanvasesService);
    const read = await runtimes.at(-1)!.runPromise(canvases.read("work-cli"));
    const agentNode = read.doc.nodes.find(
      (node) => node.id === "agent" && node.type === "text",
    );
    expect(agentNode?.type === "text" ? agentNode.text : undefined).toBe("agent");
  });

  it("escalate marks seat blocked; work ops return Blocked; resolve clears", async () => {
    const server = servers[0]!;
    const actor = await projectedProcessActor();
    const escalated = (await call(server.socketPath, {
      token: token(),
      op: "request.escalate",
      args: {
        target: "req",
        brief: "need staging key",
        reason: "cannot continue",
      },
    })) as {
      ok: true;
      data: {
        blocked: boolean;
        stop_directive: { action: string; requestId: string };
        request: { id: string; state: string };
      };
    };
    expect(escalated.ok).toBe(true);
    expect(escalated.data.blocked).toBe(true);
    expect(escalated.data.stop_directive.action).toBe("stop");
    expect(escalated.data.request.state).toBe("input-required");
    expect(escalated.data.request).toMatchObject({
      claimedBy: actor.seatId,
    });
    const requestId = escalated.data.request.id;
    expect(escalated.data.stop_directive.requestId).toBe(requestId);

    const blockedClaim = (await call(server.socketPath, {
      token: token(),
      op: "tasks.claim",
      args: { target: "tasks", task: "t1" },
    })) as {
      ok: false;
      error: {
        type: string;
        details?: { requestId?: string; stop_directive?: { action: string } };
      };
    };
    expect(blockedClaim.ok).toBe(false);
    expect(blockedClaim.error.type).toBe("Blocked");
    expect(blockedClaim.error.details?.requestId).toBe(requestId);
    expect(blockedClaim.error.details?.stop_directive?.action).toBe("stop");

    // Meta discovery stays open while blocked.
    const ping = (await call(server.socketPath, {
      token: token(),
      op: "ping",
    })) as { ok: boolean };
    expect(ping.ok).toBe(true);

    // Resolve the request → seat unblocks.
    const work = await runtimes[runtimes.length - 1]!.runPromise(WorkService);
    const resolved = await runtimes[runtimes.length - 1]!.runPromise(
      work.workRequestResolve("work-cli", "req", requestId, "here is the key", "completed"),
    );
    expect(resolved.ok).toBe(true);

    const claimAfter = (await call(server.socketPath, {
      token: token(),
      op: "tasks.claim",
      args: { target: "tasks", task: "t1" },
    })) as {
      ok: true;
      data: { disposition: "applied" | "queued" };
    };
    expect(claimAfter.ok).toBe(true);
    expect(claimAfter.data.disposition).toBe("applied");
  });

  it("creates attributed tasks that require operator approval before claim", async () => {
    const server = servers[0]!;
    const actor = await projectedProcessActor();
    const created = (await call(server.socketPath, {
      token: token(),
      op: "tasks.create",
      args: {
        target: "tasks",
        brief: "add keyboard navigation",
        metadata: {
          title: "Keyboard navigation",
          details: "Cover the task board first.",
        },
      },
    })) as {
      ok: true;
      data: {
        id: string;
        raisedBy: { seatId: string; nodeId: string };
        admission?: string;
      };
    };
    expect(created.ok).toBe(true);
    expect(created.data.raisedBy).toMatchObject({
      seatId: actor.seatId,
      nodeId: actor.nodeId,
    });
    expect(created.data.admission).toBe("approval");

    const taskId = created.data.id;
    const denied = (await call(server.socketPath, {
      token: token(),
      op: "tasks.claim",
      args: { target: "tasks", task: taskId },
    })) as { ok: false; error: { type: string; message: string } };
    expect(denied.ok).toBe(false);
    expect(denied.error.type).toBe("InputError");
    expect(denied.error.message).toMatch(/approval|operator/i);

    for (const state of ["completed", "rejected", "canceled"] as const) {
      const blocked = (await call(server.socketPath, {
        token: token(),
        op: "tasks.update",
        args: { target: "tasks", task: taskId, state },
      })) as { ok: false; error: { type: string; message: string } };
      expect(blocked.ok).toBe(false);
      expect(blocked.error.type).toBe("InputError");
      expect(blocked.error.message).toMatch(/approval|not yet claimable/i);
    }

    const checked = (await call(server.socketPath, {
      token: token(),
      op: "tasks.check",
      args: { target: "tasks", task: taskId, results: [] },
    })) as { ok: false; error: { type: string; message: string } };
    expect(checked.ok).toBe(false);
    expect(checked.error.type).toBe("InputError");
    expect(checked.error.message).toMatch(/approval|not yet claimable/i);

    const work = await runtimes[runtimes.length - 1]!.runPromise(WorkService);
    const approved = await runtimes[runtimes.length - 1]!.runPromise(
      work.workTaskPromote("work-cli", "tasks", taskId),
    );
    expect(approved.ok).toBe(true);
    if (!approved.ok) throw new Error(approved.message);

    const claimed = (await call(server.socketPath, {
      token: token(),
      op: "tasks.claim",
      args: { target: "tasks", task: taskId },
    })) as { ok: true };
    expect(claimed.ok).toBe(true);
  });

  it("externalizes inline task media before it crosses the work boundary", async () => {
    const server = servers[0]!;
    const created = (await call(server.socketPath, {
      token: token(),
      op: "tasks.create",
      args: {
        target: "tasks",
        brief: "attach a screenshot",
        metadata: { details: "attach a screenshot" },
        media: [
          {
            kind: "raw",
            bytesBase64: Buffer.from("vellum-media").toString("base64"),
            mediaType: "image/png",
          },
        ],
      },
    })) as {
      ok: true;
      data: {
        history: ReadonlyArray<{
          parts: ReadonlyArray<
            | { kind: "text"; text: string }
            | { kind: "content"; ref: ContentRef }
            | { kind: "raw"; bytesBase64: string; mediaType?: string }
          >;
        }>;
      };
    };
    expect(created.ok).toBe(true);
    const media = created.data.history[0]?.parts.find(
      (part) => part.kind === "content" || part.kind === "raw",
    );
    expect(media).toMatchObject({
      kind: "content",
      ref: {
        byteLength: Buffer.byteLength("vellum-media"),
        mediaType: "image/png",
      },
    });
    expect(media).not.toHaveProperty("bytesBase64");
    if (media?.kind !== "content") throw new Error("expected ContentRef part");

    const runtime = runtimes.at(-1);
    if (runtime === undefined) throw new Error("missing work-control runtime");
    const content = await runtime.runPromise(ContentService);
    const availability = await runtime.runPromise(content.availability(media.ref));
    expect(availability).toMatchObject({
      state: "verified",
      verifiedSha256: media.ref.sha256,
      verifiedByteLength: media.ref.byteLength,
    });
  });

  it("serves authorized task content through the process-bound control socket", async () => {
    const server = servers[0]!;
    const created = (await call(server.socketPath, {
      token: token(),
      op: "tasks.create",
      args: {
        target: "tasks",
        brief: "inspect the attached recording",
        metadata: { details: "inspect the attached recording" },
        media: [
          {
            kind: "raw",
            bytesBase64: Buffer.from("task-content").toString("base64"),
            mediaType: "image/png",
          },
        ],
      },
    })) as {
      ok: true;
      data: {
        id: string;
      };
    };
    expect(created.ok).toBe(true);

    const runtime = runtimes.at(-1);
    if (runtime === undefined) throw new Error("missing work-control runtime");
    const work = await runtime.runPromise(WorkService);
    const approved = await runtime.runPromise(
      work.workTaskPromote("work-cli", "tasks", created.data.id),
    );
    expect(approved.ok).toBe(true);
    if (!approved.ok) throw new Error(approved.message);
    const media = approved.data.history
      .flatMap((message) => message.parts)
      .find((part) => part.kind === "content");
    expect(media?.kind).toBe("content");
    if (media?.kind !== "content") throw new Error("expected ContentRef part");

    const statResponse = (await call(server.socketPath, {
      token: token(),
      op: "content.stat",
      args: { target: "tasks", task: approved.data.id, ref: media.ref },
    })) as {
      ok: true;
      data: { state: string; availability: { state: string; verifiedByteLength?: number } };
    };
    expect(statResponse).toMatchObject({
      ok: true,
      data: {
        state: "verified",
        availability: { state: "verified", verifiedByteLength: Buffer.byteLength("task-content") },
      },
    });

    const pathResponse = (await call(server.socketPath, {
      token: token(),
      op: "content.path",
      args: { target: "tasks", task: approved.data.id, ref: media.ref },
    })) as { ok: true; data: { path: string } };
    expect(pathResponse.ok).toBe(true);
    expect(pathResponse.data.path).toContain("/content/sha256/");

    const materialized = (await call(server.socketPath, {
      token: token(),
      op: "content.materialize",
      args: {
        target: "tasks",
        task: approved.data.id,
        ref: media.ref,
        name: "recording.png",
      },
    })) as { ok: true; data: { path: string; materialized: boolean } };
    expect(materialized.ok).toBe(true);
    expect(materialized.data.materialized).toBe(true);
    expect(materialized.data.path).toContain("materialized");
    expect(await readFile(materialized.data.path, "utf8")).toBe("task-content");

    const repeated = (await call(server.socketPath, {
      token: token(),
      op: "content.materialize",
      args: { target: "tasks", task: approved.data.id, ref: media.ref, name: "recording.png" },
    })) as { ok: true; data: { path: string; materialized: boolean } };
    expect(repeated).toMatchObject({
      ok: true,
      data: { path: materialized.data.path, materialized: false },
    });
  });

  it("keeps reads available while returning typed RuntimeDown for authorial ops", async () => {
    const server = servers[0]!;
    const gate = authoringGates[0]!;

    const admitted = (await call(server.socketPath, {
      token: token(),
      op: "tasks.claim",
      args: { target: "tasks", task: "t1" },
    })) as { ok: boolean };
    expect(admitted.ok).toBe(true);

    gate.beginFinalFlush();

    const ping = (await call(server.socketPath, {
      token: token(),
      op: "ping",
    })) as { ok: boolean };
    expect(ping.ok).toBe(true);

    const refusedList = (await call(server.socketPath, {
      token: token(),
      op: "msg.list",
      args: {},
    })) as {
      ok: false;
      error: { type: string; message: string; details?: { retryable?: boolean } };
    };
    expect(refusedList.ok).toBe(false);
    expect(refusedList.error.type).toBe("RuntimeDown");
    expect(refusedList.error.message).toMatch(/final-flush|refused/);
    expect(refusedList.error.details?.retryable).toBe(false);

    const refused = (await call(server.socketPath, {
      token: token(),
      op: "tasks.claim",
      args: { target: "tasks", task: "t1" },
    })) as {
      ok: false;
      error: { type: string; message: string; details?: { retryable?: boolean } };
    };
    expect(refused.ok).toBe(false);
    expect(refused.error.type).toBe("RuntimeDown");
    expect(refused.error.message).toMatch(/final-flush|refused/);
    expect(refused.error.details?.retryable).toBe(false);

    await expect(gate.drain(1_000)).resolves.toMatchObject({
      remaining: [],
      timedOut: false,
    });
  });

  it("rejects the retired client nodeRef field", async () => {
    const server = servers[0]!;
    const response = (await call(server.socketPath, {
      token: token(),
      nodeRef: "vellum-command://canvas/other?node=impostor",
      op: "capabilities",
    })) as {
      ok: false;
      error: {
        type: string;
        message: string;
        details?: { path?: string; retryable?: boolean };
      };
    };
    expect(response.ok).toBe(false);
    expect(response.error.type).toBe("ProtocolError");
    expect(response.error.message).toContain("nodeRef");
    expect(response.error.message).toMatch(/no excess property/i);
    expect(response.error.details).toMatchObject({
      path: "request",
      retryable: false,
    });
  });

  it("rejects the retired client message role field", async () => {
    const server = servers[0]!;
    const response = (await call(server.socketPath, {
      token: token(),
      op: "msg.send",
      args: {
        target: "tasks",
        text: "hello",
        role: "user",
      },
    })) as {
      ok: false;
      error: {
        type: string;
        message: string;
        details?: { path?: string; retryable?: boolean };
      };
    };
    expect(response.ok).toBe(false);
    expect(response.error.type).toBe("InputError");
    expect(response.error.message).toContain("role");
    expect(response.error.message).toMatch(/no excess property/i);
    expect(response.error.details).toMatchObject({
      path: "args",
      retryable: false,
    });
  });

  it("denies an unbound peer", async () => {
    // Spin a one-off server with empty process map.
    const root = await mkdtemp(join(tmpdir(), "vellum-command-work-unbound-"));
    roots.push(root);
    const workHome = join(root, "work");
    const canvasesDir = join(root, "canvases");
    mkdirSync(workHome, { recursive: true });
    mkdirSync(canvasesDir, { recursive: true });
    process.env.VELLUM_COMMAND_CANVASES_DIR = canvasesDir;
    process.env.VELLUM_COMMAND_WORK_HOME = workHome;
    const runtime = makeWorkTestRuntime(root);
    runtimes.push(runtime);
    await seedCanonicalWork(runtime);
    const emptyMap = makeProcessIdentityMap();
    const unboundServer = await startWorkControlServer({
      version: "test",
      workHome,
      home: root,
      processMap: emptyMap,
      readPeerPid: () => 99_999,
      run: (effect) => runtime.runPromise(effect),
    });
    servers.push(unboundServer);
    const res = (await call(unboundServer.socketPath, {
      token: readFileSync(workControlTokenPath(workHome), "utf8").trim(),
      op: "ping",
    })) as { ok: false; error: { type: string; message: string } };
    expect(res.ok).toBe(false);
    expect(res.error.type).toBe("AuthError");
    expect(res.error.message).toMatch(/not a registered|process/i);
  });

  it("rejects wrong token as AuthError", async () => {
    const server = servers[0]!;
    const res = (await call(server.socketPath, {
      token: "wrong-token-value-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      op: "ping",
    })) as { ok: false; error: { type: string } };
    expect(res.ok).toBe(false);
    expect(res.error.type).toBe("AuthError");
  });

  it("survives garbage frames (socket stays up)", async () => {
    const server = servers[0]!;
    // Raw non-JSON line — ProtocolError, connection remains usable for next client.
    const garbage = await new Promise<unknown>((resolve, reject) => {
      const socket = createConnection({ path: server.socketPath });
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("timeout"));
      }, 5_000);
      socket.on("connect", () => {
        socket.write("{{{{not-json\n");
      });
      socket.on("data", (chunk: Buffer | string) => {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        buf = Buffer.concat([buf, part]);
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return;
        clearTimeout(timer);
        const line = buf.subarray(0, nl).toString("utf8");
        socket.destroy();
        resolve(JSON.parse(line));
      });
      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    expect((garbage as { ok: boolean }).ok).toBe(false);
    expect((garbage as { error: { type: string } }).error.type).toBe("ProtocolError");

    const second = (await call(server.socketPath, {
      token: token(),
      op: "ping",
    })) as { ok: boolean };
    expect(second.ok).toBe(true);
  });

  it("ScopeError on non-connected target", async () => {
    const server = servers[0]!;
    const res = (await call(server.socketPath, {
      token: token(),
      op: "tasks.list",
      args: { target: "orphan-tasks" },
    })) as { ok: false; error: { type: string; message: string; details?: { missing?: string } } };
    expect(res.ok).toBe(false);
    expect(res.error.type).toBe("ScopeError");
    expect(res.error.message).toMatch(/edge|connect/i);
  });

  it("msg.read refuses a foreign mailbox (own seat only)", async () => {
    const server = servers[0]!;
    const res = (await call(server.socketPath, {
      token: token(),
      op: "msg.read",
      args: { target: "tasks", messageId: "m-not-mine" },
    })) as {
      ok: false;
      error: { type: string; message: string; details?: { next_step?: string } };
    };
    expect(res.ok).toBe(false);
    expect(res.error.type).toBe("ScopeError");
    expect(res.error.message).toMatch(/own mailbox/i);
  });

  it("claims a connected task", async () => {
    const server = servers[0]!;
    const actor = await projectedProcessActor();
    const res = (await call(server.socketPath, {
      token: token(),
      op: "tasks.claim",
      args: { target: "tasks", task: "t1" },
    })) as { ok: true; data: { id: string; state: string; claimedBy?: string } };
    expect(res.ok).toBe(true);
    expect(res.data.state).toBe("working");
    expect(res.data.claimedBy).toBe(actor.seatId);

    const replay = (await call(server.socketPath, {
      token: token(),
      op: "tasks.claim",
      args: { target: "tasks", task: "t1" },
    })) as {
      ok: true;
      data: {
        id: string;
        state: string;
        claimedBy?: string;
        disposition: string;
        message?: string;
      };
    };
    expect(replay).toMatchObject({
      ok: true,
      data: {
        id: "t1",
        state: "working",
        claimedBy: actor.seatId,
        disposition: "applied",
      },
    });
    expect(replay.data.message).toMatch(/already claimed by you/i);
  });

  it("publishes exact task provenance through the local control boundary", async () => {
    const server = servers[0]!;
    const claimed = (await call(server.socketPath, {
      token: token(),
      op: "tasks.claim",
      args: { target: "tasks", task: "t1" },
    })) as { ok: boolean };
    expect(claimed.ok).toBe(true);

    const published = (await call(server.socketPath, {
      token: token(),
      op: "artifact.publish",
      args: {
        target: "artifacts",
        artifactId: "artifact-task-control",
        task: { target: "tasks", id: "t1" },
        parts: [{ kind: "text", text: "proof" }],
      },
    })) as {
      ok: true;
      data: {
        artifactId: string;
        task: {
          kind: "task";
          itemId: string;
          sink: { canvasName: string; nodeId: string };
        };
      };
    };
    expect(published).toMatchObject({
      ok: true,
      data: {
        artifactId: "artifact-task-control",
        task: {
          kind: "task",
          itemId: "t1",
          sink: {
            canvasName: "work-cli",
            nodeId: "tasks",
          },
        },
      },
    });

    const legacy = (await call(server.socketPath, {
      token: token(),
      op: "artifact.publish",
      args: {
        target: "artifacts",
        artifactId: "artifact-legacy-task-id",
        taskId: "t1",
        parts: [{ kind: "text", text: "legacy" }],
      },
    })) as {
      ok: false;
      error: { type: string; details?: { path?: string } };
    };
    expect(legacy.ok).toBe(false);
    expect(legacy.error.type).toBe("InputError");
    expect(legacy.error.details?.path).toBe("args");
  });

  it("lets any connected agent file an input request on another seat's task", async () => {
    const runtime = runtimes.at(-1);
    if (runtime === undefined) throw new Error("missing work-control runtime");
    const caller = await projectedProcessActor();
    const other = actorRefFixture("other-agent", "work-cli");
    const repository = await runtime.runPromise(WorkRepository);
    const sink = { canvasName: "work-cli", nodeId: "tasks" };
    const { basis, dependencyScope } = await taskDependencyAuthority(
      runtime,
      sink,
    );
    await runtime.runPromise(
      repository.claimLocalTask({
        sink,
        basis,
        dependencyScope,
        taskId: "t1",
        actor: other,
      }),
    );

    const response = (await call(servers[0]!.socketPath, {
      token: token(),
      op: "tasks.update",
      args: {
        target: "tasks",
        task: "t1",
        state: "input-required",
        note: "waiting",
      },
    })) as {
      ok: true;
      data: { disposition: "applied" | "queued" };
    };

    expect(response.ok).toBe(true);
    expect(response.data.disposition).toBe("applied");
    const snapshot = await runtime.runPromise(
      repository.readSnapshot("work-cli", "tasks"),
    );
    expect(snapshot.tasks.items.find((task) => task.id === "t1")).toMatchObject({
      state: "input-required",
      claimedBy: other.seatId,
    });
  });

  it("denies check submissions from a connected actor that does not own the claim", async () => {
    const runtime = runtimes.at(-1);
    if (runtime === undefined) throw new Error("missing work-control runtime");
    const caller = await projectedProcessActor();
    const other = actorRefFixture("other-agent", "work-cli");
    const repository = await runtime.runPromise(WorkRepository);
    const sink = { canvasName: "work-cli", nodeId: "tasks" };
    const { basis, dependencyScope } = await taskDependencyAuthority(
      runtime,
      sink,
    );
    await runtime.runPromise(
      repository.claimLocalTask({
        sink,
        basis,
        dependencyScope,
        taskId: "t1",
        actor: other,
      }),
    );

    const response = (await call(servers[0]!.socketPath, {
      token: token(),
      op: "tasks.check",
      args: { target: "tasks", task: "t1", results: [] },
    })) as {
      ok: false;
      error: {
        type: string;
        details?: { holder?: string; caller?: string; retryable?: boolean };
      };
    };

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({
      type: "ClaimConflict",
      details: {
        holder: other.seatId,
        caller: caller.seatId,
        retryable: false,
      },
    });
    const snapshot = await runtime.runPromise(
      repository.readSnapshot("work-cli", "tasks"),
    );
    const stored = snapshot.tasks.items.find((task) => task.id === "t1");
    expect(stored).toMatchObject({ state: "working", claimedBy: other.seatId });
    expect(stored?.checkResults).toBeUndefined();
  });

  it("rejects client-supplied actor identity", async () => {
    const server = servers[0]!;
    const res = (await call(server.socketPath, {
      token: token(),
      op: "tasks.claim",
      args: { target: "tasks", task: "t1", actor: "other" },
    })) as {
      ok: false;
      error: { type: string; details?: { path?: string } };
    };
    expect(res.ok).toBe(false);
    expect(res.error.type).toBe("InputError");
    expect(res.error.details?.path).toBe("args");
  });

  it("capabilities lists only canonical held grants", async () => {
    const server = servers[0]!;
    const res = (await call(server.socketPath, {
      token: token(),
      op: "capabilities",
    })) as {
      ok: true;
      data: { connected: Array<{ id: string; grants: string[] }> };
    };
    expect(res.ok).toBe(true);
    expect(res.data.connected.map((c) => c.id)).toEqual([
      "artifacts",
      "req",
      "tasks",
    ]);
    expect(
      res.data.connected.find((c) => c.id === "artifacts")?.grants,
    ).toContain("artifact.publish");
    expect(res.data.connected.find((c) => c.id === "tasks")?.grants).toContain(
      "tasks.claim",
    );
    expect(res.data.connected.find((c) => c.id === "req")?.grants).toContain(
      "request.escalate",
    );
  });

  it("never echoes token in responses", async () => {
    const server = servers[0]!;
    const res = await call(server.socketPath, {
      token: token(),
      op: "onboard",
    });
    const raw = JSON.stringify(res);
    expect(raw).not.toContain(token());
  });

  it("msg.list own inbox marks listed mail read and surfaces sent readAt", async () => {
    const server = servers[0]!;
    const runtime = runtimes.at(-1)!;
    const canvases = await runtime.runPromise(CanvasesService);
    const current = await runtime.runPromise(canvases.read("work-cli"));
    await runtime.runPromise(
      canvases.write("work-cli", {
        ...current.doc,
        nodes: [
          ...current.doc.nodes,
          {
            id: "bravo",
            type: "text",
            x: 800,
            y: 0,
            width: 120,
            height: 48,
            text: "bravo",
            ether: {
              entity: { kind: "agent", name: "local:bravo" },
              terminal: {
                bindingId: "bind-bravo",
                harness: "claude",
                launch: { kind: "harness", argv: ["claude"] },
              },
            },
          },
        ],
        edges: [
          ...current.doc.edges,
          { id: "e-ab", fromNode: "agent", toNode: "bravo" },
        ],
      }),
    );
    const repository = await runtime.runPromise(WorkRepository);
    const actor = await projectedProcessActor();
    const basis = await authorialBasis(runtime);
    await runtime.runPromise(
      repository.appendMessage({
        sink: { canvasName: "work-cli", nodeId: "agent" },
        basis,
        message: {
          messageId: "in-1",
          role: "user",
          parts: [{ kind: "text", text: "hello inbox" }],
        },
        sentBy: actor,
        destination: { kind: "mailbox" },
      }),
    );

    const listed = (await call(server.socketPath, {
      token: token(),
      op: "msg.list",
      args: {},
    })) as {
      ok: true;
      data: {
        target: string;
        items: Array<{ messageId: string; metadata?: { readAt?: number } }>;
        sent: Array<{
          messageId: string;
          toNodeId: string;
          metadata?: { readAt?: number };
        }>;
      };
    };
    expect(listed.ok).toBe(true);
    expect(listed.data.target).toBe("agent");
    const inbound = listed.data.items.find((item) => item.messageId === "in-1");
    expect(inbound?.metadata?.readAt).toEqual(expect.any(Number));

    const prefixed = (await call(server.socketPath, {
      token: token(),
      op: "msg.list",
      args: { target: "work-cli:agent" },
    })) as { ok: true; data: { target: string } };
    expect(prefixed.ok).toBe(true);
    expect(prefixed.data.target).toBe("agent");

    const sent = (await call(server.socketPath, {
      token: token(),
      op: "msg.send",
      args: { target: "bravo", text: "from agent" },
    })) as { ok: true; data: { messageId: string } };
    expect(sent.ok).toBe(true);

    const peerPeek = (await call(server.socketPath, {
      token: token(),
      op: "msg.list",
      args: { target: "bravo" },
    })) as {
      ok: true;
      data: {
        items: Array<{ messageId: string; metadata?: { readAt?: number } }>;
      };
    };
    expect(peerPeek.ok).toBe(true);
    expect(
      peerPeek.data.items.find((item) => item.messageId === sent.data.messageId)
        ?.metadata?.readAt,
    ).toBeUndefined();
    expect(
      await runtime.runPromise(
        repository.acceptedDeliveryAt(
          { canvasName: "work-cli", nodeId: "bravo" },
          mailboxMessageReadId("work-cli", "bravo", sent.data.messageId),
        ),
      ),
    ).toBeUndefined();

    const beforeRead = (await call(server.socketPath, {
      token: token(),
      op: "msg.list",
      args: {},
    })) as {
      ok: true;
      data: {
        sent: Array<{
          messageId: string;
          toNodeId: string;
          metadata?: { readAt?: number };
        }>;
      };
    };
    const outbound = beforeRead.data.sent.find(
      (item) => item.messageId === sent.data.messageId,
    );
    expect(outbound?.toNodeId).toBe("bravo");
    expect(outbound?.metadata?.readAt).toBeUndefined();

    const afterWrite = await runtime.runPromise(canvases.read("work-cli"));
    const bravoActor = afterWrite.actorRefs.find((ref) => ref.nodeId === "bravo");
    expect(bravoActor).toBeDefined();
    const work = await runtime.runPromise(WorkService);
    const marked = await runtime.runPromise(
      work.workMessageMarkRead(
        "work-cli",
        "bravo",
        sent.data.messageId,
        bravoActor!,
      ),
    );
    expect(marked.ok).toBe(true);

    const afterRead = (await call(server.socketPath, {
      token: token(),
      op: "msg.list",
      args: {},
    })) as {
      ok: true;
      data: {
        sent: Array<{ messageId: string; metadata?: { readAt?: number } }>;
      };
    };
    expect(
      afterRead.data.sent.find((item) => item.messageId === sent.data.messageId)
        ?.metadata?.readAt,
    ).toEqual(expect.any(Number));

    const reacted = (await call(server.socketPath, {
      token: token(),
      op: "msg.react",
      args: { messageId: "in-1" },
    })) as {
      ok: true;
      data: { messageId: string; reaction: string; reactedAt: string };
    };
    expect(reacted.ok).toBe(true);
    expect(reacted.data).toMatchObject({ messageId: "in-1", reaction: "ack" });

    const peerList = (await call(server.socketPath, {
      token: token(),
      op: "msg.list",
      args: { target: "bravo" },
    })) as {
      ok: true;
      data: {
        items: Array<{
          messageId: string;
          metadata?: { readAt?: number; reactions?: unknown };
        }>;
        sent?: unknown;
      };
    };
    expect(peerList.ok).toBe(true);
    expect(peerList.data.sent).toBeUndefined();
    expect(
      peerList.data.items.find((item) => item.messageId === sent.data.messageId)
        ?.metadata?.readAt,
    ).toEqual(expect.any(Number));
  });

  it("msg.react refuses a foreign mailbox", async () => {
    const server = servers[0]!;
    const res = (await call(server.socketPath, {
      token: token(),
      op: "msg.react",
      args: { target: "tasks", messageId: "m-not-mine" },
    })) as { ok: false; error: { type: string; message: string } };
    expect(res.ok).toBe(false);
    expect(res.error.type).toBe("ScopeError");
    expect(res.error.message).toMatch(/own mailbox/i);
  });

  it("tasks.list and onboard carry the board incoming and outgoing guidance", async () => {
    const server = servers[0]!;
    const runtime = runtimes.at(-1)!;
    const canvases = await runtime.runPromise(CanvasesService);
    const current = await runtime.runPromise(canvases.read("work-cli"));
    await runtime.runPromise(
      canvases.write("work-cli", {
        ...current.doc,
        nodes: [
          ...current.doc.nodes.map((node) =>
            node.id === "tasks"
              ? {
                  ...node,
                  ether: {
                    ...node.ether,
                    tasks: {
                      ...node.ether?.tasks,
                      items: node.ether?.tasks?.items ?? [],
                      contract: {
                        instructions: "implement and gate the change",
                        incoming: {
                          handling: "  reproduce the defect before touching code  ",
                        },
                        outgoing: {
                          handoff: "name the verified fix and cite the failing test",
                        },
                      },
                    },
                  },
                }
              : node,
          ),
          {
            id: "review",
            type: "text",
            x: 700,
            y: 0,
            width: 120,
            height: 48,
            text: "tasks",
            ether: { entity: { kind: "task" }, tasks: { items: [] } },
          },
        ],
        edges: [
          ...current.doc.edges,
          {
            id: "e-flow-tasks-review",
            fromNode: "tasks",
            toNode: "review",
            ether: { verb: "feeds" },
          },
        ],
      }),
    );

    const list = (await call(server.socketPath, {
      token: token(),
      op: "tasks.list",
      args: { target: "tasks" },
    })) as {
      ok: true;
      data: {
        contract?: {
          instructions?: string;
          incomingHandling?: string;
          outgoingHandoff?: string;
        };
      };
    };
    expect(list.ok).toBe(true);
    expect(list.data.contract).toMatchObject({
      instructions: "implement and gate the change",
      incomingHandling: "reproduce the defect before touching code",
      outgoingHandoff: "name the verified fix and cite the failing test",
    });

    const onboard = (await call(server.socketPath, {
      token: token(),
      op: "onboard",
    })) as {
      ok: true;
      data: {
        connected: Array<{
          id: string;
          title: string;
          board?: { name: string };
          contract?: { incomingHandling?: string; outgoingHandoff?: string };
          next?: Array<{ board: string; name: string; admission?: string }>;
        }>;
      };
    };
    expect(onboard.ok).toBe(true);
    const sinkEntry = onboard.data.connected.find((c) => c.id === "tasks");
    expect(sinkEntry?.title).toBe("implement and gate the change");
    expect(sinkEntry?.board).toEqual({
      name: "implement and gate the change",
    });
    expect(sinkEntry?.contract).toMatchObject({
      incomingHandling: "reproduce the defect before touching code",
      outgoingHandoff: "name the verified fix and cite the failing test",
    });
    expect(sinkEntry?.next).toEqual([
      expect.objectContaining({ board: "review", name: "Tasks review" }),
    ]);

    const renamed = await runtime.runPromise(canvases.read("work-cli"));
    await runtime.runPromise(
      canvases.write("work-cli", {
        ...renamed.doc,
        nodes: renamed.doc.nodes.map((node) =>
          node.id === "tasks"
            ? {
                ...node,
                text: "Build",
                ether: {
                  ...node.ether,
                  tasks: {
                    items: node.ether?.tasks?.items ?? [],
                    ...(node.ether?.tasks ?? {}),
                    name: "Build",
                  },
                },
              }
            : node,
        ),
      }),
    );
    const renamedOnboard = (await call(server.socketPath, {
      token: token(),
      op: "onboard",
    })) as typeof onboard;
    expect(
      renamedOnboard.data.connected.find((entry) => entry.id === "tasks")?.title,
    ).toBe("Build");

    const show = (await call(server.socketPath, {
      token: token(),
      op: "tasks.show",
      args: { target: "tasks", task: "t1" },
    })) as {
      ok: true;
      data: {
        board: { nodeId: string; name: string };
        ambient: {
          boardInstructions?: string;
          incoming?: { handling?: string };
          outgoing?: { handoff?: string };
        };
      };
    };
    expect(show.ok).toBe(true);
    expect(show.data.board).toEqual({
      nodeId: "tasks",
      name: "Build",
    });
    expect(show.data.ambient).toMatchObject({
      boardInstructions: "implement and gate the change",
      incoming: { handling: "reproduce the defect before touching code" },
      outgoing: { handoff: "name the verified fix and cite the failing test" },
    });
  });

  it("blank handling never surfaces and handoff drops at a terminal board", async () => {
    const server = servers[0]!;
    const runtime = runtimes.at(-1)!;
    const canvases = await runtime.runPromise(CanvasesService);
    const current = await runtime.runPromise(canvases.read("work-cli"));
    // Same contract, but no flow edge: the board is terminal, and the
    // authored handling is whitespace-only (JSON Canvas can hold that even
    // though the editor normalizes it away).
    await runtime.runPromise(
      canvases.write("work-cli", {
        ...current.doc,
        nodes: current.doc.nodes.map((node) =>
          node.id === "tasks"
            ? {
                ...node,
                ether: {
                  ...node.ether,
                  tasks: {
                    ...node.ether?.tasks,
                    items: node.ether?.tasks?.items ?? [],
                    contract: {
                      instructions: "  close the work  ",
                      incoming: { handling: "   " },
                      outgoing: { handoff: "hand off cleanly" },
                    },
                  },
                },
              }
            : node,
        ),
      }),
    );

    const list = (await call(server.socketPath, {
      token: token(),
      op: "tasks.list",
      args: { target: "tasks" },
    })) as {
      ok: true;
      data: {
        contract?: {
          instructions?: string;
          incomingHandling?: string;
          outgoingHandoff?: string;
        };
      };
    };
    expect(list.ok).toBe(true);
    expect(list.data.contract?.instructions).toBe("close the work");
    expect(list.data.contract?.incomingHandling).toBeUndefined();
    expect(list.data.contract?.outgoingHandoff).toBeUndefined();

    const show = (await call(server.socketPath, {
      token: token(),
      op: "tasks.show",
      args: { target: "tasks", task: "t1" },
    })) as {
      ok: true;
      data: {
        ambient: {
          incoming?: { handling?: string };
          outgoing?: { handoff?: string };
        };
      };
    };
    expect(show.ok).toBe(true);
    expect(show.data.ambient.incoming).toBeUndefined();
    expect(show.data.ambient.outgoing).toBeUndefined();
  });
});

// Ensure chmod pattern matches browser control
void chmodSync;
