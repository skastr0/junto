/**
 * The GPU canvas's loom (architecture section 13), on the feed's side: it
 * follows the model's card rectangles and wires and hands each settled board
 * to the planner (feed/loom-planner.ts), whose facts come back as `routes`
 * ops.
 *
 * Routing never runs on the boot path (issue 912). The planner runs in
 * workers (feed/loom-worker.ts) where the page has them, one per spare core,
 * each routing its own share of the wires; in slices on the page otherwise; either way the observer only collects rows and posts them,
 * so the first frame never waits on a route. The wires nearest the view are
 * routed first (`setWireRouteView`), and the engine draws a wire only once
 * its route has landed, fading it in.
 */
import { observe } from "@legendapp/state";
import type { Rect, SceneOp } from "../contract";
import { modelStore } from "../../lib/use-model";
import { cardOf, type LoomCard, type LoomUpdate, type LoomWireRow } from "./loom-planner";
import { packCards, packWireShares } from "./loom-board";
import { createLoomRun, type LoomRequest } from "./loom-run";

export { createLoomPlanner, cardOf, type LoomCard, type LoomPlanner, type LoomUpdate, type LoomWireRow } from "./loom-planner";

/** Where the planner runs: a worker, or slices on the page. */
type LoomHost = {
  readonly request: (request: LoomRequest) => void;
  readonly dispose: () => void;
};

/**
 * A browser page runs the planner in a worker. The test runner has no
 * OffscreenCanvas, as the atlas's raster workers also read it, and runs it
 * in slices on its own thread.
 */
const inWorker = (): boolean => typeof Worker === "function" && typeof OffscreenCanvas === "function";

const pageHost = (send: (update: LoomUpdate) => void): LoomHost =>
  createLoomRun(send, () => performance.now(), (next) => setTimeout(next, 0));

/**
 * How many workers route side by side: every core the device reports but
 * two, one for the page's own thread and one for the GPU and compositor
 * process, and at least one. A route is pure, so the shares never wait on
 * each other. A design value over the device's count.
 */
export const loomWorkerCount = (cores: number): number => Math.max(1, Math.floor(cores) - 2);

const deviceCores = (): number => (typeof navigator === "object" && navigator.hardwareConcurrency > 0 ? navigator.hardwareConcurrency : 1);

/** The workers the open canvas routes in, for the boot measurement; 0 on the page. */
let workersNow = 0;
export const loomWorkers = (): number => workersNow;

/**
 * What the loom has done on the open canvas, for the boot measurement: each
 * run's last counters, by share, and the page's own time handing each slice's
 * facts to the engine. Read through the test hook.
 */
const shareStats = new Map<number, NonNullable<LoomUpdate["stats"]>>();
let applied = { slices: 0, facts: 0, ms: 0 };
export const loomStats = (): { readonly shares: ReadonlyArray<NonNullable<LoomUpdate["stats"]>>; readonly applied: typeof applied } => ({
  shares: [...shareStats.values()].sort((a, b) => a.share - b.share),
  applied: { ...applied },
});

const workerHost = (send: (update: LoomUpdate) => void): LoomHost => {
  const count = loomWorkerCount(deviceCores());
  const workers: Worker[] = [];
  let fallback: LoomHost | undefined;
  let last: Extract<LoomRequest, { kind: "plan" }> | undefined;
  let lastView: Rect | undefined;
  const fail = (message: string): void => {
    // A worker that cannot start: the page routes the whole board instead,
    // from the last board and view.
    console.error("loom worker error:", message);
    for (const worker of workers) worker.terminate();
    workersNow = 0;
    if (fallback !== undefined) return;
    fallback = pageHost(send);
    if (last !== undefined) fallback.request(lastView === undefined || last.view !== undefined ? last : { ...last, view: lastView });
  };
  for (let index = 0; index < count; index += 1) {
    const worker = new Worker(new URL("./loom-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<LoomUpdate>) => send(event.data);
    worker.onerror = (event) => fail(event.message);
    worker.postMessage({ kind: "share", index, count } satisfies LoomRequest);
    workers.push(worker);
  }
  workersNow = count;
  return {
    request: (request) => {
      if (request.kind === "plan") last = request;
      if (request.kind === "focus") lastView = request.view;
      if (fallback !== undefined) {
        fallback.request(request);
        return;
      }
      if (request.kind !== "plan") {
        for (const worker of workers) worker.postMessage(request);
        return;
      }
      // The board is packed once: each worker is posted every card as flat
      // memory and only the wires of its own share.
      const cards = packCards(request.cards);
      const shares = packWireShares(request.wires, workers.length);
      for (const [index, worker] of workers.entries()) {
        worker.postMessage({
          kind: "board",
          cards,
          wires: shares[index]!,
          ...(request.view === undefined ? {} : { view: request.view }),
        } satisfies LoomRequest);
      }
    },
    dispose: () => {
      for (const worker of workers) worker.terminate();
      workersNow = 0;
      fallback?.dispose();
    },
  };
};

/** The open canvas's view on the board, as the shell last drew it. */
let routeView: Rect | undefined;

/** The view the loom routes outwards from, for the boot measurement. */
export const wireRouteView = (): Rect | undefined => routeView;
const viewListeners = new Set<(view: Rect) => void>();

/**
 * The view the shell drew, so the loom routes from it outwards. Passed on
 * when it has moved half a view or changed size by half since the last one
 * passed on: a pan that far brings in a new half screen of wires. Design
 * values.
 */
export const setWireRouteView = (view: Rect): void => {
  const was = routeView;
  if (
    was !== undefined &&
    Math.abs(view.x + view.width / 2 - (was.x + was.width / 2)) < was.width / 2 &&
    Math.abs(view.y + view.height / 2 - (was.y + was.height / 2)) < was.height / 2 &&
    view.width < was.width * 1.5 &&
    view.width > was.width / 1.5
  ) {
    return;
  }
  routeView = view;
  for (const listener of viewListeners) listener(view);
};

/**
 * Hand the planner the open canvas's board on every change to its card
 * rectangles or its wires; its facts come back as `routes` ops, slice by slice. Returns the release.
 */
export const retainWireRoutes = (
  canvasName: string,
  emit: (ops: ReadonlyArray<SceneOp>) => void,
): (() => void) => {
  if (canvasName === "") return () => undefined;
  shareStats.clear();
  applied = { slices: 0, facts: 0, ms: 0 };
  const send = (update: LoomUpdate): void => {
    const started = performance.now();
    if (update.stats !== undefined) shareStats.set(update.stats.share, update.stats);
    emit([{ kind: "routes", set: update.set, remove: update.remove }]);
    applied.slices += 1;
    applied.facts += update.set.length + update.remove.length;
    applied.ms += performance.now() - started;
  };
  const host = inWorker() ? workerHost(send) : pageHost(send);
  const onView = (view: Rect): void => host.request({ kind: "focus", view });
  viewListeners.add(onView);
  const stop = observe(() => {
    const canvas = modelStore.canvas$(canvasName);
    const cards: LoomCard[] = [];
    for (const id of canvas.nodeIds.get()) {
      const node$ = canvas.nodes[id];
      // Track the fields the planner reads; nothing else re-runs it.
      node$.kind.get();
      node$.x.get();
      node$.y.get();
      node$.width.get();
      node$.height.get();
      const node = node$.peek();
      if (node !== undefined) cards.push(cardOf(node));
    }
    const rows: LoomWireRow[] = [];
    for (const id of canvas.wireIds.get()) {
      const wire$ = canvas.wires[id];
      wire$.from.get();
      wire$.to.get();
      wire$.fromSide.get();
      wire$.toSide.get();
      const wire = wire$.peek();
      if (wire !== undefined) rows.push({ id: wire.id, from: wire.from, to: wire.to, fromSide: wire.fromSide, toSide: wire.toSide });
    }
    host.request({ kind: "plan", cards, wires: rows, ...(routeView === undefined ? {} : { view: routeView }) });
  });
  return () => {
    stop();
    viewListeners.delete(onView);
    host.dispose();
  };
};
