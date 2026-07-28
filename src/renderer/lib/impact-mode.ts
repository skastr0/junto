// Selection impact mode: project pure stoppage cones onto the canvas UI.
// Prefers the live kernel ExecutionSnapshot (phase/blocked/reasons); reconstructs
// edgeEval + seedNodeIds so impactCone can run without a second glyph fetch.

import { observable } from "@legendapp/state";
import type { CanvasDoc, EdgePhase } from "@shared/canvas";
import type { ExecutionSnapshot } from "@shared/ipc";
import {
  deriveExecutionGraph,
  isBlockableNode,
  type BlockedReason,
  type EdgeEval,
  type ExecutionGraph,
  type ExecutionGraphContext,
} from "@shared/execution-graph";
import { impactCone, type ImpactCone } from "@shared/impact";

/** True while the open canvas is painting a stoppage cone. CanvasGraph
 * subscribes to this boolean only — never to doc/execution — so kernel ticks
 * do not re-render React Flow just to keep `.impact-mode` in sync. */
export const impactModeActive$ = observable(false);

export type ImpactSelection = {
  readonly active: boolean;
  readonly cone: ImpactCone;
  /** Short HUD line when active (seed/reason count). */
  readonly seedLabel: string;
};

const emptySelection = (
  rootId: string,
  context: ExecutionGraphContext,
): ImpactSelection => ({
  active: false,
  cone: impactCone(
    { nodes: [], edges: [] },
    deriveExecutionGraph({ nodes: [], edges: [] }, context),
    rootId,
  ),
  seedLabel: "",
});

/** Build an ExecutionGraph suitable for impactCone from live kernel data. */
export const executionGraphForImpact = (
  doc: CanvasDoc,
  execution: ExecutionSnapshot | null | undefined,
  context: ExecutionGraphContext,
): ExecutionGraph => {
  if (!execution) return deriveExecutionGraph(doc, context);

  const phaseByEdgeId = new Map<string, EdgePhase>();
  const detailByEdgeId = new Map<string, string>();
  const edgeEvalById = new Map<string, EdgeEval>();

  for (const edge of doc.edges) {
    const phase =
      (execution.phaseByEdgeId[edge.id] as EdgePhase | undefined) ?? "relates";
    const detail = execution.detailByEdgeId[edge.id] ?? "";
    phaseByEdgeId.set(edge.id, phase);
    detailByEdgeId.set(edge.id, detail);
    edgeEvalById.set(edge.id, {
      phase: phase === "blocks" ? "blocks" : "relates",
      detail,
      generates: phase === "blocks",
    });
  }

  const seedNodeIds = new Set<string>();
  for (const node of doc.nodes) {
    if (node.ether?.flags?.includes("blocker") && isBlockableNode(node)) {
      seedNodeIds.add(node.id);
    }
  }

  const reasonsByNodeId = new Map<string, ReadonlyArray<BlockedReason>>();
  for (const [id, reasons] of Object.entries(execution.reasonsByNodeId ?? {})) {
    reasonsByNodeId.set(id, reasons as ReadonlyArray<BlockedReason>);
  }

  return {
    phaseByEdgeId,
    detailByEdgeId,
    edgeEvalById,
    blocked: new Set(execution.blocked),
    blockedEdgeIds: new Set(execution.blockedEdgeIds),
    reasonsByNodeId,
    seedNodeIds,
  };
};

const reasonBrief = (reason: BlockedReason): string => {
  if (reason.kind === "edge") return reason.detail || "generating edge";
  if (reason.kind === "seed") return reason.detail || "manual seed";
  return "relay";
};

/** Derive the stoppage cone for the selected node (empty when outside cone). */
export const selectionImpact = (
  doc: CanvasDoc,
  rootNodeId: string,
  execution: ExecutionSnapshot | null | undefined,
  context: ExecutionGraphContext,
): ImpactSelection => {
  if (!rootNodeId) return emptySelection("", context);

  const graph = executionGraphForImpact(doc, execution, context);
  const cone = impactCone(doc, graph, rootNodeId);
  if (cone.nodeIds.size === 0) {
    return { active: false, cone, seedLabel: "" };
  }

  const seeds = cone.seedReasons;
  const primary = seeds[0] ? reasonBrief(seeds[0]) : "stoppage";
  const extra = seeds.length > 1 ? ` · +${seeds.length - 1}` : "";
  const seedLabel = `${cone.nodeIds.size} in cone · ${primary}${extra}`;

  return { active: true, cone, seedLabel };
};

/**
 * CSS class for a node while impact mode is active.
 *
 * Outsiders intentionally get `undefined` — `.react-flow.impact-mode` CSS
 * dims every node by default, so we only remint shell identity for cone /
 * attention-lead members. Stamping `impact-out` on every outsider used to
 * clone the whole graph on each selection change.
 */
export const nodeImpactClass = (
  active: boolean,
  cone: ImpactCone,
  nodeId: string,
): string | undefined => {
  if (!active) return undefined;
  if (cone.nodeIds.has(nodeId)) {
    return nodeId === cone.rootId ? "impact-in impact-root" : "impact-in";
  }
  if (cone.attentionLeadIds.has(nodeId)) return "impact-lead";
  return undefined;
};

/** CSS class for an edge wrapper while impact mode is active (in-cone only). */
export const edgeImpactClass = (
  active: boolean,
  cone: ImpactCone,
  edgeId: string,
): string | undefined => {
  if (!active) return undefined;
  if (cone.edgeIds.has(edgeId)) return "impact-edge-in";
  return undefined;
};

/** Edge data.impact token for EtherEdge path/label styling (in-cone only). */
export const edgeImpactRole = (
  active: boolean,
  cone: ImpactCone,
  edgeId: string,
): "in" | undefined => {
  if (!active) return undefined;
  return cone.edgeIds.has(edgeId) ? "in" : undefined;
};
