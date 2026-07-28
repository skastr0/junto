import { chmodSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import {
  createConnection,
  createServer as createNetServer,
  type Server as NetServer,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  WORK_PROTOCOL_VERSION,
  decodeWorkResponse,
  encodeWorkFrame,
  workControlTokenPath,
} from "../src/shared/work-control";
import { CanvasesLive, CanvasesService } from "../src/main/vellum/canvases";
import {
  resolveProcessBoundActorRef,
  startWorkControlServer,
  workControlReadiness,
  type WorkControlRuntime,
  type WorkControlServer,
  type WorkControlServerOptions,
} from "../src/main/vellum/work/control";
import { WorkLive, WorkService } from "../src/main/vellum/work/service";
import {
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum/work/repository";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";
import { StationRepositoryLive } from "../src/main/vellum/station/repository";
import {
  StationFleetTargetRepositoryLive,
} from "../src/main/vellum/station/fleet-target-repository";
import {
  StationLivePeerRegistryLive,
} from "../src/main/vellum/station/session-registry";
import {
  SettingsLive,
  SettingsService,
} from "../src/main/vellum/settings/service";
import { PausePlane, PausePlaneAllPlaying } from "../src/main/vellum/pause-plane";
import { makeProcessIdentityMap } from "../src/main/vellum/process-identity";
import { resetSeatBlocks } from "../src/main/vellum/work/blocked-seat";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  createMainAuthoringGate,
  type MainAuthoringGate,
} from "../src/main/vellum/main-authoring-gate";
import {
  actorRefFixture,
} from "./helpers/actor-ref-fixtures";
import type { ActorRef } from "../src/shared/work-protocol";

const roots: string[] = [];
const servers: WorkControlServer[] = [];
const rogueServers: NetServer[] = [];
const makeWorkTestRuntime = (root: string) => {
  const stateLive = makeStateEngineLive(join(root, "state", "vellum.db"));
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      StationRepositoryLive,
      StationFleetTargetRepositoryLive,
      SettingsLive,
    ),
    stateLive,
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
  ],
  edges: [
    { id: "e1", fromNode: "agent", toNode: "tasks" },
    { id: "e2", fromNode: "agent", toNode: "req" },
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
  await runtime.runPromise(
    repository.createTask({
      sink: { canvasName: "work-cli", nodeId: "tasks" },
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
  readonly decorateRun?: (
    base: WorkControlServerOptions["run"],
  ) => WorkControlServerOptions["run"];
} = {}): Promise<{
  readonly server: WorkControlServer;
  readonly authoringGate: MainAuthoringGate;
}> => {
  const root = await mkdtemp(join(tmpdir(), "vellum-work-ctl-"));
  roots.push(root);
  const canvasesDir = join(root, "canvases");
  const workHome = join(root, "work");
  mkdirSync(canvasesDir, { recursive: true });
  mkdirSync(workHome, { recursive: true });
  process.env.VELLUM_CANVASES_DIR = canvasesDir;
  process.env.VELLUM_WORK_HOME = workHome;

  const runtime = makeWorkTestRuntime(root);
  runtimes.push(runtime);
  // Seed both authorial topology and durable work rows before any hung
  // dispatch so a shutdown timing assertion never includes database startup.
  await seedCanonicalWork(runtime);
  const baseRun: WorkControlServerOptions["run"] = (effect) =>
    runtime.runPromise(effect);

  const processMap = makeProcessIdentityMap();
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
  }, options.runtime);
  servers.push(server);
  return { server, authoringGate };
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
  delete process.env.VELLUM_CANVASES_DIR;
  delete process.env.VELLUM_WORK_HOME;
});

const token = (): string => {
  const workHome = process.env.VELLUM_WORK_HOME!;
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
  it("resolves process-bound callers to exactly one projected actor reference", () => {
    const actor = actorRefFixture("agent", "work-cli");
    const caller = { canvasName: "work-cli", nodeId: "agent" };

    expect(resolveProcessBoundActorRef([actor], caller)).toMatchObject({
      _tag: "Right",
      right: actor,
    });
    expect(resolveProcessBoundActorRef([], caller)).toMatchObject({
      _tag: "Left",
      left: { type: "StaleNodeRef" },
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
      _tag: "Left",
      left: { type: "StaleNodeRef" },
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
    expect(decoded._tag).toBe("Right");
    if (decoded._tag === "Right") {
      expect(decoded.right.ok).toBe(true);
      if (decoded.right.ok) {
        expect((decoded.right.data as { protocol_version: string }).protocol_version).toBe(
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

  it("keeps reads available while returning typed RuntimeDown for authorial ops", async () => {
    const server = servers[0]!;
    const gate = authoringGates[0]!;
    const precommit = gate.beginPrecommit();

    const ping = (await call(server.socketPath, {
      token: token(),
      op: "ping",
    })) as { ok: boolean };
    expect(ping.ok).toBe(true);

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
    expect(refused.error.message).toMatch(/precommit-closed|refused/);
    expect(refused.error.details?.retryable).toBe(false);

    await gate.drain(precommit.epoch);
    gate.recover(precommit.epoch);
    const admitted = (await call(server.socketPath, {
      token: token(),
      op: "tasks.claim",
      args: { target: "tasks", task: "t1" },
    })) as { ok: boolean };
    expect(admitted.ok).toBe(true);
  });

  it("rejects the retired client nodeRef field", async () => {
    const server = servers[0]!;
    const response = (await call(server.socketPath, {
      token: token(),
      nodeRef: "vellum://canvas/other?node=impostor",
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
    expect(response.error.message).toContain("unexpected");
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
    expect(response.error.message).toContain("unexpected");
    expect(response.error.details).toMatchObject({
      path: "args",
      retryable: false,
    });
  });

  it("denies an unbound peer", async () => {
    // Spin a one-off server with empty process map.
    const root = await mkdtemp(join(tmpdir(), "vellum-work-unbound-"));
    roots.push(root);
    const workHome = join(root, "work");
    const canvasesDir = join(root, "canvases");
    mkdirSync(workHome, { recursive: true });
    mkdirSync(canvasesDir, { recursive: true });
    process.env.VELLUM_CANVASES_DIR = canvasesDir;
    process.env.VELLUM_WORK_HOME = workHome;
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
  });

  it("denies task updates from a connected actor that does not own the claim", async () => {
    const runtime = runtimes.at(-1);
    if (runtime === undefined) throw new Error("missing work-control runtime");
    const caller = await projectedProcessActor();
    const other = actorRefFixture("other-agent", "work-cli");
    const repository = await runtime.runPromise(WorkRepository);
    await runtime.runPromise(
      repository.claimLocalTask({
        sink: { canvasName: "work-cli", nodeId: "tasks" },
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
    expect(snapshot.tasks.items.find((task) => task.id === "t1")).toMatchObject({
      state: "working",
      claimedBy: other.seatId,
    });
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
    expect(res.data.connected.map((c) => c.id)).toEqual(["req", "tasks"]);
    expect(res.data.connected.find((c) => c.id === "tasks")?.grants).toContain(
      "tasks.claim",
    );
    expect(res.data.connected.find((c) => c.id === "req")?.grants).toContain(
      "request.create",
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
});

// Ensure chmod pattern matches browser control
void chmodSync;
