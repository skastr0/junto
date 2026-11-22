/**
 * The GPU canvas's loom (architecture section 13), on the feed's side: it
 * follows the model's card rectangles and wires and hands each settled board
 * to the planner (feed/loom-planner.ts), whose facts come back as `routes`
 * ops.
 *
 * Routing never runs on the boot path (issue 912). The planner runs in a
 * worker (feed/loom-worker.ts) where the page has one, and in slices on the
 * page otherwise; either way the observer only collects rows and posts them,
 * so the first frame never waits on a route. The wires nearest the view are
 * routed first (`setWireRouteView`), and the engine draws a wire only once
 * its route has landed, fading it in.
 */
import { observe } from "@legendapp/state";
import type { Rect, SceneOp } from "../contract";
import { modelStore } from "../../lib/use-model";
import { cardOf, type LoomCard, type LoomUpdate, type LoomWireRow } from "./loom-planner";
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

const workerHost = (send: (update: LoomUpdate) => void): LoomHost => {
  const worker = new Worker(new URL("./loom-worker.ts", import.meta.url), { type: "module" });
  let fallback: LoomHost | undefined;
  let last: Extract<LoomRequest, { kind: "plan" }> | undefined;
  worker.onmessage = (event: MessageEvent<LoomUpdate>) => send(event.data);
  worker.onerror = (event) => {
    // A worker that cannot start routes on the page instead, from the last board.
    console.error("loom worker error:", event.message);
    worker.terminate();
    if (fallback !== undefined) return;
    fallback = pageHost(send);
    if (last !== undefined) fallback.request(last);
  };
  return {
    request: (request) => {
      if (request.kind === "plan") last = request;
      if (fallback !== undefined) fallback.request(request);
      else worker.postMessage(request);
    },
    dispose: () => {
      worker.terminate();
      fallback?.dispose();
    },
  };
};

/** The open canvas's view on the board, as the shell last drew it. */
let routeView: Rect | undefined;
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
  const send = (update: LoomUpdate): void => emit([{ kind: "routes", set: update.set, remove: update.remove }]);
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
