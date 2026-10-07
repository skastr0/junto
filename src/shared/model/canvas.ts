import type { CanvasName, Frame, NodeId } from "./base";
import type { Changed, Opened, Seq } from "./events";
import type { Node, NodeKind, NodeOf } from "./kinds";
import type { Region } from "./region";
import type { Wire, WireId } from "./wire";

// One canvas held in memory: its nodes and wires by id. This is what shared
// logic reads when it needs to know what is on a canvas and how it is joined.
// It holds no work: mail, tasks and the rest are asked for by node id.

export type Canvas = {
  readonly name: CanvasName;
  readonly seq: Seq;
  readonly nodes: ReadonlyMap<NodeId, Node>;
  readonly wires: ReadonlyMap<WireId, Wire>;
};

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

/** The node with this id when it is of this kind. */
export const nodeOf = <K extends NodeKind>(
  canvas: Canvas,
  id: NodeId,
  kind: K,
): NodeOf<K> | undefined => {
  const node = canvas.nodes.get(id);
  return node?.kind === kind ? (node as NodeOf<K>) : undefined;
};

export const nodesOf = <K extends NodeKind>(canvas: Canvas, kind: K): ReadonlyArray<NodeOf<K>> => {
  const found: Array<NodeOf<K>> = [];
  for (const node of canvas.nodes.values()) {
    if (node.kind === kind) found.push(node as NodeOf<K>);
  }
  return found;
};

/** Nodes in paint order, lowest first. */
export const inPaintOrder = (canvas: Canvas): ReadonlyArray<Node> =>
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

const contains = (region: Frame, rect: Frame): boolean =>
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
export const regionStack = (canvas: Canvas, target: NodeId | Frame): ReadonlyArray<Region> => {
  const self = typeof target === "string" ? target : undefined;
  const rect = typeof target === "string" ? canvas.nodes.get(target) : target;
  if (rect === undefined) return [];
  return nodesOf(canvas, "region")
    .filter((region) => region.id !== self && contains(region, rect))
    .sort((a, b) => b.width * b.height - a.width * a.height || a.id.localeCompare(b.id));
};

/** The things inside a region that are not themselves regions. */
export const regionMembers = (canvas: Canvas, region: Region): ReadonlyArray<Node> => {
  const found: Array<Node> = [];
  for (const node of canvas.nodes.values()) {
    if (node.kind !== "region" && contains(region, node)) found.push(node);
  }
  return found;
};

/** Regions wholly inside this one, at any depth. */
export const regionsInside = (canvas: Canvas, region: Region): ReadonlyArray<Region> =>
  nodesOf(canvas, "region").filter(
    (candidate) => candidate.id !== region.id && contains(region, candidate),
  );
