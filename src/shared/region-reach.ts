import type { Frame, NodeId } from "./model/base";
import { frameContains } from "./model/canvas";
import type { NodeKind } from "./model/kinds";

// Region reach (docs/plans/0.10/01-region-binding.md). A seat may use every
// resource node in its own region, every region below it and every region
// above it, never a sibling or a cousin. Reach needs no edge. It is worked out
// from the rectangles on every call, never stored, so moving a node or a region
// changes reach on the next read.
//
// A node's positions are the innermost regions that wholly contain it. Regions
// that only partly overlap are unrelated, so a node inside two of them has two
// positions. A node inside no region is at the root, which is on one line with
// everything.

/** A region's node id, known to name a region on the canvas it came from. */
declare const regionBrand: unique symbol;
export type RegionId = NodeId & { readonly [regionBrand]: true };

/** What reach reads of a node. Every `Node` of a `Canvas` is one. */
export type ReachNode = Frame & { readonly id: NodeId; readonly kind: NodeKind };

/** What reach reads of a canvas. A `Canvas` is one. */
export type ReachCanvas = { readonly nodes: ReadonlyMap<NodeId, ReachNode> };

declare const positionsBrand: unique symbol;
/**
 * Where a node sits, made only by `positionsOf`. `Root` is outside every
 * region; `Regions` holds the innermost regions that contain it, at least one,
 * sorted by id.
 */
export type Positions = (
  | { readonly _tag: "Root" }
  | { readonly _tag: "Regions"; readonly innermost: readonly [RegionId, ...RegionId[]] }
) & { readonly [positionsBrand]: true };

/** Kinds a seat reaches with every item operation and no edge. */
export const RESOURCE_KINDS = ["task", "artifacts"] as const satisfies ReadonlyArray<NodeKind>;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** Kinds whose comment threads follow reach. A page stays edge-bound for automation (06). */
export const COMMENTABLE_KINDS = [...RESOURCE_KINDS, "page"] as const satisfies ReadonlyArray<NodeKind>;
export type CommentableKind = (typeof COMMENTABLE_KINDS)[number];

/** A seat as reach sees it: the seat itself, or its row in another machine's copy. */
export const SEAT_KINDS = ["agent", "peer"] as const satisfies ReadonlyArray<NodeKind>;
export type SeatKind = (typeof SEAT_KINDS)[number];

const isOneOf = <K extends NodeKind>(kinds: ReadonlyArray<K>, kind: NodeKind): kind is K =>
  (kinds as ReadonlyArray<NodeKind>).includes(kind);

export const isResourceKind = (kind: NodeKind): kind is ResourceKind => isOneOf(RESOURCE_KINDS, kind);
export const isCommentableKind = (kind: NodeKind): kind is CommentableKind => isOneOf(COMMENTABLE_KINDS, kind);
export const isSeatKind = (kind: NodeKind): kind is SeatKind => isOneOf(SEAT_KINDS, kind);

/**
 * Who wrote an automation: the operator, whose reach is the whole canvas, or
 * an overseer seat (07: only the operator and overseers write automations).
 */
export type AutomationAuthor =
  | { readonly kind: "operator" }
  | { readonly kind: "seat"; readonly seat: NodeId };

/** The one place a `Positions` is made. */
const mint = (at: { readonly _tag: "Root" } | { readonly _tag: "Regions"; readonly innermost: readonly [RegionId, ...RegionId[]] }): Positions =>
  at as Positions;

const ROOT = mint({ _tag: "Root" });

const regionsOf = (canvas: ReachCanvas): ReadonlyArray<ReachNode> => {
  const found: Array<ReachNode> = [];
  for (const node of canvas.nodes.values()) if (node.kind === "region") found.push(node);
  return found;
};

const positionsIn = (regions: ReadonlyArray<ReachNode>, node: ReachNode): Positions => {
  const containers = regions.filter((region) => region.id !== node.id && frameContains(region, node));
  // Innermost: no other container lies strictly inside it. Two regions with the
  // same frame contain each other, so neither is strictly inside, and both count.
  const innermost = containers
    .filter((outer) =>
      !containers.some(
        (inner) => inner.id !== outer.id && frameContains(outer, inner) && !frameContains(inner, outer),
      ),
    )
    .map((region) => region.id as RegionId)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const [first, ...rest] = innermost;
  return first === undefined ? ROOT : mint({ _tag: "Regions", innermost: [first, ...rest] });
};

/** Where a node sits, or undefined when the canvas has no such node. */
export const positionsOf = (canvas: ReachCanvas, nodeId: NodeId): Positions | undefined => {
  const node = canvas.nodes.get(nodeId);
  return node === undefined ? undefined : positionsIn(regionsOf(canvas), node);
};

/**
 * `upper` is `lower` or wholly contains it. Positions held across a write can
 * name a region that is gone; a missing region is on no line (fail closed).
 */
const atOrAbove = (canvas: ReachCanvas, upper: RegionId, lower: RegionId): boolean => {
  const outer = canvas.nodes.get(upper);
  const inner = canvas.nodes.get(lower);
  if (outer?.kind !== "region" || inner?.kind !== "region") return false;
  return upper === lower || frameContains(outer, inner);
};

/**
 * Some position of `a` and some position of `b` are on one line: the same
 * region, or one wholly inside the other. The root is on one line with
 * everything. Symmetric.
 */
export const onOneLine = (canvas: ReachCanvas, a: Positions, b: Positions): boolean => {
  if (a._tag === "Root" || b._tag === "Root") return true;
  return a.innermost.some((p) => b.innermost.some((q) => atOrAbove(canvas, p, q) || atOrAbove(canvas, q, p)));
};

/**
 * Some position of `lower` is at or below some position of `upper`. Everything
 * is below the root; the root is below nothing but the root.
 */
export const atOrBelow = (canvas: ReachCanvas, upper: Positions, lower: Positions): boolean => {
  if (upper._tag === "Root") return true;
  if (lower._tag === "Root") return false;
  return upper.innermost.some((p) => lower.innermost.some((q) => atOrAbove(canvas, p, q)));
};

const byId = (a: ReachNode, b: ReachNode): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Whether two nodes are in reach of each other. False when either is missing. */
export const reaches = (canvas: ReachCanvas, from: NodeId, to: NodeId): boolean => {
  const a = positionsOf(canvas, from);
  const b = positionsOf(canvas, to);
  return a !== undefined && b !== undefined && onOneLine(canvas, a, b);
};

/**
 * Whether a seat reaches a task node: by region reach, or, for a live
 * overseer seat, any Tasks node on the same canvas with no edge, as
 * admitOverseerWorkTarget admits (authz.ts). The flag is read off the canvas
 * the caller holds, never cached; what the seat may do there stays the ruler's.
 */
export const seatReachesTaskNode = (canvas: ReachCanvas, seat: NodeId, node: NodeId): boolean => {
  if (reaches(canvas, seat, node)) return true;
  const self = canvas.nodes.get(seat);
  return self?.kind === "agent" && "overseer" in self && self.overseer === true && canvas.nodes.get(node)?.kind === "task";
};

const inReachOf = (
  canvas: ReachCanvas,
  anchorId: NodeId,
  admits: (kind: NodeKind) => boolean,
): ReadonlyArray<ReachNode> => {
  const regions = regionsOf(canvas);
  const anchor = canvas.nodes.get(anchorId);
  if (anchor === undefined) return [];
  const at = positionsIn(regions, anchor);
  const found: Array<ReachNode> = [];
  for (const node of canvas.nodes.values()) {
    if (node.id === anchorId || !admits(node.kind)) continue;
    if (onOneLine(canvas, at, positionsIn(regions, node))) found.push(node);
  }
  return found.sort(byId);
};

/**
 * Resource nodes a seat reaches, sorted by id. Only a seat (agent) acts; a
 * peer row never acts through a copy (01 rule 4), and nothing else reaches.
 */
export const resourcesInReach = (canvas: ReachCanvas, seatId: NodeId): ReadonlyArray<ReachNode> =>
  canvas.nodes.get(seatId)?.kind === "agent" ? inReachOf(canvas, seatId, isResourceKind) : [];

/** Seats that reach a node: reviewers, mention candidates, recipients. Sorted by id. */
export const seatsInReach = (canvas: ReachCanvas, nodeId: NodeId): ReadonlyArray<ReachNode> =>
  inReachOf(canvas, nodeId, isSeatKind);

/**
 * What an automation may act on: seats and resources at or below its own
 * positions, and, when an overseer seat wrote it, also in that seat's reach. Call it at
 * fire time so the author's current position counts (07).
 */
export const automationTargets = (
  canvas: ReachCanvas,
  automationId: NodeId,
  author: AutomationAuthor,
): ReadonlyArray<ReachNode> => {
  const regions = regionsOf(canvas);
  const automation = canvas.nodes.get(automationId);
  if (automation === undefined) return [];
  const at = positionsIn(regions, automation);
  const authorNode = author.kind === "seat" ? canvas.nodes.get(author.seat) : undefined;
  if (author.kind === "seat" && (authorNode === undefined || !isSeatKind(authorNode.kind))) return [];
  const authorAt = authorNode === undefined ? undefined : positionsIn(regions, authorNode);
  const found: Array<ReachNode> = [];
  for (const node of canvas.nodes.values()) {
    if (node.id === automationId || !(isSeatKind(node.kind) || isResourceKind(node.kind))) continue;
    const where = positionsIn(regions, node);
    if (!atOrBelow(canvas, at, where)) continue;
    if (authorAt !== undefined && !onOneLine(canvas, authorAt, where)) continue;
    found.push(node);
  }
  return found.sort(byId);
};
