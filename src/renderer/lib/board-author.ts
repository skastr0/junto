import { asNodeId, type Canvas } from "@shared/model";
import type { BoardAuthor } from "@shared/work-model";
import { titleOf } from "@shared/model/title";

/**
 * Resolve the human-facing board author from the live canvas projection.
 *
 * Board facts intentionally retain node/seat references as identity. Older
 * facts may also carry the node id as their display label, so prefer the
 * current authored agent title whenever that node is still present and fall
 * back to the stored label or identity for historical/off-canvas authors.
 */
export const boardAuthorLabel = (
  author: BoardAuthor,
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
