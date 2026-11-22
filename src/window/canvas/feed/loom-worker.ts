/**
 * The loom in a worker (issue 912): routing never runs on the page's main
 * thread, so the first frame and every frame after it never wait on it. The
 * page posts boards and views (`LoomRequest`); the worker posts back each
 * slice's facts (`LoomUpdate`).
 */
import type { LoomUpdate } from "./loom-planner";
import { createLoomRun, type LoomRequest } from "./loom-run";
import type { LoomSeedChange } from "./loom-seed";

/** What the worker posts back: a slice's facts, or a seed the page asked for. */
type LoomReply = LoomUpdate | { readonly kind: "snapshot"; readonly seed: LoomSeedChange };

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<LoomRequest>) => void) | null;
  postMessage: (message: LoomReply) => void;
};

const run = createLoomRun(
  (update) => scope.postMessage(update),
  () => performance.now(),
  // A macrotask between slices: the next board or view is read before the next slice.
  (next) => setTimeout(next, 0),
  (seed) => scope.postMessage({ kind: "snapshot", seed }),
);

scope.onmessage = (event) => run.request(event.data);
