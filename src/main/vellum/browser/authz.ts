import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import { isGroup } from "@shared/graph";
import { formatNodeRef, type NodeRefKey } from "@shared/node-ref";
import {
  admitPure,
  asNodeId,
  canvasDocToCapabilityView,
  isWellKnownKind,
  resolveSpec,
  roleOf,
} from "@shared/physics";
import { Either } from "effect";

// Edges are the browser capability system for process-bound callers.
// Kernel-enforced per call via factory physics:
//   CONNECTED actor → page port browser.automate
//   Region co-membership alone never grants browser access
//   Everything else: invisible / ScopeError naming the missing edge
//
// Capability leases remain a transitional transport; human-drawn edges are
// the product authority for agents that already run on the canvas. Protected
// process-bind admission further restricts browser callers to agent|herdr;
// native terminals remain actors for non-browser product surfaces.

/** Physics actor kinds; protected process-bind admits the agent|herdr subset. */
export type BrowserCallerKind = "agent" | "herdr" | "terminal";

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
  /** Native terminal binding id when kind is terminal. */
  readonly bindingId?: string;
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

/**
 * Actor seat eligibility via physics roleOf/resolveSpec — not a hard-coded
 * BROWSER_CALLER_KINDS ACL table. agent | terminal | herdr are actors.
 */
export const isBrowserCallerNode = (node: CanvasNode | undefined): boolean => {
  if (!node) return false;
  const spec = resolveSpec({ kind: nodeKind(node), isGroup: isGroup(node) });
  return roleOf(spec) === "actor";
};

/** Type-narrow well-known actor kinds (derived from physics KindSpecs). */
export const isBrowserCallerKind = (kind: string | undefined): kind is BrowserCallerKind => {
  if (kind === undefined || !isWellKnownKind(kind)) return false;
  // Resolve as a non-group entity of that kind.
  return roleOf(resolveSpec({ kind, isGroup: false })) === "actor";
};

export const isPageNode = (node: CanvasNode | undefined): boolean =>
  node !== undefined && node.type === "link" && nodeKind(node) === "page";

/**
 * Resolve a canvas actor against the browser port. This is graph physics only:
 * the protected process-bind boundary separately restricts live browser
 * principals to agent|herdr. Region membership alone is never enough.
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
  if (!isBrowserCallerNode(node)) return { ok: false, denial: "caller_wrong_kind" };

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
  const bindingId =
    kind === "terminal" && typeof node.ether?.terminal?.bindingId === "string"
      ? node.ether.terminal.bindingId
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
      ...(bindingId !== undefined ? { bindingId } : {}),
    },
  };
};

/**
 * Admit caller → page for browser.automate via factory physics.
 * Requires undirected edge + actor role + page offers the port.
 * Region co-membership alone returns false (not_connected / invisible).
 */
export const admitBrowserPage = (
  doc: CanvasDoc,
  callerId: string,
  pageNodeId: string,
): boolean => {
  const view = canvasDocToCapabilityView(doc);
  const result = admitPure(
    view,
    asNodeId(callerId),
    asNodeId(pageNodeId),
    "browser.automate",
  );
  return Either.isRight(result);
};

/** Page node ids the caller may automate (edge + physics port admit). */
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
    if (!admitBrowserPage(doc, callerId, other)) continue;
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

/** True when the caller is admitted to browser.automate on the page node. */
export const callerMayAccessPage = (
  doc: CanvasDoc,
  callerId: string,
  pageNodeId: string,
): boolean => {
  if (!isPageNode(findNode(doc, pageNodeId))) return false;
  return admitBrowserPage(doc, callerId, pageNodeId);
};

export const browserAuthzMessage = (denial: BrowserAuthzDenial): string => {
  switch (denial) {
    case "caller_missing":
      return "caller node not found on canvas — process is bound to a missing node";
    case "caller_wrong_kind":
      return "caller must be an actor node (agent, terminal, or herdr)";
    case "not_connected":
      return "missing edge between caller and page — draw an edge in Vellum";
    case "page_missing":
      return "page node not found or not a page";
  }
};
