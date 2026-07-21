import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import { formatNodeRef, type NodeRefKey } from "@shared/node-ref";

// Edges are the browser capability system for process-bound callers.
// Kernel-enforced per call (same doctrine as work authz):
//   CONNECTED agent|herdr → page: full browser interaction for that page
//   Everything else: invisible / ScopeError naming the missing edge
//
// Capability leases remain a transitional transport; human-drawn edges are
// the product authority for agents that already run on the canvas.

export type BrowserCallerKind = "agent" | "herdr";

export const BROWSER_CALLER_KINDS = new Set<string>(["agent", "herdr"]);

export type BrowserAuthzDenial =
  | "caller_missing"
  | "caller_wrong_kind"
  | "not_connected"
  | "page_missing";

export interface BrowserCallerPrincipal {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly kind: BrowserCallerKind;
  /** Stable sessions owner id for process-bound grants. */
  readonly auditOwnerId: string;
  /** Hermes agent key when kind is agent (entity.name). */
  readonly agentKey?: string;
  /** Herdr pane id when present on the node. */
  readonly paneId?: string;
}

export const nodeKind = (node: CanvasNode | undefined): string | undefined =>
  node?.ether?.entity?.kind;

export const findNode = (doc: CanvasDoc, nodeId: string): CanvasNode | undefined =>
  doc.nodes.find((n) => n.id === nodeId);

/** Undirected: any edge between a and b counts as connected. */
export const areConnected = (doc: CanvasDoc, a: string, b: string): boolean => {
  if (a === b) return true;
  return doc.edges.some(
    (e) =>
      (e.fromNode === a && e.toNode === b) || (e.fromNode === b && e.toNode === a),
  );
};

export const isBrowserCallerKind = (kind: string | undefined): kind is BrowserCallerKind =>
  kind !== undefined && BROWSER_CALLER_KINDS.has(kind);

export const isPageNode = (node: CanvasNode | undefined): boolean =>
  node !== undefined && node.type === "link" && nodeKind(node) === "page";

/**
 * Resolve a canvas node as a browser automation caller. Only agent and herdr
 * nodes may hold process-bound browser authority.
 */
export const resolveBrowserCaller = (
  doc: CanvasDoc,
  canvasName: string,
  nodeId: string,
):
  | { readonly ok: true; readonly principal: BrowserCallerPrincipal }
  | { readonly ok: false; readonly denial: BrowserAuthzDenial } => {
  const node = findNode(doc, nodeId);
  if (!node) return { ok: false, denial: "caller_missing" };
  const kind = nodeKind(node);
  if (!isBrowserCallerKind(kind)) return { ok: false, denial: "caller_wrong_kind" };

  const agentKey =
    kind === "agent" && typeof node.ether?.entity?.name === "string"
      ? node.ether.entity.name
      : undefined;
  const paneId =
    kind === "herdr" && typeof node.ether?.herdr?.paneId === "string"
      ? node.ether.herdr.paneId
      : undefined;

  return {
    ok: true,
    principal: {
      canvasName,
      nodeId,
      kind,
      auditOwnerId: `edge:${canvasName}/${nodeId}`,
      ...(agentKey !== undefined ? { agentKey } : {}),
      ...(paneId !== undefined ? { paneId } : {}),
    },
  };
};

/** Page node ids directly edge-connected to the caller. */
export const connectedPageNodeIds = (
  doc: CanvasDoc,
  callerId: string,
): ReadonlyArray<string> => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const edge of doc.edges) {
    const other =
      edge.fromNode === callerId
        ? edge.toNode
        : edge.toNode === callerId
          ? edge.fromNode
          : undefined;
    if (other === undefined || seen.has(other)) continue;
    const node = findNode(doc, other);
    if (!isPageNode(node)) continue;
    seen.add(other);
    out.push(other);
  }
  return out.sort((a, b) => a.localeCompare(b));
};

/** Canonical page refs the caller may act on via edge authority. */
export const connectedPageRefs = (
  doc: CanvasDoc,
  canvasName: string,
  callerId: string,
): ReadonlyArray<NodeRefKey> => {
  const refs: NodeRefKey[] = [];
  for (const nodeId of connectedPageNodeIds(doc, callerId)) {
    try {
      refs.push(formatNodeRef({ canvasName, nodeId }));
    } catch {
      // Skip malformed ids rather than fail the whole listing.
    }
  }
  return refs;
};

/** True when the caller has an undirected edge to the given page node id. */
export const callerMayAccessPage = (
  doc: CanvasDoc,
  callerId: string,
  pageNodeId: string,
): boolean => {
  if (!areConnected(doc, callerId, pageNodeId)) return false;
  return isPageNode(findNode(doc, pageNodeId));
};

export const browserAuthzMessage = (denial: BrowserAuthzDenial): string => {
  switch (denial) {
    case "caller_missing":
      return "caller node not found on canvas — process is bound to a missing node";
    case "caller_wrong_kind":
      return "caller must be an agent or herdr node";
    case "not_connected":
      return "missing edge between caller and page — draw an edge in Vellum";
    case "page_missing":
      return "page node not found or not a page";
  }
};
