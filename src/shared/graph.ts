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

// The single membership predicate (I9): a node is a region member only when
// its FULL bounding rect lies inside the region's rect — a node partially
// overlapping a region is out. Promoted from the kernel's stricter rule
// (formerly duplicated center-point rules in kernel/cycle.ts and
// renderer/lib/geometry.ts); every membership consumer — kernel pulse
// delivery, region rollups, digest, work, and renderer displays — derives
// from this one function. Renderer keeps a separate, explicitly non-membership
// helper for drag-hold interaction (center-point, includes nested regions).
const isFullyContained = (group: GroupNode, node: CanvasNode): boolean =>
  node.x >= group.x &&
  node.y >= group.y &&
  node.x + node.width <= group.x + group.width &&
  node.y + node.height <= group.y + group.height;

// Named geography: membership is full-rect containment inside the group
// rect. Groups never contain groups (flat, POC rule).
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
