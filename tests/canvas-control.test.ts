import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { createConnection, createServer as createNetServer } from "node:net";
import {
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { CanvasDoc } from "../src/shared/canvas";
import { defaultSettings, type Settings } from "../src/shared/settings";
import {
  CanvasError,
  CanvasesService,
} from "../src/main/vellum/canvases";
import {
  canvasControlAuthorialPermit,
  listCanvasesThroughControl,
  readCanvasThroughControl,
  removeCanvasThroughControl,
} from "../src/main/vellum/canvas-control/client";
import {
  CANVAS_CONTROL_PROTOCOL_VERSION,
  decodeCanvasControlResponse,
  encodeCanvasControlFrame,
} from "../src/main/vellum/canvas-control/protocol";
import {
  startCanvasControlServer,
  type CanvasControlServer,
  type CanvasControlServerRuntime,
} from "../src/main/vellum/canvas-control/server";
import { createMainAuthoringGate } from "../src/main/vellum/main-authoring-gate";
import type {
  ProcessIdentityMap,
  ProcessPrincipal,
} from "../src/main/vellum/process-identity";
import { SettingsService } from "../src/main/vellum/settings/service";
import { SnapshotsService } from "../src/main/vellum/snapshots";

const roots: string[] = [];
const servers: CanvasControlServer[] = [];
const runtimes: Array<ManagedRuntime.ManagedRuntime<unknown, never>> = [];

const doc = (text = "hello"): CanvasDoc => ({
  nodes: [
    {
      id: "note",
      type: "text",
      text,
      x: 0,
      y: 0,
      width: 220,
      height: 84,
    },
  ],
  edges: [],
});

const processMap = (
  principal: () => ProcessPrincipal | undefined,
): ProcessIdentityMap => ({
  bind: () => false,
  unbind: () => undefined,
  unbindPrincipal: () => undefined,
  unbindAgentKey: () => undefined,
  unbindTerminalBinding: () => undefined,
  resolve: () => principal(),
  resolveInTree: () => principal(),
  clear: () => undefined,
  size: () => (principal() === undefined ? 0 : 1),
  snapshot: () => [],
  subscribe: () => () => undefined,
});

const commandCenterSettings = (): Settings => {
  const settings = defaultSettings();
  return {
    ...settings,
    station: {
      ...settings.station,
      role: "command-center",
      hostId: "local",
    },
  };
};

const makeRuntime = (input: {
  readonly documents?: Map<string, CanvasDoc>;
  readonly settings: () => Settings;
  readonly afterRemoveCommit?: () => Promise<void>;
}) => {
  const documents = input.documents ?? new Map([["portfolio", doc()]]);
  const modifiedAt = "2026-07-27T12:00:00.000Z";
  const listeners = new Set<(name: string) => void>();
  const canvases = CanvasesService.of({
    doctor: Effect.succeed({
      id: "canvases",
      label: "Canvases",
      status: "ok",
      detail: "test",
    }),
    list: Effect.sync(() =>
      [...documents.keys()].sort().map((name) => ({
        name,
        modifiedAt,
      })),
    ),
    read: (name) => {
      const current = documents.get(name);
      return current === undefined
        ? Effect.fail(
            new CanvasError({
              message: `canvas "${name}" is not in live authority`,
            }),
          )
        : Effect.succeed({
            name,
            revision: "a".repeat(64),
            doc: current,
          });
    },
    write: () => Effect.fail(new CanvasError({ message: "not used" })),
    mutate: () => Effect.fail(new CanvasError({ message: "not used" })),
    create: () => Effect.fail(new CanvasError({ message: "not used" })),
    remove: (name) =>
      Effect.gen(function* () {
        if (!documents.delete(name)) {
          throw new CanvasError({ message: `canvas "${name}" is missing` });
        }
        if (input.afterRemoveCommit !== undefined) {
          yield* Effect.promise(input.afterRemoveCommit);
        }
        for (const listener of listeners) listener(name);
        return { name };
      }),
    ensureSeed: Effect.void,
    writeSidecar: () =>
      Effect.fail(new CanvasError({ message: "not used" })),
    start: () => undefined,
    subscribeChanges: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    liveDocuments: () =>
      Effect.sync(() =>
        [...documents].map(([canvasName, current]) => ({
          canvasName,
          doc: current,
        })),
      ),
    liveAuthorityGeneration: () => Effect.succeed("1"),
    authoritySnapshot: () =>
      Effect.sync(() => ({
        generation: "1",
        documents: new Map(documents),
      })),
  });
  const snapshots = SnapshotsService.of({
    doctor: Effect.succeed({
      id: "snapshots",
      label: "Snapshots",
      status: "ok",
      detail: "test",
    }),
    current: Effect.succeed({
      bundles: [
        {
          source: "hermes",
          fetchedAt: "2026-07-27T12:00:00.000Z",
          ok: true,
          entities: [],
        },
      ],
    }),
    refresh: () => Effect.succeed({ bundles: [] }),
    start: () => undefined,
    subscribe: () => () => undefined,
  });
  const settings = SettingsService.of({
    doctor: Effect.succeed({
      id: "settings",
      label: "Settings",
      status: "ok",
      detail: "test",
    }),
    get: Effect.sync(input.settings),
    patch: () => Effect.succeed(input.settings()),
    setStationTopology: () => Effect.succeed(input.settings()),
    reset: () => Effect.succeed(input.settings()),
    databasePath: () => "/test/vellum.db",
    subscribe: () => () => undefined,
  });
  return ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(CanvasesService, canvases),
      Layer.succeed(SnapshotsService, snapshots),
      Layer.succeed(SettingsService, settings),
    ),
  );
};

const start = async (input: {
  readonly documents?: Map<string, CanvasDoc>;
  readonly runtime?: CanvasControlServerRuntime;
  readonly settings?: () => Settings;
  readonly boundPrincipal?: () => ProcessPrincipal | undefined;
  readonly beforeRun?: () => void | Promise<void>;
  readonly afterRemoveCommit?: () => Promise<void>;
}) => {
  const root = await mkdtemp(join(tmpdir(), "vellum-canvas-control-"));
  roots.push(root);
  const controlHome = join(root, "canvas");
  const runtime = makeRuntime({
    ...(input.documents === undefined ? {} : { documents: input.documents }),
    settings: input.settings ?? commandCenterSettings,
    ...(input.afterRemoveCommit === undefined
      ? {}
      : { afterRemoveCommit: input.afterRemoveCommit }),
  });
  runtimes.push(runtime as ManagedRuntime.ManagedRuntime<unknown, never>);
  const server = await startCanvasControlServer(
    {
      controlHome,
      run: async (effect) => {
        await input.beforeRun?.();
        return runtime.runPromise(effect);
      },
      authoringGate: createMainAuthoringGate(),
      processMap: processMap(input.boundPrincipal ?? (() => undefined)),
      readPeerPid: () => process.pid,
      readParentPid: (pid) => (pid === process.pid ? 1 : undefined),
    },
    input.runtime,
  );
  servers.push(server);
  return { controlHome, server };
};

const rawCall = (
  socketPath: string,
  frame: string,
): Promise<ReturnType<typeof decodeCanvasControlResponse>> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(frame));
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.on("error", reject);
    socket.on("close", () => {
      try {
        resolve(decodeCanvasControlResponse(JSON.parse(response.trim())));
      } catch (error) {
        reject(error);
      }
    });
  });

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
  while (runtimes.length > 0) await runtimes.pop()!.dispose();
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe("canvas control", () => {
  it("serves list and compiled read data through an owner-only socket without a token store", async () => {
    const { controlHome, server } = await start({});
    const [listed, read] = await Promise.all([
      Effect.runPromise(listCanvasesThroughControl({ controlHome })),
      Effect.runPromise(readCanvasThroughControl("portfolio", { controlHome })),
    ]);

    expect(listed).toEqual([
      {
        name: "portfolio",
        modifiedAt: "2026-07-27T12:00:00.000Z",
        nodes: 1,
        edges: 0,
      },
    ]);
    expect(read.doc.nodes[0]?.id).toBe("note");
    expect(read.snapshots.bundles[0]?.source).toBe("hermes");
    expect((await stat(controlHome)).mode & 0o777).toBe(0o700);
    expect((await stat(server.socketPath)).mode & 0o777).toBe(0o600);
    expect((await readdir(controlHome)).some((name) => /token|\.json$/u.test(name))).toBe(false);
    expect(server.ready()).toBe(true);
  });

  it("requires the explicit witness, rejects attached agents, checks Command Center role, then removes", async () => {
    let bound: ProcessPrincipal | undefined;
    let settings = commandCenterSettings();
    const { controlHome } = await start({
      settings: () => settings,
      boundPrincipal: () => bound,
    });

    const missingWitness = await rawCall(
      join(controlHome, "control.sock"),
      encodeCanvasControlFrame({
        protocol_version: CANVAS_CONTROL_PROTOCOL_VERSION,
        op: "remove",
        args: { name: "portfolio" },
        id: "missing-witness",
      }),
    );
    expect(missingWitness._tag).toBe("Right");
    if (missingWitness._tag === "Right" && !missingWitness.right.ok) {
      expect(missingWitness.right.error.code).toBe("AuthorialWriteDenied");
    }

    const permit = canvasControlAuthorialPermit({
      VELLUM_AUTHORIAL_WRITE: "1",
    });
    bound = { agentKey: "local:worker" };
    const attachedAgent = await Effect.runPromise(
      Effect.either(
        removeCanvasThroughControl("portfolio", permit, { controlHome }),
      ),
    );
    expect(attachedAgent._tag).toBe("Left");
    if (attachedAgent._tag === "Left") {
      expect(attachedAgent.left.message).toContain("attached agent");
    }

    bound = undefined;
    settings = {
      ...settings,
      station: { ...settings.station, role: "remote" },
    };
    const remote = await Effect.runPromise(
      Effect.either(
        removeCanvasThroughControl("portfolio", permit, { controlHome }),
      ),
    );
    expect(remote._tag).toBe("Left");
    if (remote._tag === "Left") {
      expect(remote.left.message).toContain("Remote");
    }

    settings = commandCenterSettings();
    await expect(
      Effect.runPromise(
        removeCanvasThroughControl("portfolio", permit, { controlHome }),
      ),
    ).resolves.toEqual({ name: "portfolio" });
    await expect(
      Effect.runPromise(listCanvasesThroughControl({ controlHome })),
    ).resolves.toEqual([]);
  });

  it("fails removal closed when peer ancestry cannot be proven", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-canvas-control-"));
    roots.push(root);
    const runtime = makeRuntime({ settings: commandCenterSettings });
    runtimes.push(runtime as ManagedRuntime.ManagedRuntime<unknown, never>);
    const server = await startCanvasControlServer({
      controlHome: join(root, "canvas"),
      run: (effect) => runtime.runPromise(effect),
      authoringGate: createMainAuthoringGate(),
      processMap: processMap(() => undefined),
      readPeerPid: () => process.pid,
      readParentPid: () => undefined,
    });
    servers.push(server);

    const result = await Effect.runPromise(
      Effect.either(
        removeCanvasThroughControl(
          "portfolio",
          canvasControlAuthorialPermit({ VELLUM_AUTHORIAL_WRITE: "1" }),
          { controlHome: server.controlHome },
        ),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.code).toBe("AuthorialWriteDenied");
      expect(result.left.message).toContain("ancestry");
    }
  });

  it("rejects oversized or multiple request frames and bounds responses", async () => {
    const documents = new Map([["portfolio", doc("x".repeat(4_096))]]);
    const { controlHome, server } = await start({
      documents,
      runtime: { maxRequestBytes: 256, maxResponseBytes: 512 },
    });

    const oversized = await rawCall(
      server.socketPath,
      `${"x".repeat(300)}\n`,
    );
    expect(oversized._tag).toBe("Right");
    if (oversized._tag === "Right") {
      expect(oversized.right.ok).toBe(false);
      if (!oversized.right.ok) {
        expect(oversized.right.error.code).toBe("ProtocolError");
      }
    }

    const valid = encodeCanvasControlFrame({
      protocol_version: CANVAS_CONTROL_PROTOCOL_VERSION,
      op: "list",
      args: {},
      id: "one",
    });
    const multiple = await rawCall(server.socketPath, `${valid}${valid}`);
    expect(multiple._tag).toBe("Right");
    if (multiple._tag === "Right" && !multiple.right.ok) {
      expect(multiple.right.error.code).toBe("ProtocolError");
    }

    const response = await Effect.runPromise(
      Effect.either(readCanvasThroughControl("portfolio", { controlHome })),
    );
    expect(response._tag).toBe("Left");
    if (response._tag === "Left") {
      expect(response.left.code).toBe("ResponseTooLarge");
    }
  });

  it("validates canvas names locally and rejects excess protocol fields", async () => {
    const local = await Effect.runPromise(
      Effect.either(
        readCanvasThroughControl("../outside", {
          socketPath: "/definitely/missing/canvas-control.sock",
        }),
      ),
    );
    expect(local._tag).toBe("Left");
    if (local._tag === "Left") {
      expect(local.left.code).toBe("InputError");
      expect(local.left.message).toContain("invalid canvas name");
    }

    const { server } = await start({});
    const excessEnvelope = await rawCall(
      server.socketPath,
      encodeCanvasControlFrame({
        protocol_version: CANVAS_CONTROL_PROTOCOL_VERSION,
        op: "list",
        args: {},
        id: "excess-envelope",
        surprise: true,
      }),
    );
    expect(excessEnvelope._tag).toBe("Right");
    if (excessEnvelope._tag === "Right" && !excessEnvelope.right.ok) {
      expect(excessEnvelope.right.error.code).toBe("ProtocolError");
    }

    const excessArgs = await rawCall(
      server.socketPath,
      encodeCanvasControlFrame({
        protocol_version: CANVAS_CONTROL_PROTOCOL_VERSION,
        op: "read",
        args: { name: "portfolio", surprise: true },
        id: "excess-args",
      }),
    );
    expect(excessArgs._tag).toBe("Right");
    if (excessArgs._tag === "Right" && !excessArgs.right.ok) {
      expect(excessArgs.right.error.code).toBe("InputError");
    }
  });

  it("cuts partial-frame admission before shutdown reaches the runtime", async () => {
    let runs = 0;
    const { server } = await start({
      beforeRun: () => {
        runs += 1;
      },
    });
    const socket = createConnection({ path: server.socketPath });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.on("error", () => undefined);
    await once(socket, "connect");
    const closed = once(socket, "close");
    const frame = encodeCanvasControlFrame({
      protocol_version: CANVAS_CONTROL_PROTOCOL_VERSION,
      op: "list",
      args: {},
      id: "partial-cut",
    });
    socket.write(frame.slice(0, -1));
    await new Promise<void>((resolve) => setImmediate(resolve));

    server.beginShutdown();
    socket.write("\n");
    await closed;

    const decoded = decodeCanvasControlResponse(
      JSON.parse(response.trim()) as unknown,
    );
    expect(decoded._tag).toBe("Right");
    if (decoded._tag === "Right" && !decoded.right.ok) {
      expect(decoded.right.error.code).toBe("RuntimeDown");
    }
    expect(runs).toBe(0);
    await expect(server.close()).resolves.toMatchObject({ clean: true });
  });

  it("prepublishes admitted work so synchronous shutdown still flushes its response", async () => {
    let serverRef: CanvasControlServer | undefined;
    let closeFlight:
      | ReturnType<CanvasControlServer["close"]>
      | undefined;
    let reentered = false;
    const started = await start({
      beforeRun: () => {
        if (reentered || serverRef === undefined) return;
        reentered = true;
        serverRef.beginShutdown();
        closeFlight = serverRef.close();
      },
    });
    serverRef = started.server;

    await expect(
      Effect.runPromise(
        listCanvasesThroughControl({ controlHome: started.controlHome }),
      ),
    ).resolves.toHaveLength(1);
    expect(closeFlight).toBeDefined();
    await expect(closeFlight).resolves.toMatchObject({
      clean: true,
      pendingFrames: 0,
      pendingDispatches: 0,
      openSockets: 0,
    });
  });

  it("returns an unclean bounded receipt for hung work and retries to a fixed point", async () => {
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blocked = true;
    const { controlHome, server } = await start({
      runtime: { shutdownDeadlineMs: 40 },
      beforeRun: async () => {
        signalStarted();
        if (blocked) await blocker;
      },
    });
    const client = Effect.runPromise(
      Effect.either(listCanvasesThroughControl({ controlHome })),
    );
    await started;

    const first = await server.close();
    expect(first.clean).toBe(false);
    expect(first.pendingFrames).toBeGreaterThan(0);
    expect(first.pendingDispatches).toBeGreaterThan(0);

    blocked = false;
    release();
    await expect(client).resolves.toMatchObject({ _tag: "Right" });
    const retry = await server.close();
    expect(retry).toMatchObject({
      clean: true,
      pendingFrames: 0,
      pendingDispatches: 0,
      openSockets: 0,
      listenerRetained: false,
      socketPathRetained: false,
    });
  });

  it("keeps an admitted removal response alive across a bounded drain timeout", async () => {
    const documents = new Map([["portfolio", doc()]]);
    let signalCommitted!: () => void;
    const committed = new Promise<void>((resolve) => {
      signalCommitted = resolve;
    });
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { controlHome, server } = await start({
      documents,
      runtime: { shutdownDeadlineMs: 40 },
      afterRemoveCommit: async () => {
        signalCommitted();
        await blocker;
      },
    });
    const client = Effect.runPromise(
      Effect.either(
        removeCanvasThroughControl(
          "portfolio",
          canvasControlAuthorialPermit({ VELLUM_AUTHORIAL_WRITE: "1" }),
          { controlHome },
        ),
      ),
    );
    let clientSettled = false;
    void client.then(() => {
      clientSettled = true;
    });
    await committed;
    expect(documents.has("portfolio")).toBe(false);

    const first = await server.close();
    expect(first.clean).toBe(false);
    expect(first.retainedLabels).toContain("dispatch:remove");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(clientSettled).toBe(false);

    release();
    await expect(client).resolves.toMatchObject({
      _tag: "Right",
      right: { name: "portfolio" },
    });
    await expect(server.close()).resolves.toMatchObject({ clean: true });
  });

  it("preserves a replacement socket path and retries cleanup after repair", async () => {
    const { server } = await start({
      runtime: { shutdownDeadlineMs: 40 },
    });
    const ownedPath = `${server.socketPath}.owned`;
    await rename(server.socketPath, ownedPath);
    const replacement = createNetServer();
    await new Promise<void>((resolve, reject) => {
      replacement.once("error", reject);
      replacement.listen(server.socketPath, () => {
        replacement.off("error", reject);
        resolve();
      });
    });

    try {
      const first = await server.close();
      expect(first.clean).toBe(false);
      expect(first.listenerRetained).toBe(true);
      expect(first.socketPathRetained).toBe(true);
      expect((await stat(server.socketPath)).isSocket()).toBe(true);
    } finally {
      await new Promise<void>((resolve) => replacement.close(() => resolve()));
    }

    await rm(server.socketPath, { force: true });
    await rename(ownedPath, server.socketPath);
    await expect(server.close()).resolves.toMatchObject({
      clean: true,
      listenerRetained: false,
      socketPathRetained: false,
    });
  });

  it("keeps every headless script off direct canvas and Hermes runtimes", async () => {
    const scripts = [
      "canvas-ls.ts",
      "digest.ts",
      "render.ts",
      "ref-cli.ts",
      "canvas-rm.ts",
    ];
    for (const script of scripts) {
      const source = await readFile(join(process.cwd(), "scripts", script), "utf8");
      expect(source).not.toMatch(
        /\b(?:CanvasesLive|CanvasesService|StateEngine|HermesStandaloneLive|ManagedRuntime)\b/u,
      );
      expect(source).not.toMatch(/vellum\/canvases/u);
    }
  });
});
