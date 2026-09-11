import type { CanvasNode } from "@shared/canvas";
import { requestsNodeName } from "@shared/requests-node-identity";

// Shared by LinkNode.tsx and PageCard.tsx — the host to show for a link/page
// card. Falls back to a naive scheme-strip rather than the raw url (unlike
// nodeTitle below) so a malformed url still renders a short, glanceable label.
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] ?? url;
  }
};

/** Bare map text (geography). No connectors, ports, or factory seat. */
export const isLabelNode = (node: CanvasNode): boolean =>
  node.ether?.entity?.kind === "label";

/** Git commit browser (geography). No connectors, ports, or factory seat. */
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
  ...(node.ether?.flags ?? []),
].join(" ").toLowerCase();

// The honest user-facing noun for a node: note / file / link / region, or the
// entity kind (project / agent / …) when one is present. Never "signal".
export const nodeTypeLabel = (node: CanvasNode): string => {
  if (node.ether?.entity?.kind) return node.ether.entity.kind;
  if (node.type === "text") return "note";
  if (node.type === "group") return "region";
  return node.type;
};

export const nodeTitle = (node: CanvasNode): string => {
  // Artifacts shelf has no authorial name — node.text mirrors artifact names
  // and shifts on rename/archive/delete — so its title stays the kind label.
  if (node.ether?.entity?.kind === "artifacts") return "artifacts";
  if (node.type === "text") {
    // Requests identity is authored (ether.requests.name), not the mechanical
    // mirror's first line — the mirror is rewritten on every work op.
    if (node.ether?.entity?.kind === "requests") return requestsNodeName(node);
    return node.text.split("\n")[0]?.replace(/^#+\s*/, "") || "untitled";
  }
  if (node.type === "file") return node.file.split("/").filter(Boolean).pop() ?? node.file;
  if (node.type === "link") {
    try { return new URL(node.url).host; } catch { return node.url; }
  }
  return node.label ?? "region";
};

export const nodeDetail = (node: CanvasNode): string => {
  if (node.type === "text") {
    const detail = node.text.split("\n").slice(1).join(" ").trim();
    if (detail) return detail;
  }
  if (node.type === "file") return node.subpath ? `${node.file} ${node.subpath}` : node.file;
  if (node.type === "link") return node.url;
  if (node.type === "group") return "Spatial region";
  const entity = node.ether?.entity;
  if (entity?.kind === "git") {
    const cwd = node.ether?.git?.cwd?.trim();
    if (cwd) return cwd;
  }
  if (entity?.name) return `${entity.kind} - ${entity.name}`;
  return "";
};
