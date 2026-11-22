/**
 * The loom in a worker (issue 912): routing never runs on the page's main
 * thread, so the first frame and every frame after it never wait on it. The
 * page posts boards and views (`LoomRequest`); the worker posts back each
 * slice's facts (`LoomUpdate`).
 */
import type { LoomUpdate } from "./loom-planner";
import { createLoomRun, type LoomRequest } from "./loom-run";

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<LoomRequest>) => void) | null;
  postMessage: (message: LoomUpdate) => void;
};

const run = createLoomRun(
  (update) => scope.postMessage(update),
  () => performance.now(),
  // A macrotask between slices: the next board or view is read before the next slice.
  (next) => setTimeout(next, 0),
);

scope.onmessage = (event) => run.request(event.data);
