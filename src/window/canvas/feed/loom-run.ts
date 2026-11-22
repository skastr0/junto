/**
 * The loom's run loop (issue 912), the same in a worker and on the page: a
 * plan begins with the latest board it was handed, then routes in slices
 * until nothing is owed, sending each slice's facts as it goes. Between
 * slices it yields, so a newer board or a moved view is taken before the
 * next slice; a newer board begins a new plan that carries what the last one
 * still owed.
 */
import type { Rect } from "../contract";
import { createLoomPlanner, type LoomCard, type LoomUpdate, type LoomWireRow } from "./loom-planner";

export type LoomRequest =
  | { readonly kind: "plan"; readonly cards: ReadonlyArray<LoomCard>; readonly wires: ReadonlyArray<LoomWireRow>; readonly view?: Rect }
  | { readonly kind: "focus"; readonly view: Rect }
  | { readonly kind: "reset" };

/**
 * How long a slice routes before it sends what it has: half a 60 Hz frame,
 * so the wires nearest the view land within the frame after they are routed.
 * A design value.
 */
export const LOOM_SLICE_MS = 8;

export type LoomRun = {
  readonly request: (request: LoomRequest) => void;
  readonly dispose: () => void;
};

export const createLoomRun = (
  send: (update: LoomUpdate) => void,
  clock: () => number,
  later: (run: () => void) => void,
): LoomRun => {
  const planner = createLoomPlanner();
  let board: Extract<LoomRequest, { kind: "plan" }> | undefined;
  let scheduled = false;
  let disposed = false;

  const post = (update: LoomUpdate): void => {
    if (update.set.length > 0 || update.remove.length > 0) send(update);
  };

  const tick = (): void => {
    scheduled = false;
    if (disposed) return;
    if (board !== undefined) {
      const next = board;
      board = undefined;
      post(planner.begin(next.cards, next.wires, next.view));
    }
    if (planner.owed() > 0) post(planner.step(LOOM_SLICE_MS, clock));
    if (planner.owed() > 0 || board !== undefined) schedule();
  };

  const schedule = (): void => {
    if (scheduled || disposed) return;
    scheduled = true;
    later(tick);
  };

  return {
    request: (request) => {
      if (disposed) return;
      switch (request.kind) {
        case "plan":
          board = request;
          schedule();
          return;
        case "focus":
          planner.focus(request.view);
          return;
        case "reset":
          board = undefined;
          planner.reset();
          return;
      }
    },
    dispose: () => {
      disposed = true;
      board = undefined;
      planner.reset();
    },
  };
};
