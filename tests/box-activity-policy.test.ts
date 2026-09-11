import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import type { CanvasReadResult } from "../src/shared/ipc";
import {
  deriveBoxHostActivity,
  makeBoxActivityReconciler,
  type BoxActivitySource,
} from "../src/main/vellum-command/box/activity-policy";
import { BoxId } from "../src/main/vellum-command/box/domain";
import { boxHostId, type BoxResource } from "../src/main/vellum-command/box/repository";

const workerSeatId = Schema.decodeUnknownSync(ActorSeatId)(
  `seat_${"a".repeat(64)}`,
);

const read = (
  state: "submitted" | "working" | "input-required" | "completed",
  options: {
    readonly actorHost?: string;
    readonly includeActorRef?: boolean;
    readonly name?: string;
  } = {},
): CanvasReadResult => ({
  name: options.name ?? "factory",
  revision: "revision",
  workRevision: "work-revision",
  actorRefs:
    options.includeActorRef === false
      ? []
      : [
          {
            seatId: workerSeatId,
            canvasName: options.name ?? "factory",
            nodeId: "worker",
          },
        ],
  doc: {
    nodes: [
      {
        id: "worker",
        type: "text",
        x: 0,
        y: 0,
        width: 200,
        height: 80,
        text: "worker",
        ether: {
          entity: { kind: "agent", name: "worker" },
          ...(options.actorHost === undefined
            ? {}
            : { host: options.actorHost }),
        },
      },
      {
        id: "tasks",
        type: "text",
        x: 240,
        y: 0,
        width: 200,
        height: 80,
        text: "tasks",
        ether: {
          entity: { kind: "task", name: "tasks" },
          tasks: {
            items: [
              {
                id: "task-1",
                state,
                ...(state === "submitted"
                  ? {}
                  : { claimedBy: workerSeatId }),
                history: [],
              },
            ],
          },
        },
      },
      {
        id: "placed-note",
        type: "text",
        x: 480,
        y: 0,
        width: 200,
        height: 80,
        text: "placement is not activity",
        ether: { host: "box-note-only" },
      },
    ],
    edges: [],
  },
});

describe("Box activity policy", () => {
  it("pins only the host of an actor with active claimed work", () => {
    expect(
      deriveBoxHostActivity([
        read("working", { actorHost: "box-worker" }),
      ]),
    ).toEqual({
      activeHostIds: new Set(["box-worker"]),
      hasUnresolvedActiveWork: false,
    });
  });

  it.each(["submitted", "completed"] as const)(
    "does not treat %s work or mere placement as activity",
    (state) => {
      expect(
        deriveBoxHostActivity([
          read(state, { actorHost: "box-worker" }),
        ]),
      ).toEqual({
        activeHostIds: new Set(),
        hasUnresolvedActiveWork: false,
      });
    },
  );

  it("keeps machines awake when active work cannot resolve an exact host", () => {
    expect(
      deriveBoxHostActivity([
        read("input-required", {
          actorHost: "box-worker",
          includeActorRef: false,
        }),
      ]),
    ).toEqual({
      activeHostIds: new Set(),
      hasUnresolvedActiveWork: true,
    });
  });
});

const ALPHA_BOX = Schema.decodeUnknownSync(BoxId)("bx_aaaaaaaa");
const BETA_BOX = Schema.decodeUnknownSync(BoxId)("bx_bbbbbbbb");

const box = (id: BoxId): BoxResource => ({
  machine: {
    id,
    name: id,
    ip: null,
    state: "ready",
    createdAt: null,
    updatedAt: null,
  },
  enrolledAt: "2026-01-01T00:00:00.000Z",
});

type Harness = {
  readonly source: BoxActivitySource;
  /** Canvas name per `readCanvas` call, in call order. */
  readonly reads: Array<string>;
  readonly demands: Array<`${string}:${boolean}`>;
  readonly docs: Map<string, CanvasReadResult>;
  /** Canvases whose read fails, standing in for a mid-write decode failure. */
  readonly failing: Set<string>;
  readonly setRole: (role: string) => void;
};

const harness = (
  seed: ReadonlyArray<CanvasReadResult>,
  boxes: ReadonlyArray<BoxResource>,
): Harness => {
  const reads: Array<string> = [];
  const demands: Array<`${string}:${boolean}`> = [];
  const docs = new Map(seed.map((doc) => [doc.name, doc]));
  const failing = new Set<string>();
  let role = "command-center";

  const source: BoxActivitySource = {
    stationRole: Effect.sync(() => role),
    listCanvasNames: Effect.sync(() => [...docs.keys()]),
    readCanvas: (name) =>
      Effect.suspend(() => {
        reads.push(name);
        if (failing.has(name)) return Effect.fail(`read failed: ${name}`);
        const doc = docs.get(name);
        return doc === undefined
          ? Effect.fail(`missing canvas: ${name}`)
          : Effect.succeed(doc);
      }),
    listBoxes: Effect.sync(() => boxes),
    setActivityDemand: (boxId, demanded) =>
      Effect.sync(() => {
        demands.push(`${boxId}:${demanded}`);
      }),
  };
  return {
    source,
    reads,
    demands,
    docs,
    failing,
    setRole: (next) => {
      role = next;
    },
  };
};

const activeOn = (canvasName: string, hostId: string): CanvasReadResult =>
  read("working", { name: canvasName, actorHost: hostId });

const idleOn = (canvasName: string): CanvasReadResult =>
  read("completed", { name: canvasName, actorHost: "box-unused" });

describe("Box activity reconcile scope", () => {
  it("sweeps every canvas on the first pass", async () => {
    const stubs = harness(
      [activeOn("alpha", boxHostId(ALPHA_BOX)), idleOn("beta")],
      [box(ALPHA_BOX), box(BETA_BOX)],
    );
    const reconciler = await Effect.runPromise(
      makeBoxActivityReconciler(stubs.source),
    );

    await Effect.runPromise(reconciler.reconcile);

    expect(stubs.reads).toEqual(["alpha", "beta"]);
    expect(stubs.demands).toEqual([`${ALPHA_BOX}:true`, `${BETA_BOX}:false`]);
  });

  it("re-reads only the canvas that changed", async () => {
    const stubs = harness(
      [activeOn("alpha", boxHostId(ALPHA_BOX)), idleOn("beta")],
      [box(ALPHA_BOX), box(BETA_BOX)],
    );
    const reconciler = await Effect.runPromise(
      makeBoxActivityReconciler(stubs.source),
    );
    await Effect.runPromise(reconciler.reconcile);
    stubs.reads.length = 0;

    reconciler.invalidate("alpha");
    await Effect.runPromise(reconciler.reconcile);

    // The defect this guards: a listener that discards the canvas name makes
    // one commit cost one read per canvas in the portfolio.
    expect(stubs.reads).toEqual(["alpha"]);
  });

  it("answers a burst across canvases in one pass, forgetting neither", async () => {
    const stubs = harness(
      [activeOn("alpha", boxHostId(ALPHA_BOX)), idleOn("beta")],
      [box(ALPHA_BOX), box(BETA_BOX)],
    );
    const reconciler = await Effect.runPromise(
      makeBoxActivityReconciler(stubs.source),
    );
    await Effect.runPromise(reconciler.reconcile);
    stubs.reads.length = 0;
    stubs.demands.length = 0;

    // Work moves off alpha and onto beta between passes.
    stubs.docs.set("alpha", idleOn("alpha"));
    stubs.docs.set("beta", activeOn("beta", boxHostId(BETA_BOX)));
    reconciler.invalidate("alpha");
    reconciler.invalidate("beta");
    await Effect.runPromise(reconciler.reconcile);

    expect(stubs.reads).toEqual(["alpha", "beta"]);
    expect(stubs.demands).toEqual([`${ALPHA_BOX}:false`, `${BETA_BOX}:true`]);
  });

  it("keeps every Box awake while a canvas has never been read", async () => {
    const stubs = harness(
      [idleOn("alpha"), idleOn("beta")],
      [box(ALPHA_BOX), box(BETA_BOX)],
    );
    stubs.failing.add("beta");
    const reconciler = await Effect.runPromise(
      makeBoxActivityReconciler(stubs.source),
    );

    await Effect.runPromise(reconciler.reconcile);

    // beta's content is unknown, so no owned Box may be authorized to sleep.
    expect(stubs.demands).toEqual([`${ALPHA_BOX}:true`, `${BETA_BOX}:true`]);

    // A canvas with no cached contribution is retried by the next pass even
    // though nothing invalidated it, so a transient read failure self-heals.
    stubs.failing.delete("beta");
    stubs.reads.length = 0;
    stubs.demands.length = 0;
    await Effect.runPromise(reconciler.reconcile);

    expect(stubs.reads).toEqual(["beta"]);
    expect(stubs.demands).toEqual([`${ALPHA_BOX}:false`, `${BETA_BOX}:false`]);
  });

  it("drops the contribution of a canvas that no longer exists", async () => {
    const stubs = harness(
      [idleOn("alpha"), activeOn("beta", boxHostId(BETA_BOX))],
      [box(ALPHA_BOX), box(BETA_BOX)],
    );
    const reconciler = await Effect.runPromise(
      makeBoxActivityReconciler(stubs.source),
    );
    await Effect.runPromise(reconciler.reconcile);
    expect(stubs.demands).toEqual([`${ALPHA_BOX}:false`, `${BETA_BOX}:true`]);
    stubs.reads.length = 0;
    stubs.demands.length = 0;

    stubs.docs.delete("beta");
    reconciler.invalidate("beta");
    await Effect.runPromise(reconciler.reconcile);

    // A deleted canvas cannot be read, and its cached demand must not survive.
    expect(stubs.reads).toEqual([]);
    expect(stubs.demands).toEqual([`${BETA_BOX}:false`]);
  });

  it("rebuilds from every canvas after the station stops being a command center", async () => {
    const stubs = harness(
      [activeOn("alpha", boxHostId(ALPHA_BOX)), idleOn("beta")],
      [box(ALPHA_BOX), box(BETA_BOX)],
    );
    const reconciler = await Effect.runPromise(
      makeBoxActivityReconciler(stubs.source),
    );
    await Effect.runPromise(reconciler.reconcile);
    stubs.reads.length = 0;
    stubs.demands.length = 0;

    stubs.setRole("station");
    await Effect.runPromise(reconciler.reconcile);
    expect(stubs.reads).toEqual([]);
    expect(stubs.demands).toEqual([]);

    // Nothing on a canvas committed while the role was away, so only a sweep
    // can restore the view — and the applied-demand memo must not suppress it.
    stubs.setRole("command-center");
    await Effect.runPromise(reconciler.reconcile);
    expect(stubs.reads).toEqual(["alpha", "beta"]);
    expect(stubs.demands).toEqual([`${ALPHA_BOX}:true`, `${BETA_BOX}:false`]);
  });
});
