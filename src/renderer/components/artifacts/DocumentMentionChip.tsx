import type { MouseEvent } from "react";
import { parseMentionHref } from "@shared/mention";
import type { NodeKind } from "@shared/model/kinds";
import type { NodeId } from "@shared/physics/schema";
import { mentionChipOf, openMention } from "../../lib/mention-open";
import { ResourceChip, mentionMark } from "../ui/ResourceChip";

/** A press on the chip must leave the caret, the selection and the keyboard where they are. */
const keepEditorFocus = (event: MouseEvent): void => event.preventDefault();

/**
 * A mention link in a live document, drawn as the chip every other surface
 * draws (03 section 3): `[@product-feed](junto://...)` off the caret is the
 * seat's chip, and a click opens what it names. The canvas says what the
 * node is now, so a seat, task or artifact that is gone is drawn unavailable
 * and does not open. A link that is not a mention stays its words.
 *
 * It sits inside the editor's text, so it claims nothing: no focus stop
 * (Tab moves through the document, not its chips) and a press neither moves
 * the caret nor takes the keyboard.
 */
export function DocumentMentionChip({
  href,
  label,
  nodeKindOf,
}: {
  readonly href: string;
  /** The link's text as written, `@name` or `#42 title`. */
  readonly label: string;
  readonly nodeKindOf: (nodeId: NodeId) => NodeKind | undefined;
}) {
  const target = parseMentionHref(href);
  if (target === undefined) return <span>{label}</span>;
  const { ref, kind, label: shown, number } = mentionChipOf({ target, label }, nodeKindOf);
  // A gone seat or page: its link cannot say which, so it is its words, struck.
  if (kind === undefined) {
    return (
      <del data-testid="document-mention-chip" data-missing="true">
        {shown}
      </del>
    );
  }
  const mark = ref === undefined ? { kind } : mentionMark(ref);
  return (
    <ResourceChip
      {...mark}
      label={shown}
      number={number}
      missing={ref === undefined}
      {...(ref === undefined ? {} : { onOpen: () => openMention(ref), tabIndex: -1, onMouseDown: keepEditorFocus })}
      data-testid="document-mention-chip"
    />
  );
}
