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
  type ActorKindName,
  type CapabilityViewOptions,
} from "@shared/physics";
import { Result } from "effect";

// Edges are the browser capability system for process-bound callers.
// Kernel-enforced per call via factory physics:
//   CONNECTED actor → page port browser.automate
//   Region co-membership alone never grants browser access
//   Everything else: invisible / ScopeError naming the missing edge
//
// Capability leases remain a transitional transport; human-drawn edges are
// the product authority for agents that already run on the canvas. Eligibility
// is the factory role and nothing else — no plane below this one keeps a kind
// ACL, so a kind that stops being an actor stops being a browser caller with
// no edit here.

export type BrowserAuthzDenial =
  | "caller_missing"
  | "caller_wrong_kind"
  | "not_connected"
  | "page_missing";

export interface BrowserCallerPrincipal {
  readonly canvasName: string;
  readonly nodeId: string;
  /** The physics actor kinds — a caller is admitted by role, never by an ACL. */
  readonly kind: ActorKindName;
  /** Stable sessions owner id for process-bound grants. */
  readonly auditOwnerId: string;
  /** Hermes agent key when kind is agent (entity.name). */
  readonly agentKey?: string;
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
 * BROWSER_CALLER_KINDS ACL table. Geography (herdr, regions, notes) is not an
 * actor, so it is refused here with no edit to this file.
 */
export const isBrowserCallerNode = (node: CanvasNode | undefined): boolean => {
  if (!node) return false;
  const spec = resolveSpec({ kind: nodeKind(node), isGroup: isGroup(node) });
  return roleOf(spec) === "actor";
};

/** Type-narrow to the physics actor kinds. No hand-picked subset. */
export const isBrowserCallerKind = (kind: string | undefined): kind is ActorKindName => {
  if (kind === undefined || !isWellKnownKind(kind)) return false;
  // Resolve as a non-group entity of that kind.
  return roleOf(resolveSpec({ kind, isGroup: false })) === "actor";
};

export const isPageNode = (node: CanvasNode | undefined): boolean =>
  node !== undefined && node.type === "link" && nodeKind(node) === "page";

/**
 * Resolve a canvas actor against the browser port. Graph physics decides, and
 * it is the only decision: the process-bind boundary adds liveness, never a
 * narrower kind set. Region membership alone is never enough.
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

  // One actor kind, and it carries both: the agent seat *is* a managed terminal,
  // so name and binding come off the same node rather than one per kind.
  const agentKey =
    typeof node.ether?.entity?.name === "string" ? node.ether.entity.name : undefined;
  const bindingId =
    typeof node.ether?.terminal?.bindingId === "string"
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
      ...(bindingId !== undefined ? { bindingId } : {}),
    },
  };
};

/**
 * Admit caller → page for browser.automate via factory physics.
 * Requires undirected edge + actor role + page offers the port.
 * Region co-membership alone returns false (not_connected / invisible).
 * Optional view options carry placement topology (I18) when the caller
 * knows the Command Center host id.
 */
export const admitBrowserPage = (
  doc: CanvasDoc,
  callerId: string,
  pageNodeId: string,
  viewOptions?: CapabilityViewOptions,
): boolean => {
  const view = canvasDocToCapabilityView(doc, viewOptions);
  const result = admitPure(
    view,
    asNodeId(callerId),
    asNodeId(pageNodeId),
    "browser.automate",
  );
  return Result.isSuccess(result);
};

/** Page node ids the caller may automate (edge + physics port admit). */
export const connectedPageNodeIds = (
  doc: CanvasDoc,
  callerId: string,
  viewOptions?: CapabilityViewOptions,
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
    if (!admitBrowserPage(doc, callerId, other, viewOptions)) continue;
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
  viewOptions?: CapabilityViewOptions,
): ReadonlyArray<NodeRefKey> => {
  const refs: NodeRefKey[] = [];
  for (const nodeId of connectedPageNodeIds(doc, callerId, viewOptions)) {
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
      return "caller must be an actor node — geography (herdr, regions, notes) holds no browser grant";
    case "not_connected":
      return "missing edge between caller and page — draw an edge in Vellum Command";
    case "page_missing":
      return "page node not found or not a page";
  }
};
