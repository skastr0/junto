import { isValidProfileId } from "@shared/browser";
import { asNodeId, type Canvas, type NodeOf } from "@shared/model";
import { nodesOf } from "@shared/model/canvas";
import { formatNodeRef, type NodeRefKey } from "@shared/node-ref";

/**
 * Overseer page admission is edge-free: a live overseer may operate every
 * local page on this installation. Same-installation / profile / host
 * constraints stay with BrowserSessionService + admitBrowserHostCapability.
 * Normal agent callers still go through admitBrowserPage / edge-grant.
 */

export type OverseerPageDenial = "page_missing" | "invalid_profile";

export const admitOverseerPage = (
  canvas: Pick<Canvas, "nodes">,
  pageNodeId: string,
):
  | { readonly ok: true; readonly node: NodeOf<"page"> }
  | { readonly ok: false; readonly denial: OverseerPageDenial } => {
  const node = canvas.nodes.get(asNodeId(pageNodeId));
  if (node?.kind !== "page") return { ok: false, denial: "page_missing" };
  if (!isValidProfileId(node.profile)) return { ok: false, denial: "invalid_profile" };
  return { ok: true, node };
};

export const overseerPageNodeIds = (
  canvas: Pick<Canvas, "nodes">,
): ReadonlyArray<string> =>
  nodesOf(canvas, "page")
    .filter((page) => admitOverseerPage(canvas, page.id).ok)
    .map((page) => page.id as string)
    .sort((a, b) => a.localeCompare(b));

export const overseerPageRefs = (
  canvas: Pick<Canvas, "nodes">,
  canvasName: string,
): ReadonlyArray<NodeRefKey> => {
  const refs: NodeRefKey[] = [];
  for (const nodeId of overseerPageNodeIds(canvas)) {
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
