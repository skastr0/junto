/**
 * The reach change a drag would make, shown on the cards before the drop
 * (plan 0.10/01 rule 6). The canvas as the store holds it is taken when the
 * drag starts; each drag step lays the dragged frames over it and asks
 * `reachChange` (shared, the rules main rules by) what differs.
 *
 * Nothing re-renders: the marks are data attributes on the React Flow node
 * elements, and the stylesheet (reach-preview.css) draws them with transform
 * and opacity only. A step that changes nothing touches no element.
 */
import type { Canvas } from "@shared/model";
import type { NodeId } from "@shared/model/base";
import {
  nodeReachChanges,
  reachChange,
  reachChangeSummary,
  type NodeReachChange,
} from "@shared/reach-preview";
import type { ReachCanvas, ReachNode } from "@shared/region-reach";
import type { SeatTask } from "@shared/seat-task-index";

type Point = { readonly x: number; readonly y: number };

const MARK = "data-reach-preview";
const SUMMARY = "data-reach-summary";

type Preview = {
  readonly before: Canvas;
  readonly bySeat: Readonly<Record<string, SeatTask | undefined>>;
  readonly root: ParentNode;
  marks: ReadonlyMap<NodeId, NodeReachChange>;
  summaryOn: string | undefined;
  summary: string;
};

let preview: Preview | null = null;

const elementsOf = (root: ParentNode, id: string): ReadonlyArray<Element> =>
  [...root.querySelectorAll(`.react-flow__node[data-id="${CSS.escape(id)}"]`)];

const clearMarks = (current: Preview): void => {
  for (const id of current.marks.keys()) for (const el of elementsOf(current.root, id)) el.removeAttribute(MARK);
  if (current.summaryOn !== undefined) {
    for (const el of elementsOf(current.root, current.summaryOn)) el.removeAttribute(SUMMARY);
  }
};

/** Take the canvas a drag starts from. */
export const startReachPreview = (
  before: Canvas,
  bySeat: Readonly<Record<string, SeatTask | undefined>>,
  root: ParentNode = document,
): void => {
  if (preview !== null) clearMarks(preview);
  preview = { before, bySeat, root, marks: new Map(), summaryOn: undefined, summary: "" };
};

/**
 * One drag step: `positions` are where the dragged cards are now, `grabbed`
 * the card under the pointer, which carries the words.
 */
export const updateReachPreview = (positions: ReadonlyMap<string, Point>, grabbed: string): void => {
  const current = preview;
  if (current === null) return;
  const nodes = new Map<NodeId, ReachNode>();
  for (const [id, node] of current.before.nodes) {
    const at = positions.get(id);
    nodes.set(id, at === undefined || (at.x === node.x && at.y === node.y) ? node : { ...node, x: at.x, y: at.y });
  }
  const after: ReachCanvas = { nodes };
  const changes = reachChange(current.before, after, (seat, node) => current.bySeat[seat]?.tasks.some((task) => task.node === node) === true);
  const marks = nodeReachChanges(changes);

  for (const [id] of current.marks) {
    if (marks.has(id)) continue;
    for (const el of elementsOf(current.root, id)) el.removeAttribute(MARK);
  }
  for (const [id, change] of marks) {
    if (current.marks.get(id) === change) continue;
    for (const el of elementsOf(current.root, id)) el.setAttribute(MARK, change);
  }
  current.marks = marks;

  const summary = changes.length === 0 ? "" : reachChangeSummary(changes);
  const summaryOn = summary === "" ? undefined : grabbed;
  if (summaryOn !== current.summaryOn || summary !== current.summary) {
    if (current.summaryOn !== undefined) {
      for (const el of elementsOf(current.root, current.summaryOn)) el.removeAttribute(SUMMARY);
    }
    if (summaryOn !== undefined) for (const el of elementsOf(current.root, summaryOn)) el.setAttribute(SUMMARY, summary);
    current.summaryOn = summaryOn;
    current.summary = summary;
  }
};

/** The drag ended or was abandoned: every mark goes. */
export const endReachPreview = (): void => {
  if (preview === null) return;
  clearMarks(preview);
  preview = null;
};
