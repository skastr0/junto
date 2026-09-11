import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  encodeWorkFrame,
  workControlTokenPath,
} from "../src/shared/work-control";
import {
  CanvasError,
  CanvasesService,
} from "../src/main/vellum-command/canvases";
import {
  WorkService,
  type WorkServiceShape,
} from "../src/main/vellum-command/work/service";
import { PausePlaneAllPlaying } from "../src/main/vellum-command/pause-plane";
import {
  makeProcessIdentityMap,
  type ProcessIdentityMap,
  type ProcessPrincipal,
} from "../src/main/vellum-command/process-identity";
import {
  startWorkControlServer,
  type WorkControlServer,
} from "../src/main/vellum-command/work/control";
import { createMainAuthoringGate } from "../src/main/vellum-command/main-authoring-gate";
import {
  canvasAuthorityMaterialFixture,
} from "./helpers/canvas-authority-material";

const PEER_PID = 71_003;
const NEAR_ANCHOR_PID = 71_002;
const FAR_ANCHOR_PID = 71_001;
const UNRELATED_PID = 72_001;

const PRINCIPAL: ProcessPrincipal = Object.freeze({
  agentKey: "local:revocation-agent",
  bindingId: "binding-revocation-agent",
  canvasName: "revocation",
  nodeId: "agent",
});

const doc: CanvasDoc = {
  nodes: [
    {
      id: "agent",
      type: "text",
      x: 0,
      y: 0,
      width: 180,
      height: 60,
      text: "revocation agent",
      ether: {
        entity: { kind: "agent", name: PRINCIPAL.agentKey },
        terminal: {
          bindingId: PRINCIPAL.bindingId!,
          harness: "claude",
          launch: { kind: "harness", argv: ["claude"] },
        },
      },
    },
  ],
  edges: [],
};

const deferred = <A>() => {
  let resolve!: (value: A | PromiseLike<A>) => void;
  const promise = new Promise<A>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

interface DispatchGate {
  readonly wait: Effect.Effect<void>;
  readonly entered: Promise<void>;
  readonly release: () => void;
  readonly interruptions: () => number;
}

const makeDispatchGate = (): DispatchGate => {
  const entered = deferred<void>();
  let resume: ((effect: Effect.Effect<void>) => void) | undefined;
  let interrupted = 0;
  const wait = Effect.callback<void>((continueWith) => {
    resume = continueWith;
    entered.resolve();
    return Effect.sync(() => {
      interrupted += 1;
    });
  });
  return {
    wait,
    entered: entered.promise,
    release: () => resume?.(Effect.void),
    interruptions: () => interrupted,
  };
};

interface TrackedProcessMap {
  readonly map: ProcessIdentityMap;
  readonly activeSubscribers: () => number;
  readonly deliveredNotifications: () => number;
  readonly subscribeCalls: () => number;
}

const makeTrackedProcessMap = (
  parents: ReadonlyMap<number, number | undefined>,
): TrackedProcessMap => {
  const base = makeProcessIdentityMap({
    processAlive: () => true,
    readProcessStartKey: (pid) => `generation:${pid}`,
    readParentPid: (pid) => parents.get(pid),
  });
  let active = 0;
  let delivered = 0;
  let subscriptions = 0;
  const map: ProcessIdentityMap = {
    ...base,
    subscribe: (listener) => {
      subscriptions += 1;
      active += 1;
      let subscribed = true;
      const unsubscribeBase = base.subscribe((principal) => {
        delivered += 1;
        listener(principal);
      });
      return () => {
        if (!subscribed) return;
        subscribed = false;
        active -= 1;
        unsubscribeBase();
      };
    },
  };
  return {
    map,
    activeSubscribers: () => active,
    deliveredNotifications: () => delivered,
    subscribeCalls: () => subscriptions,
  };
};

const canvasesService = CanvasesService.of({
  doctor: Effect.succeed({
    id: "canvases",
    label: "Canvases",
    status: "ok",
    detail: "revocation test",
  }),
  list: Effect.succeed([]),
  read: (name) =>
    Effect.succeed({
      name,
      revision: "a".repeat(64),
      doc,
      actorRefs: [],
      workRevision: "0",
    }),
  readWithIntentWitness: () =>
    Effect.fail(new CanvasError({ message: "not used" })),
  readNodeStructure: () =>
    Effect.fail(new CanvasError({ message: "not used" })),
  write: () => Effect.fail(new CanvasError({ message: "not used" })),
  mutate: () => Effect.fail(new CanvasError({ message: "not used" })),
  mutatePortfolio: () =>
    Effect.fail(new CanvasError({ message: "not used" })),
  canvasOverseerSet: () =>
    Effect.fail(new CanvasError({ message: "not used" })),
  create: () => Effect.fail(new CanvasError({ message: "not used" })),
  remove: () => Effect.fail(new CanvasError({ message: "not used" })),
  ensureSeed: Effect.void,
  writeSidecar: () =>
    Effect.fail(new CanvasError({ message: "not used" })),
  start: () => undefined,
  subscribeChanges: () => () => undefined,
  announceInstalledProjection: () => {},
  liveDocuments: () =>
    Effect.succeed([{ canvasName: "revocation", doc }]),
  liveAuthorityGeneration: () => Effect.succeed("1"),
  authoritySnapshot: () =>
    Effect.succeed({
      generation: "1",
      intentSha256: "a".repeat(64),
      documents: new Map([["revocation", doc]]),
    }),
  authorityMaterialSnapshot: () =>
    Effect.sync(() =>
      canvasAuthorityMaterialFixture("1", new Map([["revocation", doc]])),
    ),
  activeIntentWitness: () =>
    Effect.succeed({
      generation: "1",
      contentSha256: "a".repeat(64),
    }),
  activeActorRefs: () => Effect.succeed([]),
});

const makeWorkService = (
  gate: DispatchGate | undefined,
  onMutation: () => void,
): WorkServiceShape => ({
  commandStatus: Effect.gen(function* () {
    if (gate !== undefined) yield* gate.wait;
    yield* Effect.sync(onMutation);
    return {
      counts: { pending: 0, applied: 0, rejected: 0 },
      pending: [],
      rejections: [],
      truncated: { pending: false, rejections: false },
    };
  }),
} as unknown as WorkServiceShape);

interface DisposableRuntime {
  readonly dispose: () => Promise<void>;
}

interface Rig {
  readonly root: string;
  readonly server: WorkControlServer;
  readonly runtime: DisposableRuntime;
  readonly identities: TrackedProcessMap;
  readonly mutations: () => number;
  readonly callDoctor: () => Promise<unknown>;
}

const rigs: Rig[] = [];

const call = (socketPath: string, body: unknown): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("work control response timed out"));
    }, 5_000);
    socket.on("connect", () => socket.write(encodeWorkFrame(body)));
    socket.on("data", (chunk: Buffer | string) => {
      buffer = Buffer.concat([
        buffer,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      clearTimeout(timer);
      const frame = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      socket.destroy();
      resolve(frame);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

const startRig = async (options: {
  readonly gate?: DispatchGate;
  readonly parents?: ReadonlyMap<number, number | undefined>;
  readonly bind?: (map: ProcessIdentityMap) => void;
} = {}): Promise<Rig> => {
  const root = await mkdtemp(join(tmpdir(), "vellum-command-work-revocation-"));
  const workHome = join(root, "work");
  mkdirSync(workHome, { recursive: true });

  const parents = options.parents ?? new Map([
    [PEER_PID, NEAR_ANCHOR_PID],
    [NEAR_ANCHOR_PID, undefined],
  ]);
  const identities = makeTrackedProcessMap(parents);
  (options.bind ?? ((map) => {
    expect(map.bind(NEAR_ANCHOR_PID, PRINCIPAL)).toBe(true);
  }))(identities.map);

  let mutations = 0;
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(CanvasesService, canvasesService),
      Layer.succeed(
        WorkService,
        makeWorkService(options.gate, () => {
          mutations += 1;
        }),
      ),
      PausePlaneAllPlaying,
    ),
  );
  const server = await startWorkControlServer({
    version: "revocation-test",
    home: root,
    workHome,
    processMap: identities.map,
    readPeerPid: () => PEER_PID,
    run: (effect) => runtime.runPromise(effect),
    authoringGate: createMainAuthoringGate(),
  });
  const callDoctor = () =>
    call(server.socketPath, {
      token: readFileSync(workControlTokenPath(workHome), "utf8").trim(),
      op: "doctor",
    });
  const rig: Rig = {
    root,
    server,
    runtime,
    identities,
    mutations: () => mutations,
    callDoctor,
  };
  rigs.push(rig);
  return rig;
};

afterEach(async () => {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig === undefined) continue;
    await rig.server.close();
    await rig.runtime.dispose();
    await rm(rig.root, { recursive: true, force: true });
  }
});

const nextTurn = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

describe("work control process revocation", () => {
  it("interrupts a dispatch gate when the admitted principal is no longer current", async () => {
    const gate = makeDispatchGate();
    const parents = new Map<number, number | undefined>([
      [PEER_PID, NEAR_ANCHOR_PID],
      [NEAR_ANCHOR_PID, FAR_ANCHOR_PID],
      [FAR_ANCHOR_PID, undefined],
    ]);
    const rig = await startRig({
      gate,
      parents,
      bind: (map) => {
        expect(map.bind(FAR_ANCHOR_PID, {
          ...PRINCIPAL,
          bindingId: "replacement-binding",
        })).toBe(true);
        expect(map.bind(NEAR_ANCHOR_PID, PRINCIPAL)).toBe(true);
      },
    });

    const responsePromise = rig.callDoctor();
    await gate.entered;
    expect(rig.identities.activeSubscribers()).toBe(1);

    rig.identities.map.unbind(NEAR_ANCHOR_PID);
    await nextTurn();
    gate.release();

    const response = await responsePromise as {
      readonly ok: false;
      readonly error: {
        readonly type: string;
        readonly message: string;
        readonly details?: { readonly retryable?: boolean };
      };
    };
    expect(response).toMatchObject({
      ok: false,
      error: {
        type: "AuthError",
        details: { retryable: false },
      },
    });
    expect(response.error.message).toMatch(/identity.*stale/i);
    expect(gate.interruptions()).toBe(1);
    expect(rig.mutations()).toBe(0);
    expect(rig.identities.activeSubscribers()).toBe(0);
  });

  it("allows a normal operation and removes its revocation subscriber", async () => {
    const rig = await startRig();

    const response = await rig.callDoctor() as { readonly ok: boolean };

    expect(response.ok).toBe(true);
    expect(rig.mutations()).toBe(1);
    expect(rig.identities.subscribeCalls()).toBe(1);
    expect(rig.identities.activeSubscribers()).toBe(0);

    const deliveredBeforeCleanupProbe =
      rig.identities.deliveredNotifications();
    expect(rig.identities.map.bind(UNRELATED_PID, {
      agentKey: "local:unrelated-after-completion",
    })).toBe(true);
    rig.identities.map.unbind(UNRELATED_PID);
    expect(rig.identities.deliveredNotifications()).toBe(
      deliveredBeforeCleanupProbe,
    );
  });

  it("does not cancel for an unrelated principal lifecycle notification", async () => {
    const gate = makeDispatchGate();
    const rig = await startRig({ gate });
    expect(rig.identities.map.bind(UNRELATED_PID, {
      agentKey: "local:unrelated",
    })).toBe(true);

    let settled = false;
    const responsePromise = rig.callDoctor().finally(() => {
      settled = true;
    });
    await gate.entered;

    rig.identities.map.unbind(UNRELATED_PID);
    await nextTurn();
    expect(settled).toBe(false);
    expect(rig.identities.activeSubscribers()).toBe(1);

    gate.release();
    const response = await responsePromise as { readonly ok: boolean };
    expect(response.ok).toBe(true);
    expect(rig.mutations()).toBe(1);
    expect(gate.interruptions()).toBe(0);
    expect(rig.identities.activeSubscribers()).toBe(0);
  });

  it("keeps authority when one of two same-principal ancestry anchors is removed", async () => {
    const gate = makeDispatchGate();
    const parents = new Map<number, number | undefined>([
      [PEER_PID, NEAR_ANCHOR_PID],
      [NEAR_ANCHOR_PID, FAR_ANCHOR_PID],
      [FAR_ANCHOR_PID, undefined],
    ]);
    const rig = await startRig({
      gate,
      parents,
      bind: (map) => {
        expect(map.bind(FAR_ANCHOR_PID, PRINCIPAL)).toBe(true);
        expect(map.bind(NEAR_ANCHOR_PID, PRINCIPAL)).toBe(true);
      },
    });

    let settled = false;
    const responsePromise = rig.callDoctor().finally(() => {
      settled = true;
    });
    await gate.entered;

    rig.identities.map.unbind(NEAR_ANCHOR_PID);
    await nextTurn();
    expect(settled).toBe(false);
    expect(rig.identities.activeSubscribers()).toBe(1);

    gate.release();
    const response = await responsePromise as { readonly ok: boolean };
    expect(response.ok).toBe(true);
    expect(rig.mutations()).toBe(1);
    expect(gate.interruptions()).toBe(0);
    expect(rig.identities.activeSubscribers()).toBe(0);
  });
});
