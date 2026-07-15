import { ulid } from "ulid";
import type { CanvasEdge, CanvasNode, EdgeCriteria, EdgeEnd } from "@shared/canvas";
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
  // Empty glyphs criteria is a no-op shell — do not store it.
  const cleaned =
    criteria?.mode === "glyphs" && criteria.glyphIds.length === 0 ? undefined : criteria;
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
 * - tasks node → tasks criteria
 * - otherwise → none (soft relates); WIP/glyphs are explicit opt-in
 */
export const inferEdgeCriteria = (fromNode: CanvasNode | undefined): EdgeCriteria | undefined => {
  if (!fromNode) return undefined;
  if (fromNode.ether?.entity?.kind === "task") return { mode: "tasks" };
  return undefined;
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
