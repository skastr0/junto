import { Schema } from "effect";
import { CanvasName, NodeId, type Frame } from "./base";
import { Seq, type Changed, type Opened } from "./events";
import { Node, type NodeKind, type NodeOf } from "./kinds";
import type { Region } from "./region";
import { Wire, WireId } from "./wire";

// One canvas held in memory: its nodes and wires by id. This is what shared
// logic reads when it needs to know what is on a canvas and how it is joined.
// It holds no work: mail, tasks and the rest are asked for by node id.

export const CanvasSchema = Schema.Struct({
  name: CanvasName,
  seq: Seq,
  nodes: Schema.ReadonlyMap(NodeId, Node),
  wires: Schema.ReadonlyMap(WireId, Wire),
});
export type Canvas = typeof CanvasSchema.Type;

export const canvasFromOpened = (opened: Opened): Canvas => ({
  name: opened.canvas,
  seq: opened.seq,
  nodes: new Map(opened.nodes.map((node) => [node.id, node])),
  wires: new Map(opened.wires.map((wire) => [wire.id, wire])),
});

/**
 * What following one event did. `Gap` means an event was missed and the canvas
 * must be opened again; `Stale` means this one was already applied.
 */
export type Followed =
  | { readonly _tag: "Applied"; readonly canvas: Canvas }
  | { readonly _tag: "Stale" }
  | { readonly _tag: "Gap"; readonly have: Seq; readonly got: Seq };

/** Apply one committed change. Never mutates the canvas it is given. */
export const follow = (canvas: Canvas, change: Changed): Followed => {
  if (change.seq <= canvas.seq) return { _tag: "Stale" };
  if (change.seq !== canvas.seq + 1) {
    return { _tag: "Gap", have: canvas.seq, got: change.seq };
  }
  const nodes = new Map(canvas.nodes);
  for (const id of change.removedNodes) nodes.delete(id);
  for (const node of change.nodes) nodes.set(node.id, node);
  const wires = new Map(canvas.wires);
  for (const id of change.removedWires) wires.delete(id);
  for (const wire of change.wires) wires.set(wire.id, wire);
  return { _tag: "Applied", canvas: { name: canvas.name, seq: change.seq, nodes, wires } };
};

// ── Reading nodes ───────────────────────────────────────────────────────────

/** All a reader of nodes needs of a canvas. */
export type Placed = Pick<Canvas, "nodes">;

/** The node with this id when it is of this kind. */
export const nodeOf = <K extends NodeKind>(
  canvas: Placed,
  id: NodeId,
  kind: K,
): NodeOf<K> | undefined => {
  const node = canvas.nodes.get(id);
  return node?.kind === kind ? (node as NodeOf<K>) : undefined;
};

export const nodesOf = <K extends NodeKind>(canvas: Placed, kind: K): ReadonlyArray<NodeOf<K>> => {
  const found: Array<NodeOf<K>> = [];
  for (const node of canvas.nodes.values()) {
    if (node.kind === kind) found.push(node as NodeOf<K>);
  }
  return found;
};

/** Nodes in paint order, lowest first. */
export const inPaintOrder = (canvas: Placed): ReadonlyArray<Node> =>
  [...canvas.nodes.values()].sort((a, b) => a.z - b.z || a.id.localeCompare(b.id));

// ── Wires ───────────────────────────────────────────────────────────────────

/** Every wire with an end on this node. */
export const wiresAt = (canvas: Canvas, id: NodeId): ReadonlyArray<Wire> => {
  const found: Array<Wire> = [];
  for (const wire of canvas.wires.values()) {
    if (wire.from === id || wire.to === id) found.push(wire);
  }
  return found;
};

// ── Regions ─────────────────────────────────────────────────────────────────
//
// Membership is one rule everywhere: a thing is inside a region only when its
// whole rectangle lies inside the region's. It is worked out, never stored.

/** The one membership test: `rect` lies wholly inside `region`. */
export const frameContains = (region: Frame, rect: Frame): boolean =>
  rect.x >= region.x &&
  rect.y >= region.y &&
  rect.x + rect.width <= region.x + region.width &&
  rect.y + rect.height <= region.y + region.height;

/** What a region with an empty label is called, everywhere it is named. */
export const UNNAMED_REGION = "unnamed region";

export const regionName = (region: Region): string => region.label?.trim() || UNNAMED_REGION;

/**
 * Every region whose rectangle wholly contains the target, outermost first
 * (larger area first; equal areas by id). Regions may overlap, so this is all
 * containers, not a path. A region is never in its own stack.
 */
export const regionStack = (canvas: Placed, target: NodeId | Frame): ReadonlyArray<Region> => {
  const self = typeof target === "string" ? target : undefined;
  const rect = typeof target === "string" ? canvas.nodes.get(target) : target;
  if (rect === undefined) return [];
  return indexOfBoard(canvas.nodes).stack(rect, self);
};

/**
 * One region index per board (issue 912). A board's node map is read only,
 * and every change makes a new one, so the index built for a map stays true
 * for it; callers asking for the stack of every card on a board (the feed's
 * regions, the companion's reads) pay for the regions once, not per card.
 * The size is checked too, for a caller that fills a map after asking.
 */
const indexes = new WeakMap<Placed["nodes"], { readonly size: number; readonly index: RegionIndex }>();
const indexOfBoard = (nodes: Placed["nodes"]): RegionIndex => {
  const held = indexes.get(nodes);
  if (held !== undefined && held.size === nodes.size) return held.index;
  const index = regionIndex(nodesOf({ nodes }, "region"));
  indexes.set(nodes, { size: nodes.size, index });
  return index;
};

/** The stack order: outermost first (larger area first; equal areas by id). */
const outermostFirst = (a: Region, b: Region): number => b.width * b.height - a.width * a.height || a.id.localeCompare(b.id);

export type RegionIndex = {
  /** `regionStack` over the indexed regions: every region wholly containing the target, outermost first. */
  readonly stack: (target: Frame, self?: NodeId) => ReadonlyArray<Region>;
};

/**
 * The regions bucketed on a grid, so a whole board's stacks cost each node the
 * regions near it, not every region. The cell is the regions' median side,
 * read from the board; a region spanning more cells than there are regions is
 * kept aside and tested for every target, so no board costs more than the
 * plain scan. Any region holding a target holds its top-left corner, so the
 * corner's cell names every candidate.
 */
export const regionIndex = (regions: ReadonlyArray<Region>): RegionIndex => {
  if (regions.length === 0) return { stack: () => [] };
  const sides = regions.map((region) => Math.max(1, region.width, region.height)).sort((a, b) => a - b);
  const cell = sides[sides.length >> 1]!;
  const buckets = new Map<string, Region[]>();
  const wide: Region[] = [];
  for (const region of regions) {
    const x0 = Math.floor(region.x / cell);
    const y0 = Math.floor(region.y / cell);
    const x1 = Math.floor((region.x + region.width) / cell);
    const y1 = Math.floor((region.y + region.height) / cell);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > regions.length) {
      wide.push(region);
      continue;
    }
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        const key = `${String(cx)},${String(cy)}`;
        const list = buckets.get(key);
        if (list === undefined) buckets.set(key, [region]);
        else list.push(region);
      }
    }
  }
  return {
    stack: (target, self) => {
      const key = `${String(Math.floor(target.x / cell))},${String(Math.floor(target.y / cell))}`;
      const found: Region[] = [];
      for (const list of [buckets.get(key), wide]) {
        for (const region of list ?? []) if (region.id !== self && frameContains(region, target)) found.push(region);
      }
      return found.sort(outermostFirst);
    },
  };
};

/** The things inside a region that are not themselves regions. */
export const regionMembers = (canvas: Placed, region: Region): ReadonlyArray<Node> => {
  const found: Array<Node> = [];
  for (const node of canvas.nodes.values()) {
    if (node.kind !== "region" && frameContains(region, node)) found.push(node);
  }
  return found;
};

/**
 * The things a region's edge cuts: not regions, each overlapping the region's
 * frame with area above zero and not wholly inside it. They are not members
 * (`regionMembers` holds a node only when its whole rectangle lies inside), so
 * a Broadcast to the region misses the seats among them. One that only
 * touches the edge, or lies outside, is not one. In `regionMembers`' order;
 * the caller keeps the kinds it wants.
 */
export const regionCrossers = (canvas: Placed, region: Region): ReadonlyArray<Node> => {
  const found: Array<Node> = [];
  for (const node of canvas.nodes.values()) {
    if (node.kind === "region") continue;
    const overlaps =
      node.x < region.x + region.width &&
      node.x + node.width > region.x &&
      node.y < region.y + region.height &&
      node.y + node.height > region.y;
    if (overlaps && !frameContains(region, node)) found.push(node);
  }
  return found;
};

