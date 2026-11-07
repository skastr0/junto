/**
 * A comment's text as pieces: words, and the mentions in it, so a view can
 * draw each mention as a chip that opens. Pure over the canvas's node kinds.
 */
import { mentionLinksOf, mentionRefOf, type MentionRef } from "@shared/mention";
import type { NodeKind } from "@shared/model/kinds";
import type { NodeId } from "@shared/physics/schema";

export type TextPiece =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "mention"; readonly ref: MentionRef; readonly label: string }
  /** A link that no longer names anything on the canvas (its node is gone): the label, struck. */
  | { readonly kind: "gone"; readonly label: string };

export const textPieces = (
  text: string,
  nodeKindOf: (nodeId: NodeId) => NodeKind | undefined,
): ReadonlyArray<TextPiece> => {
  const pieces: TextPiece[] = [];
  let at = 0;
  for (const link of mentionLinksOf(text)) {
    if (link.start > at) pieces.push({ kind: "text", text: text.slice(at, link.start) });
    const ref = mentionRefOf(link.target, nodeKindOf);
    pieces.push(ref === undefined ? { kind: "gone", label: link.label } : { kind: "mention", ref, label: link.label });
    at = link.end;
  }
  if (at < text.length) pieces.push({ kind: "text", text: text.slice(at) });
  return pieces;
};
