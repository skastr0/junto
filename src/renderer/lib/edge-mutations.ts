import { ulid } from "ulid";
import type { CanvasEdge, EdgeCriteria, EdgeEnd, EtherEdgeKind } from "@shared/canvas";
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

const KIND_CYCLE: Record<EtherEdgeKind, EtherEdgeKind> = {
  blocks: "depends",
  depends: "relates",
  relates: "blocks",
};

export const cycleEdgeKind = (id: string): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    edges: doc.edges.map((edge) => {
      if (edge.id !== id) return edge;
      // Criteria edges are live — cycling kind would fight derivation. Clear
      // criteria first if present; otherwise cycle the legacy pin.
      if (edge.ether?.criteria) {
        const { criteria: _c, ...rest } = edge.ether;
        return { ...edge, ether: { ...rest, kind: "relates" } };
      }
      const current = edge.ether?.kind ?? "relates";
      return { ...edge, ether: { ...edge.ether, kind: KIND_CYCLE[current] } };
    }),
  });
};

export const setEdgeCriteria = (id: string, criteria: EdgeCriteria | undefined): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    edges: doc.edges.map((edge) => {
      if (edge.id !== id) return edge;
      if (!criteria) {
        if (!edge.ether) return edge;
        const { criteria: _c, ...rest } = edge.ether;
        const nextEther = Object.keys(rest).length > 0 ? rest : undefined;
        return nextEther ? { ...edge, ether: nextEther } : { ...edge, ether: undefined };
      }
      return {
        ...edge,
        ether: {
          ...edge.ether,
          criteria,
          // Clear stale pin when attaching live criteria — phase is derived.
          kind: edge.ether?.kind,
        },
      };
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

export const addEdge = (params: {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  kind?: EtherEdgeKind;
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
  const fromSide = parseSide(params.sourceHandle);
  const toSide = parseSide(params.targetHandle);
  const edge: CanvasEdge = {
    id: `edge-${ulid()}`,
    fromNode: params.source,
    toNode: params.target,
    ...(fromSide ? { fromSide } : {}),
    ...(toSide ? { toSide } : {}),
    ether: { kind: params.kind ?? "relates" },
  };
  state$.selectedNodeId.set("");
  state$.selectedEdgeId.set(edge.id);
  state$.error.set("");
  commitDoc({ ...doc, edges: [...doc.edges, edge] });
};
