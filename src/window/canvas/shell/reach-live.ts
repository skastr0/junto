/**
 * The reach preview over the GPU canvas (docs/canvas-gpu-architecture.md,
 * section 10; docs/plans/0.10/01-region-binding.md rule 6).
 *
 * A drag or a region resize can carry a seat or a resource across a region
 * boundary, and what the drop would mean for reach must show before the drop:
 * the cards that would come into reach breathe, the ones that would leave are
 * outlined, and the card under the pointer carries the words. The rules and
 * the words are shared with the DOM canvas (`@shared/reach-preview`); this
 * module supplies the two pictures: the canvas the gesture started from, and
 * the rectangles the engine draws on each frame, live.
 *
 * Nothing renders and nothing is written. The engine paints the marks, so a
 * drag step costs one scene op and no React work; a step that changes nothing
 * costs nothing at all.
 */

import type { Canvas, Node as ModelNode } from "@shared/model";
import { asNodeId, type NodeId } from "@shared/model/base";
import { reachPreviewOf, type NodeReachChange } from "@shared/reach-preview";
import type { SeatTask } from "@shared/seat-task-index";
import { seatTasks$ } from "../../lib/seat-tasks";
import { state$ } from "../../lib/state";
import { modelStore } from "../../lib/use-model";
import type { FrameFacts, Intent, Rect, ReachMark, SceneOp } from "../contract";

/** What this module needs of the engine: intents out, scene in, live rectangles. */
export type ReachPreviewEngine = {
  readonly apply: (ops: ReadonlyArray<SceneOp>) => void;
  readonly onIntent: (listener: (intent: Intent) => void) => () => void;
  readonly onFrame: (listener: (facts: FrameFacts) => void) => () => void;
  readonly rectOf: (id: NodeId) => Rect | undefined;
};

type BySeat = Readonly<Record<string, SeatTask | undefined>>;

/**
 * What the preview reads of the window: the canvas the store holds, and the
 * open tasks each seat holds. The default is the live store; a test hands its
 * own, so the rules are exercised without a running window.
 */
export type ReachPreviewHost = {
  readonly canvas: () => Canvas | undefined;
  readonly bySeat: () => BySeat;
};

const liveHost = (): ReachPreviewHost => ({
  canvas: () => {
    const name = state$.canvasName.peek();
    return name === "" ? undefined : modelStore.canvasOf(name);
  },
  bySeat: () => seatTasks$.bySeat.peek() as BySeat,
});

/** The marks the last step painted, for the test hook; null when nothing is painted. */
let paintedNow: ReadonlyArray<ReachMark> | null = null;
export const lastReachMarks = (): ReadonlyArray<ReachMark> | null => paintedNow;

const sameMarks = (a: ReadonlyMap<NodeId, NodeReachChange>, b: ReadonlyMap<NodeId, NodeReachChange>): boolean => {
  if (a.size !== b.size) return false;
  for (const [id, effect] of a) if (b.get(id) !== effect) return false;
  return true;
};

/**
 * Follow the engine's drag and resize gestures and paint the reach change of
 * each frame. Returns the way to stop.
 */
export const installReachPreview = (
  engine: ReachPreviewEngine,
  host: ReachPreviewHost = liveHost(),
): (() => void) => {
  /** The canvas as the store held it when the gesture started. */
  let before: ReadonlyMap<NodeId, ModelNode> | undefined;
  /** The cards the pointer owns, the grabbed one first. */
  let moving: ReadonlyArray<NodeId> = [];
  let bySeat: BySeat = {};
  let marks: ReadonlyMap<NodeId, NodeReachChange> = new Map();
  let summary = "";
  let painted = false;

  const holdsTaskOn = (seat: NodeId, node: NodeId): boolean =>
    bySeat[seat]?.tasks.some((task) => task.node === node) === true;

  const clear = (): void => {
    before = undefined;
    moving = [];
    bySeat = {};
    marks = new Map();
    summary = "";
    if (!painted) return;
    painted = false;
    paintedNow = null;
    engine.apply([{ kind: "reachMarks", marks: null }]);
  };

  const begin = (nodeIds: ReadonlyArray<string>): void => {
    clear();
    const canvas = nodeIds.length === 0 ? undefined : host.canvas();
    if (canvas === undefined || canvas.nodes.size === 0) return;
    before = new Map(canvas.nodes);
    // Intent ids cross the contract as plain strings; the canvas's own ids are
    // the branded ones, and both name the same rows.
    moving = nodeIds.map(asNodeId);
    bySeat = host.bySeat();
  };

  /**
   * One frame: lay the rectangles the engine drew for the gesture's cards over
   * the canvas the gesture started from, and paint what that changes. `rectOf`
   * answers the drawn rectangle, so a card and a region preview exactly where
   * they are and at the size a resize gave them.
   */
  const step = (): void => {
    const start = before;
    if (start === undefined || moving.length === 0) return;
    const nodes = new Map(start);
    let moved = false;
    for (const id of moving) {
      const rect = engine.rectOf(id);
      const node = nodes.get(id);
      if (rect === undefined || node === undefined) continue;
      if (node.x === rect.x && node.y === rect.y && node.width === rect.width && node.height === rect.height) continue;
      nodes.set(id, { ...node, x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      moved = true;
    }
    if (!moved) {
      // Dragged back onto its row: the marks go, the gesture goes on.
      if (!painted) return;
      painted = false;
      paintedNow = null;
      marks = new Map();
      summary = "";
      engine.apply([{ kind: "reachMarks", marks: null }]);
      return;
    }
    const frame = reachPreviewOf({ nodes: start }, { nodes }, holdsTaskOn);
    if (painted && frame.summary === summary && sameMarks(frame.marks, marks)) return;
    marks = frame.marks;
    summary = frame.summary;
    // The words sit on the card under the pointer, as the DOM canvas draws
    // them. A region gesture grabs a region, which carries no ring of its own,
    // so it takes a summary-only mark: the pill, no ring.
    const grabbed = moving[0];
    const list: ReachMark[] = [...marks].map(([id, effect]) => ({
      id,
      effect,
      ...(id === grabbed && summary !== "" ? { summary } : {}),
    }));
    if (summary !== "" && !marks.has(grabbed)) list.push({ id: grabbed, summary });
    painted = list.length > 0;
    paintedNow = painted ? list : null;
    engine.apply([{ kind: "reachMarks", marks: painted ? list : null }]);
  };

  const offFrame = engine.onFrame(step);
  const offIntent = engine.onIntent((intent) => {
    if (intent.kind !== "gesture") return;
    if (intent.gesture === "drag" || intent.gesture === "resize") {
      begin(intent.nodeIds);
      return;
    }
    // The drop, or a lost pointer: the marks go with the gesture.
    if (intent.gesture === null) clear();
  });
  return () => {
    offFrame();
    offIntent();
    clear();
  };
};
