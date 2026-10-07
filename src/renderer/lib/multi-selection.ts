import type { Node, Seat } from "@shared/model";

/**
 * Surface key for multi-select kind actions.
 * Same key across the selection → kind-specific controls; mixed → generic only.
 */
export type MultiSurfaceKey =
  | "region"
  | "kind:agent"
  | "kind:terminal"
  | "kind:task"
  | "kind:requests"
  | "kind:artifacts"
  | "kind:watcher"
  | "kind:timer"
  | "kind:page"
  | "type:text"
  | "type:file"
  | "type:link"
  | `kind:${string}`
  | `type:${string}`;

export function surfaceLabel(surface: MultiSurfaceKey): string {
  if (surface === "region") return "regions";
  if (surface.startsWith("kind:")) return `${surface.slice(5)}s`;
  if (surface.startsWith("type:")) return `${surface.slice(5)}s`;
  return surface;
}

/** "1 agent" / "3 agents" — the count line every agent action shows. */
export const agentCountLabel = (count: number): string =>
  `${count} agent${count === 1 ? "" : "s"}`;

// ── The same questions of nodes as the store holds them ─────────────────────
export type SelectionClassOf =
  | { readonly mode: "empty" }
  | { readonly mode: "single"; readonly node: Node }
  | { readonly mode: "homogeneous"; readonly surface: MultiSurfaceKey; readonly nodes: ReadonlyArray<Node> }
  | { readonly mode: "heterogeneous"; readonly nodes: ReadonlyArray<Node>; readonly surfaces: ReadonlyArray<MultiSurfaceKey> };

/** The surface key of a node, in the same words the document form gave. */
export const surfaceKeyOf = (node: Node): MultiSurfaceKey => {
  switch (node.kind) {
    case "region":
      return "region";
    case "note":
      return "type:text";
    case "file":
      return "type:file";
    case "link":
      return "type:link";
    default:
      return `kind:${node.kind}`;
  }
};

export const classifySelectionOf = (nodes: ReadonlyArray<Node>): SelectionClassOf => {
  const only = nodes[0];
  if (only === undefined) return { mode: "empty" };
  if (nodes.length === 1) return { mode: "single", node: only };
  const surfaces = nodes.map(surfaceKeyOf);
  const first = surfaces[0];
  if (first !== undefined && surfaces.every((surface) => surface === first)) {
    return { mode: "homogeneous", surface: first, nodes };
  }
  return { mode: "heterogeneous", nodes, surfaces: [...new Set(surfaces)] };
};

/** Human label for the multi command card meta line. */
export const selectionLabelOf = (classified: SelectionClassOf): string => {
  switch (classified.mode) {
    case "empty":
      return "no selection";
    case "single":
      return "1 selected";
    case "homogeneous":
      return `${classified.nodes.length} - ${surfaceLabel(classified.surface)}`;
    case "heterogeneous":
      return `${classified.nodes.length} - mixed`;
  }
};

/** The seats among `nodes`, in input order. */
export const seatsAmong = (nodes: ReadonlyArray<Node>): ReadonlyArray<Seat> =>
  nodes.filter((node): node is Seat => node.kind === "agent");

/** Ids of the seats among `nodes`, in input order. */
export const seatIdsAmong = (nodes: ReadonlyArray<Node>): ReadonlyArray<string> =>
  seatsAmong(nodes).map((seat) => seat.id);

/** Agent keys for the multi-prompt label, one per seat. */
export const agentKeysAmong = (
  nodes: ReadonlyArray<Node>,
): ReadonlyArray<{ readonly nodeId: string; readonly agentKey: string }> =>
  seatsAmong(nodes).map((seat) => ({ nodeId: seat.id, agentKey: seat.agentKey }));
