import type { NodeId } from "./model/base";
import {
  isResourceKind,
  onOneLine,
  positionsOf,
  type Positions,
  type ReachCanvas,
  type ReachNode,
} from "./region-reach";

// The reach change a move would make (01 rule 6): which seats and resources
// come into or leave reach if the dragged frames were dropped where they are
// now. It reads the same rules the ruler does (region-reach.ts) on the canvas
// before the move and the canvas as it would be after it, and holds nothing.

/**
 * One seat and one resource whose reach the move changes. `held`: the seat
 * leaves reach of the task node it holds an open task on, and keeps acting on
 * that task, because assignment outlives a move.
 */
export type ReachPairChange = {
  readonly seat: NodeId;
  readonly resource: NodeId;
  readonly change: "gains" | "loses" | "held";
};

/** How one node's reach changes, over every pair it is part of. */
export type NodeReachChange = "gains" | "loses" | "both" | "held";

/** Only an agent acts (01 rule 4); a live overseer reaches every Tasks node. */
const isActingSeat = (node: ReachNode): boolean => node.kind === "agent";
const isOverseer = (node: ReachNode): boolean => "overseer" in node && node.overseer === true;

const sameFrame = (a: ReachNode, b: ReachNode): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const reachOf = (
  canvas: ReachCanvas,
  at: (id: NodeId) => Positions | undefined,
  seat: ReachNode,
  resource: ReachNode,
): boolean => {
  if (isOverseer(seat) && resource.kind === "task") return true;
  const a = at(seat.id);
  const b = at(resource.id);
  return a !== undefined && b !== undefined && onOneLine(canvas, a, b);
};

const memo = (canvas: ReachCanvas) => {
  const cache = new Map<NodeId, Positions | undefined>();
  return (id: NodeId): Positions | undefined => {
    if (!cache.has(id)) cache.set(id, positionsOf(canvas, id));
    return cache.get(id);
  };
};

/**
 * Every seat and resource pair whose reach differs between `before` and
 * `after`, sorted by seat then resource. Both canvases hold the same nodes; a
 * node only in one is ignored. When no region moved, only pairs with a moved
 * end can change, so only those are read. `holdsTaskOn` says whether a seat
 * holds an open task on a task node.
 */
export const reachChange = (
  before: ReachCanvas,
  after: ReachCanvas,
  holdsTaskOn: (seat: NodeId, node: NodeId) => boolean = () => false,
): ReadonlyArray<ReachPairChange> => {
  const moved = new Set<NodeId>();
  let regionMoved = false;
  for (const node of after.nodes.values()) {
    const was = before.nodes.get(node.id);
    if (was === undefined || sameFrame(was, node)) continue;
    moved.add(node.id);
    if (node.kind === "region") regionMoved = true;
  }
  if (moved.size === 0) return [];

  const seats: ReachNode[] = [];
  const resources: ReachNode[] = [];
  for (const node of after.nodes.values()) {
    if (!before.nodes.has(node.id)) continue;
    if (isActingSeat(node)) seats.push(node);
    else if (isResourceKind(node.kind)) resources.push(node);
  }

  const atBefore = memo(before);
  const atAfter = memo(after);
  const changes: ReachPairChange[] = [];
  for (const seat of seats) {
    for (const resource of resources) {
      if (!regionMoved && !moved.has(seat.id) && !moved.has(resource.id)) continue;
      const was = reachOf(before, atBefore, before.nodes.get(seat.id)!, before.nodes.get(resource.id)!);
      const now = reachOf(after, atAfter, seat, resource);
      if (was === now) continue;
      const change = now ? "gains" : holdsTaskOn(seat.id, resource.id) ? "held" : "loses";
      changes.push({ seat: seat.id, resource: resource.id, change });
    }
  }
  return changes.sort((a, b) =>
    a.seat < b.seat ? -1 : a.seat > b.seat ? 1 : a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0);
};

/** Each node a change touches, at both ends, with what happens to its reach. */
export const nodeReachChanges = (changes: ReadonlyArray<ReachPairChange>): ReadonlyMap<NodeId, NodeReachChange> => {
  const out = new Map<NodeId, NodeReachChange>();
  const mark = (id: NodeId, change: ReachPairChange["change"]): void => {
    const was = out.get(id);
    if (was === undefined || was === change) out.set(id, change);
    else if (change === "held") return;
    else if (was === "held") out.set(id, change);
    else out.set(id, "both");
  };
  for (const { seat, resource, change } of changes) {
    mark(seat, change);
    mark(resource, change);
  }
  return out;
};

/** The words for a move's change: "2 come into reach, 1 leaves, 1 kept by assignment". */
export const reachChangeSummary = (changes: ReadonlyArray<ReachPairChange>): string => {
  const count = (change: ReachPairChange["change"]) => changes.filter((c) => c.change === change).length;
  const gains = count("gains");
  const loses = count("loses");
  const held = count("held");
  const parts: string[] = [];
  if (gains > 0) parts.push(`${gains} ${gains === 1 ? "comes" : "come"} into reach`);
  if (loses > 0) parts.push(`${loses} ${loses === 1 ? "leaves" : "leave"}`);
  if (held > 0) parts.push(`${held} kept by assignment`);
  return parts.length === 0 ? "reach unchanged" : parts.join(", ");
};
