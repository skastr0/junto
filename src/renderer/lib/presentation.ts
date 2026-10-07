import type { CanvasNode } from "@shared/canvas";

// Shared by LinkNode.tsx and PageCard.tsx — the host to show for a link/page
// card. Falls back to a naive scheme-strip rather than the raw url (unlike
// the full address) so a malformed url still renders a short, glanceable label.
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] ?? url;
  }
};

/** Bare map text (geography). No connectors, ports, or crew seat. */
export const isLabelNode = (node: CanvasNode): boolean =>
  node.ether?.entity?.kind === "label";

/** Git commit browser (geography). No connectors, ports, or crew seat. */
export const isGitNode = (node: CanvasNode): boolean =>
  node.ether?.entity?.kind === "git";

export const searchText = (node: CanvasNode): string => [
  node.type,
  node.type === "text" ? node.text : "",
  node.type === "file" ? node.file : "",
  node.type === "file" ? node.subpath ?? "" : "",
  node.type === "link" ? node.url : "",
  node.type === "group" ? node.label ?? "" : "",
  node.ether?.entity?.kind ?? "",
  node.ether?.entity?.name ?? "",
  node.ether?.git?.cwd ?? "",
].join(" ").toLowerCase();

// The honest user-facing noun for a node: note / file / link / region, or the
// entity kind (project / agent / …) when one is present. Never "signal".
export const nodeTypeLabel = (node: CanvasNode): string => {
  if (node.ether?.entity?.kind) return node.ether.entity.kind;
  if (node.type === "text") return "note";
  if (node.type === "group") return "region";
  return node.type;
};
