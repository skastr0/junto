import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import { isValidProfileId } from "@shared/browser";
import { formatNodeRef, type NodeRefKey } from "@shared/node-ref";
import { resolveNodeHostId } from "@shared/station";
import { findNode, isPageNode } from "../browser/authz";
import type { BrowserHostCapabilityAdmission } from "../browser/host-capability";

/**
 * Overseer page admission is edge-free: a live overseer may operate every
 * local page on this installation. Same-installation / profile / host
 * constraints stay with BrowserSessionService + admitBrowserHostCapability.
 * Normal agent callers still go through admitBrowserPage / edge-grant.
 */

export type OverseerPageDenial = "page_missing" | "invalid_profile";

export const admitOverseerPage = (
  doc: CanvasDoc,
  pageNodeId: string,
): { readonly ok: true; readonly node: CanvasNode } | { readonly ok: false; readonly denial: OverseerPageDenial } => {
  const node = findNode(doc, pageNodeId);
  if (!isPageNode(node) || node === undefined) {
    return { ok: false, denial: "page_missing" };
  }
  const profile = node.ether?.browser?.profile;
  if (profile === undefined || !isValidProfileId(profile)) {
    return { ok: false, denial: "invalid_profile" };
  }
  return { ok: true, node };
};

export const overseerPageNodeIds = (doc: CanvasDoc): ReadonlyArray<string> => {
  const out: string[] = [];
  for (const node of doc.nodes) {
    if (admitOverseerPage(doc, node.id).ok) out.push(node.id);
  }
  return out.sort((a, b) => a.localeCompare(b));
};

export const overseerPageRefs = (
  doc: CanvasDoc,
  canvasName: string,
): ReadonlyArray<NodeRefKey> => {
  const refs: NodeRefKey[] = [];
  for (const nodeId of overseerPageNodeIds(doc)) {
    try {
      refs.push(formatNodeRef({ canvasName, nodeId }));
    } catch {
      // Skip malformed ids rather than fail the whole listing.
    }
  }
  return refs;
};

export const overseerPageMessage = (denial: OverseerPageDenial): string => {
  switch (denial) {
    case "page_missing":
      return "page node not found or not a page";
    case "invalid_profile":
      return "page node must bind a valid browser profile";
  }
};

export const overseerPageHostId = (node: CanvasNode): string => resolveNodeHostId(node);

export type OverseerHostAdmit = (hostId: string) => BrowserHostCapabilityAdmission;
