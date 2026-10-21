import { asNodeId, type Canvas } from "@shared/model";
import type { Author } from "@shared/author";
import { titleOf } from "@shared/model/title";

/**
 * Resolve the human-facing author of a post from the live canvas projection.
 *
 * Post facts intentionally retain node/seat references as identity. Older
 * facts may also carry the node id as their display label, so prefer the
 * current authored agent title whenever that node is still present and fall
 * back to the stored label or identity for historical/off-canvas authors.
 */
export const authorLabel = (
  author: Author,
  canvas: Pick<Canvas, "nodes">,
): string => {
  if (author.kind === "operator") return author.label ?? "operator";

  const node = author.nodeId
    ? canvas.nodes.get(asNodeId(author.nodeId))
    : undefined;
  if (node !== undefined) {
    const title = titleOf(node).trim();
    if (title && title !== "untitled") return title;
  }

  return author.label ?? author.nodeId ?? "actor";
};
