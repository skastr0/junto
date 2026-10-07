import type { CanvasNode, GroupNode } from "./canvas";
import type { ActorRefResolver } from "./attention";
import type {
  ExecutionGraphContext,
  WorkItemsOf,
  LiveTrustViews,
} from "./execution-graph";
import type { ActorRef } from "./work-protocol";

// Derived state. Never persisted.

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
  itemsOf: WorkItemsOf,
  trust: LiveTrustViews = {},
): ExecutionGraphContext => ({
  canvasName,
  resolveActorRef: actorRefResolverFromProjection(actorRefs),
  itemsOf,
  ...trust,
});

export const isGroup = (node: CanvasNode): node is GroupNode => node.type === "group";

// A rectangle, as region membership reads one. Membership itself is the
// model's: regionStack and regionMembers in shared/model/canvas.ts.
export type RegionRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/**
 * Region nesting is authoring-time-warned past this depth (UI only) — never a
 * hard data rejection. Renderer z bands rely on typical depths staying below
 * the edge band.
 */
export const MAX_REGION_DEPTH = 8;

/** What a region with an empty label is called, everywhere it is named. */
export const UNNAMED_REGION = "unnamed region";

/**
 * A region's display name: its trimmed label, or the one placeholder when the
 * label is empty. An unnamed region is still a region, so region paths,
 * rollups and titles all name it here and never leave it out.
 */
export const regionDisplayName = (group: GroupNode): string =>
  group.label?.trim() || UNNAMED_REGION;
