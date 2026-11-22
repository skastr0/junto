/**
 * The loom's run loop (issue 912), the same in a worker and on the page: a
 * plan begins with the latest board it was handed, then routes in slices
 * until nothing is owed, sending each slice's facts as it goes. Between
 * slices it yields, so a newer board or a moved view is taken before the
 * next slice; a newer board begins a new plan that carries what the last one
 * still owed.
 */
import type { Rect } from "../contract";
import { createLoomPlanner, type LoomCard, type LoomShare, type LoomUpdate, type LoomWireRow } from "./loom-planner";
import type { LoomSeed } from "./loom-seed";
import { unpackCards, unpackWires, type PackedCards } from "./loom-board";

export type LoomRequest =
  | { readonly kind: "plan"; readonly cards: ReadonlyArray<LoomCard>; readonly wires: ReadonlyArray<LoomWireRow>; readonly view?: Rect }
  /** A board packed on the page (loom-board.ts): every card, and only this run's share of the wires. */
  | { readonly kind: "board"; readonly cards: PackedCards; readonly wires: string; readonly view?: Rect }
  | { readonly kind: "focus"; readonly view: Rect }
  | { readonly kind: "reset" }
  /** The stored seed from the page, before the first board. */
  | { readonly kind: "seed"; readonly seed: LoomSeed }
  /** The page wants a seed back now (the board settled). */
  | { readonly kind: "settled" }
  /** This run's part of the board among several (sent first, before any board). */
  | ({ readonly kind: "share" } & LoomShare);

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
  snapshot?: (seed: LoomSeed) => void,
): LoomRun => {
  let planner = createLoomPlanner();
  let share = 0;
  // The newest board, unpacked only when its turn comes: a board a newer
  // one replaced before then is never read.
  let board: Extract<LoomRequest, { kind: "plan" | "board" }> | undefined;
  let scheduled = false;
  let disposed = false;

  const post = (update: LoomUpdate): void => {
    if (update.set.length > 0 || update.remove.length > 0) {
      send({ ...update, stats: { ...planner.stats(), share }, owed: planner.owed() });
    }
  };

  const tick = (): void => {
    scheduled = false;
    if (disposed) return;
    if (board !== undefined) {
      const next = board;
      board = undefined;
      if (next.kind === "plan") post(planner.begin(next.cards, next.wires, next.view));
      else post(planner.begin(unpackCards(next.cards), unpackWires(next.wires), next.view));
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
        case "board":
          board = request;
          schedule();
          return;
        case "seed":
          planner.seed(request.seed);
          return;
        case "settled":
          snapshot?.(planner.snapshot());
          return;
        case "focus":
          planner.focus(request.view);
          return;
        case "reset":
          board = undefined;
          planner.reset();
          return;
        case "share":
          planner = createLoomPlanner({ index: request.index, count: request.count });
          share = request.index;
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
