import type { CanvasNode } from "@shared/canvas";

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

export type MultiSelectionClass =
  | { readonly mode: "empty" }
  | { readonly mode: "single"; readonly node: CanvasNode }
  | {
      readonly mode: "homogeneous";
      readonly surface: MultiSurfaceKey;
      readonly nodes: ReadonlyArray<CanvasNode>;
    }
  | {
      readonly mode: "heterogeneous";
      readonly nodes: ReadonlyArray<CanvasNode>;
      readonly surfaces: ReadonlyArray<MultiSurfaceKey>;
    };

/** Classify a node for multi-select action surfaces (not single-select command card). */
export function multiSurfaceKey(node: CanvasNode): MultiSurfaceKey {
  if (node.type === "group") return "region";
  const kind = node.ether?.entity?.kind;
  if (typeof kind === "string" && kind.length > 0) {
    return `kind:${kind}` as MultiSurfaceKey;
  }
  return `type:${node.type}` as MultiSurfaceKey;
}

export function classifyMultiSelection(
  nodes: ReadonlyArray<CanvasNode>,
): MultiSelectionClass {
  if (nodes.length === 0) return { mode: "empty" };
  if (nodes.length === 1) {
    const node = nodes[0];
    if (!node) return { mode: "empty" };
    return { mode: "single", node };
  }
  const surfaces = nodes.map(multiSurfaceKey);
  const first = surfaces[0];
  if (first !== undefined && surfaces.every((s) => s === first)) {
    return { mode: "homogeneous", surface: first, nodes };
  }
  return {
    mode: "heterogeneous",
    nodes,
    surfaces: [...new Set(surfaces)],
  };
}

/** Human label for the multi command card meta line. */
export function multiSelectionLabel(classified: MultiSelectionClass): string {
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
}

export function surfaceLabel(surface: MultiSurfaceKey): string {
  if (surface === "region") return "regions";
  if (surface.startsWith("kind:")) return `${surface.slice(5)}s`;
  if (surface.startsWith("type:")) return `${surface.slice(5)}s`;
  return surface;
}

/**
 * Agent keys for multi-prompt label/display.
 * Managed-prompt fan-out needs binding ids — use multiPromptTargetsFromNodes.
 */
export function agentKeysFromNodes(
  nodes: ReadonlyArray<CanvasNode>,
): ReadonlyArray<{ readonly nodeId: string; readonly agentKey: string }> {
  const out: Array<{ nodeId: string; agentKey: string }> = [];
  for (const node of nodes) {
    const entity = node.ether?.entity;
    if (entity?.kind === "agent" && typeof entity.name === "string" && entity.name.length > 0) {
      out.push({ nodeId: node.id, agentKey: entity.name });
    }
  }
  return out;
}
