import type { CanvasDoc, CanvasNode, GroupNode } from "./canvas";
import type { ActorRefResolver } from "./attention";
import {
  deriveExecutionGraph,
  type ExecutionGraphContext,
  type LiveTrustViews,
} from "./execution-graph";
import type { ActorRef } from "./work-protocol";

// Derived state. Never persisted — recomputed from the document so the
// authored canvas document cannot go incoherent.
//
// blockedClosure / blockedEdgeIds are thin wrappers over deriveExecutionGraph.

/**
 * Build the strict canvas-scoped resolver used by pure graph projections.
 *
 * CanvasReadResult.actorRefs and renderer state$.actorRefs are the only valid
 * inputs. A missing reference or duplicate canvas/node entry resolves to
 * undefined; canvas node IDs never substitute for compiled seat identity.
 */
export const actorRefResolverFromProjection = (
  actorRefs: ReadonlyArray<ActorRef>,
): ActorRefResolver => {
  const refsByCanvas = new Map<string, Map<string, ActorRef>>();
  const ambiguous = new Map<string, Set<string>>();

  for (const actor of actorRefs) {
    const ambiguousNodeIds =
      ambiguous.get(actor.canvasName) ?? new Set<string>();
    if (ambiguousNodeIds.has(actor.nodeId)) continue;

    const refsByNodeId =
      refsByCanvas.get(actor.canvasName) ?? new Map<string, ActorRef>();
    if (refsByNodeId.has(actor.nodeId)) {
      refsByNodeId.delete(actor.nodeId);
      ambiguousNodeIds.add(actor.nodeId);
      ambiguous.set(actor.canvasName, ambiguousNodeIds);
    } else {
      refsByNodeId.set(actor.nodeId, actor);
    }
    refsByCanvas.set(actor.canvasName, refsByNodeId);
  }

  return ({ canvasName, nodeId }) => {
    if (ambiguous.get(canvasName)?.has(nodeId)) return undefined;
    return refsByCanvas.get(canvasName)?.get(nodeId);
  };
};

/** Adapt one authoritative actor-ref projection into graph derivation input. */
export const executionGraphContextFromActorRefs = (
  canvasName: string,
  actorRefs: ReadonlyArray<ActorRef>,
  trust: LiveTrustViews = {},
): ExecutionGraphContext => ({
  canvasName,
  resolveActorRef: actorRefResolverFromProjection(actorRefs),
  ...trust,
});

export const blockedClosure = (
  doc: CanvasDoc,
  context: ExecutionGraphContext,
): ReadonlySet<string> => deriveExecutionGraph(doc, context).blocked;

export const blockedEdgeIds = (
  doc: CanvasDoc,
  context: ExecutionGraphContext,
): ReadonlySet<string> => deriveExecutionGraph(doc, context).blockedEdgeIds;

export const isGroup = (node: CanvasNode): node is GroupNode => node.type === "group";

// The single membership predicate (I9): a target is inside a region only when
// its FULL bounding rect lies inside the region's rect — a rect partially
// overlapping a region is out. Promoted from the kernel's stricter rule
// (formerly duplicated center-point rules in kernel/cycle.ts and
// renderer/lib/geometry.ts); every membership consumer — region rollups,
// digest, work, authz, and renderer displays — derives from this one
// predicate. Renderer keeps a separate, explicitly non-membership helper for
// drag-hold interaction (center-point, includes nested regions).
export type RegionRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

const isFullyContained = (group: GroupNode, rect: RegionRect): boolean =>
  rect.x >= group.x &&
  rect.y >= group.y &&
  rect.x + rect.width <= group.x + group.width &&
  rect.y + rect.height <= group.y + group.height;

/**
 * Region nesting is authoring-time-warned past this depth (UI only) — never a
 * hard data rejection. Renderer z bands rely on typical depths staying below
 * the edge band.
 */
export const MAX_REGION_DEPTH = 8;

/**
 * Every group whose rect fully contains the target rect, sorted
 * area-descending (outer → inner; equal area ties break on node id).
 * Overlapping regions are allowed: the stack is ALL containers, not a tree
 * path. Works for plain nodes and for groups (region-in-region nesting); a
 * group is never in its own stack.
 */
export const regionStack = (
  doc: CanvasDoc,
  target: string | RegionRect,
): ReadonlyArray<GroupNode> => {
  const selfId = typeof target === "string" ? target : undefined;
  const rect =
    typeof target === "string"
      ? doc.nodes.find((node) => node.id === target)
      : target;
  if (!rect) return [];
  return doc.nodes
    .filter(isGroup)
    .filter((group) => group.id !== selfId && isFullyContained(group, rect))
    .sort(
      (a, b) =>
        b.width * b.height - a.width * a.height || a.id.localeCompare(b.id),
    );
};

// Named geography: membership is full-rect containment inside the group rect.
// Members are non-group nodes only; with nesting, a node inside an inner
// region is a member of EVERY containing region. Region-in-region structure
// is exposed via regionStack / childRegions, not via members.
export const groupMembers = (doc: CanvasDoc): ReadonlyMap<string, ReadonlyArray<string>> => {
  const groups = doc.nodes.filter(isGroup);
  const members = new Map<string, string[]>();
  for (const group of groups) {
    members.set(
      group.id,
      doc.nodes
        .filter((node) => node.id !== group.id && !isGroup(node) && isFullyContained(group, node))
        .map((node) => node.id),
    );
  }
  return members;
};

/** Groups fully contained inside `groupId`'s rect (all descendants, document order). */
export const childRegions = (
  doc: CanvasDoc,
  groupId: string,
): ReadonlyArray<GroupNode> => {
  const group = doc.nodes.find((node) => node.id === groupId);
  if (!group || !isGroup(group)) return [];
  return doc.nodes
    .filter(isGroup)
    .filter((candidate) => candidate.id !== groupId && isFullyContained(group, candidate));
};
