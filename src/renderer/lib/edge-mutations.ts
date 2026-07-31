import { ulid } from "ulid";
import type { CanvasEdge, CanvasNode, EdgeCriteria, EdgeEnd } from "@shared/canvas";
import type { Port } from "@shared/physics";
import { state$ } from "./state";
import { commitDoc, parseSide } from "./mutations";

const without = <T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> => {
  const { [key]: _removed, ...rest } = value;
  return rest;
};

export const deleteEdges = (ids: ReadonlyArray<string>): void => {
  const removed = new Set(ids);
  if (removed.size === 0) return;
  const doc = state$.doc.peek();
  const existingEdges = doc.edges.filter((edge) => removed.has(edge.id));
  if (existingEdges.length === 0) return;
  const label = existingEdges.length === 1 ? "this relation" : `${existingEdges.length} relations`;
  if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(`Delete ${label}?`)) return;
  if (removed.has(state$.selectedEdgeId.peek())) state$.selectedEdgeId.set("");
  commitDoc({ ...doc, edges: doc.edges.filter((edge) => !removed.has(edge.id)) });
};

export const setEdgeColor = (id: string, color?: string): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    edges: doc.edges.map((edge) =>
      edge.id === id ? (color ? { ...edge, color } : without(edge, "color")) : edge,
    ),
  });
};

export const setEdgeCriteria = (id: string, criteria: EdgeCriteria | undefined): void => {
  const doc = state$.doc.peek();
  const cleaned = criteria;
  commitDoc({
    ...doc,
    edges: doc.edges.map((edge) => {
      if (edge.id !== id) return edge;
      if (!cleaned) {
        if (!edge.ether) return edge;
        const rest = without(without(edge.ether, "criteria"), "kind");
        return Object.keys(rest).length > 0 ? { ...edge, ether: rest } : without(edge, "ether");
      }
      const rest = edge.ether ? without(edge.ether, "kind") : {};
      return { ...edge, ether: { ...rest, criteria: cleaned } };
    }),
  });
};

/**
 * Set or clear edge.ether.ports (ocap attenuation).
 * `undefined` or empty array removes the field; absence ⇒ full offers at admit.
 * Does not strip criteria / derived kind.
 */
export const setEdgePorts = (
  id: string,
  ports: ReadonlyArray<Port> | undefined,
): void => {
  const doc = state$.doc.peek();
  const cleaned = ports && ports.length > 0 ? [...ports] : undefined;
  commitDoc({
    ...doc,
    edges: doc.edges.map((edge) => {
      if (edge.id !== id) return edge;
      if (!cleaned) {
        if (!edge.ether || edge.ether.ports === undefined) return edge;
        const rest = without(edge.ether, "ports");
        return Object.keys(rest).length > 0
          ? { ...edge, ether: rest }
          : without(edge, "ether");
      }
      return { ...edge, ether: { ...(edge.ether ?? {}), ports: cleaned } };
    }),
  });
};

export const editEdgeLabel = (id: string, label: string): void => {
  const doc = state$.doc.peek();
  const nextLabel = label.trim();
  commitDoc({
    ...doc,
    edges: doc.edges.map((edge) =>
      edge.id === id ? (nextLabel ? { ...edge, label: nextLabel } : without(edge, "label")) : edge,
    ),
  });
};

export const toggleEdgeArrow = (id: string, side: "from" | "to"): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    edges: doc.edges.map((edge) => {
      if (edge.id !== id) return edge;
      const next: EdgeEnd | undefined = side === "from"
        ? (edge.fromEnd === "arrow" ? undefined : "arrow")
        : (edge.toEnd === "arrow" ? undefined : "arrow");
      if (side === "from") {
        return next ? { ...edge, fromEnd: next } : without(edge, "fromEnd");
      }
      return next ? { ...edge, toEnd: next } : without(edge, "toEnd");
    }),
  });
};

/**
 * Infer live criteria from the source node.
 * - tasks / requests node → tasks criteria
 * - otherwise → none (soft relates); WIP/glyphs are explicit opt-in
 */
export const inferEdgeCriteria = (fromNode: CanvasNode | undefined): EdgeCriteria | undefined => {
  if (!fromNode) return undefined;
  const kind = fromNode.ether?.entity?.kind;
  if (kind === "task" || kind === "requests") return { mode: "tasks" };
  // board → soft relates only (never stoppage)
  return undefined;
};

/** Operator-authored board wake eligibility on an edge. */
export const setEdgeNotify = (edgeId: string, notify: boolean): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    edges: doc.edges.map((edge) => {
      if (edge.id !== edgeId) return edge;
      const ether = { ...(edge.ether ?? {}) };
      if (notify) ether.notify = true;
      else delete ether.notify;
      const nextEther = Object.keys(ether).length > 0 ? ether : undefined;
      if (!nextEther) {
        const { ether: _drop, ...rest } = edge;
        return rest;
      }
      return { ...edge, ether: nextEther };
    }),
  });
};

export const addEdge = (params: {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  criteria?: EdgeCriteria;
}): void => {
  if (params.source === params.target) {
    state$.error.set("A node cannot connect to itself.");
    return;
  }
  const doc = state$.doc.peek();
  if (doc.edges.some((edge) => edge.fromNode === params.source && edge.toNode === params.target)) {
    state$.error.set("That relation already exists.");
    return;
  }
  const fromNode = doc.nodes.find((node) => node.id === params.source);
  const criteria = params.criteria ?? inferEdgeCriteria(fromNode);
  const fromSide = parseSide(params.sourceHandle);
  const toSide = parseSide(params.targetHandle);
  const edge: CanvasEdge = {
    id: `edge-${ulid()}`,
    fromNode: params.source,
    toNode: params.target,
    ...(fromSide ? { fromSide } : {}),
    ...(toSide ? { toSide } : {}),
    ...(criteria ? { ether: { criteria } } : {}),
  };
  state$.selectedNodeId.set("");
  state$.selectedEdgeId.set(edge.id);
  state$.error.set("");
  commitDoc({ ...doc, edges: [...doc.edges, edge] });
};

// --- multi-source → one target (RTS-006) ------------------------------------
// Pure plan + one commit mutator. Soft relates by default (tasks still auto-bind
// via inferEdgeCriteria, matching single-edge connect). Direction is always
// source → target (fromNode → toNode), same as addEdge / Inspector connect.

export type EdgeBatchSkipReason =
  | "self"
  | "duplicate"
  | "missing-source"
  | "group-source"
  | "invalid-target";

export type EdgeBatchCandidate = {
  readonly fromNode: string;
  readonly toNode: string;
  readonly criteria?: EdgeCriteria;
};

export type EdgeBatchPlan = {
  readonly toAdd: ReadonlyArray<EdgeBatchCandidate>;
  readonly skipped: ReadonlyArray<{ readonly source: string; readonly reason: EdgeBatchSkipReason }>;
};

/**
 * Pure planner: given selected source ids and a target, compute which soft
 * relates edges to create. Does not touch state, ids, or the document.
 * - Skips self, groups-as-sources, missing sources, duplicates (existing or
 *   within the batch).
 * - Invalid target (missing / group) skips every source with `invalid-target`.
 * - Criteria: optional override per batch; else inferred per source (tasks →
 *   tasks criteria; otherwise none = soft relates).
 */
export const planConnectToTarget = (
  sourceIds: ReadonlyArray<string>,
  targetId: string,
  nodes: ReadonlyArray<CanvasNode>,
  edges: ReadonlyArray<CanvasEdge>,
  criteriaOverride?: EdgeCriteria,
): EdgeBatchPlan => {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const target = nodeById.get(targetId);
  if (!target || target.type === "group") {
    return {
      toAdd: [],
      skipped: sourceIds.map((source) => ({ source, reason: "invalid-target" as const })),
    };
  }

  const existing = new Set(edges.map((edge) => `${edge.fromNode}->${edge.toNode}`));
  const planned = new Set<string>();
  const toAdd: EdgeBatchCandidate[] = [];
  const skipped: Array<{ source: string; reason: EdgeBatchSkipReason }> = [];

  for (const sourceId of sourceIds) {
    if (sourceId === targetId) {
      skipped.push({ source: sourceId, reason: "self" });
      continue;
    }
    const source = nodeById.get(sourceId);
    if (!source) {
      skipped.push({ source: sourceId, reason: "missing-source" });
      continue;
    }
    if (source.type === "group") {
      skipped.push({ source: sourceId, reason: "group-source" });
      continue;
    }
    const key = `${sourceId}->${targetId}`;
    if (existing.has(key) || planned.has(key)) {
      skipped.push({ source: sourceId, reason: "duplicate" });
      continue;
    }
    planned.add(key);
    const criteria = criteriaOverride ?? inferEdgeCriteria(source);
    toAdd.push({
      fromNode: sourceId,
      toNode: targetId,
      ...(criteria ? { criteria } : {}),
    });
  }

  return { toAdd, skipped };
};

/**
 * Commit edges from each valid selected source → target in one document write.
 * Soft relates default; preserves selection when `keepSelection` (shift-RMB
 * multi-target convenience). Returns the plan for callers/tests.
 */
export const connectAllToTarget = (
  sourceIds: ReadonlyArray<string>,
  targetId: string,
  options?: { readonly keepSelection?: boolean; readonly criteria?: EdgeCriteria },
): EdgeBatchPlan => {
  const doc = state$.doc.peek();
  const plan = planConnectToTarget(sourceIds, targetId, doc.nodes, doc.edges, options?.criteria);
  if (plan.toAdd.length === 0) {
    const reasons = new Set(plan.skipped.map((item) => item.reason));
    if (reasons.has("invalid-target")) {
      state$.error.set("Cannot connect to that target.");
    } else if (reasons.size === 1 && reasons.has("self")) {
      state$.error.set("A node cannot connect to itself.");
    } else if (reasons.has("duplicate") && plan.skipped.length === sourceIds.length) {
      state$.error.set("That relation already exists.");
    } else if (plan.skipped.length > 0) {
      state$.error.set("No new relations to create.");
    }
    return plan;
  }

  const newEdges: CanvasEdge[] = plan.toAdd.map((candidate) => ({
    id: `edge-${ulid()}`,
    fromNode: candidate.fromNode,
    toNode: candidate.toNode,
    ...(candidate.criteria ? { ether: { criteria: candidate.criteria } } : {}),
  }));

  if (!options?.keepSelection) {
    state$.selectedNodeId.set("");
    state$.selectedNodeIds.set([]);
    state$.selectedEdgeId.set(newEdges[newEdges.length - 1]?.id ?? "");
  }
  state$.error.set("");
  commitDoc({ ...doc, edges: [...doc.edges, ...newEdges] });
  return plan;
};
