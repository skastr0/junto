/**
 * The draft model under `ui/MentionCombobox`: a text being written, cut into
 * plain text and mentions.
 *
 * Two texts describe one draft. The shown text is what the field holds, each
 * mention as its label (`@product-feed`). The written text is what leaves the
 * composer, each mention as its link (`[@product-feed](junto://canvas?...)`,
 * `src/shared/mention.ts`). The field edits the shown text; `editDraft` maps
 * each edit back onto the pieces, so a mention is a unit: deleting into it
 * removes all of it, typing inside it turns it back into plain text.
 *
 * Everything here is pure, so the rules are testable without a rendered tree.
 */
import type { NodeKind } from "@shared/model/kinds";
import type { NodeId } from "@shared/physics/schema";
import { matchMention, mentionKey, mentionLink, mentionedOnce, mentionsOf, type MentionRef } from "@shared/mention";

export type MentionTrigger = "@" | "#";

/** The character a mention of this kind is typed with: @ names a seat or a page, # a task or an artifact. */
export const triggerOf = (ref: MentionRef): MentionTrigger =>
  matchMention<MentionTrigger>(ref, { seat: () => "@", page: () => "@", task: () => "#", artifact: () => "#" });

export type DraftPiece =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "mention"; readonly ref: MentionRef; readonly label: string };

export type MentionDraft = ReadonlyArray<DraftPiece>;

/** Something a composer offers to mention: what it names and what its chip says. */
export type MentionCandidate = {
  readonly ref: MentionRef;
  /** The chip's text, trigger included: `@product-feed`, `#42 fix tabs`. */
  readonly label: string;
  /** A second line of words, such as the region path when two names match. */
  readonly detail?: string;
  /** The candidate's state in words, such as "not running, mail wakes it". */
  readonly note?: string;
};

export const candidateKey = (candidate: Pick<MentionCandidate, "ref">): string => mentionKey(candidate.ref);

export const EMPTY_DRAFT: MentionDraft = [];

const pieceShown = (piece: DraftPiece): string => (piece.kind === "text" ? piece.text : piece.label);

/** What the field shows: each mention as its label. */
export const shownText = (draft: MentionDraft): string => draft.map(pieceShown).join("");

/** What leaves the composer: each mention as its link on this canvas. */
export const writtenText = (draft: MentionDraft, canvasName: string): string =>
  draft.map((piece) => (piece.kind === "text" ? piece.text : mentionLink(piece.ref, piece.label, canvasName))).join("");

/** A written text read back as a draft. A link the canvas cannot place stays text. */
export const draftOf = (text: string, nodeKindOf: (nodeId: NodeId) => NodeKind | undefined): MentionDraft => {
  const pieces: DraftPiece[] = [];
  let at = 0;
  for (const mention of mentionsOf(text, nodeKindOf)) {
    if (mention.start > at) pieces.push({ kind: "text", text: text.slice(at, mention.start) });
    pieces.push({ kind: "mention", ref: mention.ref, label: mention.label });
    at = mention.end;
  }
  if (at < text.length) pieces.push({ kind: "text", text: text.slice(at) });
  return pieces;
};

/** Each thing the draft mentions, once, in the order first named. */
export const draftMentions = (draft: MentionDraft): ReadonlyArray<MentionRef> =>
  mentionedOnce(draft.flatMap((piece) => (piece.kind === "mention" ? [{ ref: piece.ref }] : [])));

/** A mention in the shown text, by code-unit offsets. */
export type MentionSpan = {
  readonly ref: MentionRef;
  readonly label: string;
  readonly start: number;
  readonly end: number;
};

/** Where each mention sits in the shown text. */
export const mentionSpans = (draft: MentionDraft): ReadonlyArray<MentionSpan> => {
  const spans: MentionSpan[] = [];
  let at = 0;
  for (const piece of draft) {
    const shown = pieceShown(piece);
    if (piece.kind === "mention") spans.push({ ref: piece.ref, label: piece.label, start: at, end: at + shown.length });
    at += shown.length;
  }
  return spans;
};

/** A shown text and the mentions placed in it, back into pieces. Spans are sorted and apart. */
const piecesOf = (shown: string, spans: ReadonlyArray<MentionSpan>): MentionDraft => {
  const pieces: DraftPiece[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.start > at) pieces.push({ kind: "text", text: shown.slice(at, span.start) });
    pieces.push({ kind: "mention", ref: span.ref, label: span.label });
    at = span.end;
  }
  if (at < shown.length) pieces.push({ kind: "text", text: shown.slice(at) });
  return pieces;
};

export type DraftEdit = {
  readonly draft: MentionDraft;
  /** What the field must now hold; differs from the field's value when a whole mention went. */
  readonly shown: string;
  /** Where the caret goes after the edit. */
  readonly caret: number;
};

/**
 * The field's value changed from the draft's shown text to `next`. The edit
 * is the one changed run between their common start and common end. A
 * deletion that reaches into a mention removes the whole mention; an
 * insertion inside a mention leaves its letters as plain text.
 */
export const editDraft = (draft: MentionDraft, next: string): DraftEdit => {
  const prev = shownText(draft);
  if (prev === next) return { draft, shown: next, caret: next.length };
  const most = Math.min(prev.length, next.length);
  let head = 0;
  while (head < most && prev[head] === next[head]) head += 1;
  let tail = 0;
  while (tail < most - head && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail += 1;
  const inserted = next.slice(head, next.length - tail);
  let from = head;
  let to = prev.length - tail;
  const spans = mentionSpans(draft);
  const touches = (span: MentionSpan): boolean =>
    from === to ? span.start < from && from < span.end : span.start < to && span.end > from;
  if (inserted === "") {
    // A deletion takes every mention it reaches, whole.
    for (const span of spans) {
      if (!touches(span)) continue;
      from = Math.min(from, span.start);
      to = Math.max(to, span.end);
    }
  }
  const shift = inserted.length - (to - from);
  const kept = spans
    .filter((span) => !touches(span))
    .map((span) => (span.end <= from ? span : { ...span, start: span.start + shift, end: span.end + shift }));
  const shown = `${prev.slice(0, from)}${inserted}${prev.slice(to)}`;
  return { draft: piecesOf(shown, kept), shown, caret: from + inserted.length };
};

/** An @ or # being typed just before the caret: where its trigger sits and what follows it. */
export type MentionQuery = {
  readonly trigger: MentionTrigger;
  readonly start: number;
  readonly query: string;
};

const QUERY = /(^|[\s(])([@#])([^\s@#[\]()]*)$/u;

/** The mention being typed at the caret, if any. Never inside a placed mention. */
export const mentionQueryAt = (draft: MentionDraft, caret: number): MentionQuery | undefined => {
  const shown = shownText(draft);
  const match = QUERY.exec(shown.slice(0, caret));
  if (!match) return undefined;
  const trigger = match[2] as MentionTrigger;
  const query = match[3] ?? "";
  const start = caret - query.length - 1;
  if (mentionSpans(draft).some((span) => span.start < caret && start < span.end)) return undefined;
  return { trigger, start, query };
};

/**
 * The candidates for a query: those of its trigger whose label (after the
 * trigger) starts with what was typed, then those that contain it.
 */
export const filterCandidates = (
  candidates: ReadonlyArray<MentionCandidate>,
  query: Pick<MentionQuery, "trigger" | "query">,
): ReadonlyArray<MentionCandidate> => {
  const typed = query.query.toLowerCase();
  const own = candidates.filter((candidate) => triggerOf(candidate.ref) === query.trigger);
  const name = (candidate: MentionCandidate): string =>
    (candidate.label.startsWith(query.trigger) ? candidate.label.slice(1) : candidate.label).toLowerCase();
  const starts = own.filter((candidate) => name(candidate).startsWith(typed));
  const contains = own.filter((candidate) => !starts.includes(candidate) && name(candidate).includes(typed));
  return [...starts, ...contains];
};

/** Put the chosen candidate in place of the query, followed by one space, and the caret after it. */
export const pickCandidate = (
  draft: MentionDraft,
  query: MentionQuery,
  caret: number,
  candidate: MentionCandidate,
): DraftEdit => {
  const prev = shownText(draft);
  const spaced = prev[caret] === " " ? "" : " ";
  const inserted = `${candidate.label}${spaced}`;
  const shift = inserted.length - (caret - query.start);
  const spans = mentionSpans(draft).map((span) =>
    span.end <= query.start ? span : { ...span, start: span.start + shift, end: span.end + shift },
  );
  const placed: MentionSpan = {
    ref: candidate.ref,
    label: candidate.label,
    start: query.start,
    end: query.start + candidate.label.length,
  };
  const shown = `${prev.slice(0, query.start)}${inserted}${prev.slice(caret)}`;
  const ordered = [...spans, placed].sort((a, b) => a.start - b.start);
  return { draft: piecesOf(shown, ordered), shown, caret: query.start + candidate.label.length + 1 };
};

export type MentionKey = {
  readonly key: string;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  /** IME composition in progress: every key belongs to the composer. */
  readonly isComposing?: boolean;
};

export type MentionKeyIntent =
  /** Not the list's: the composer's own keys (send, new line) have it. */
  | { readonly type: "none" }
  /** Move the highlight; the text is untouched. */
  | { readonly type: "highlight"; readonly index: number }
  /** Put the highlighted candidate in the text. */
  | { readonly type: "pick"; readonly index: number }
  /** Close the list for this query; the surface around stays. */
  | { readonly type: "dismiss" };

const NO_INTENT: MentionKeyIntent = { type: "none" };

/**
 * What a key means while the list is open. Up and Down move (wrapping),
 * Enter and Tab put the highlighted candidate in, Escape closes the list
 * only. Home, End and every chord stay the field's. With nothing to pick
 * (no matches) Enter is the composer's again.
 */
export const mentionKeyIntent = (
  event: MentionKey,
  state: { readonly open: boolean; readonly optionCount: number; readonly activeIndex: number },
): MentionKeyIntent => {
  if (event.isComposing || !state.open) return NO_INTENT;
  const chord = Boolean(event.altKey || event.ctrlKey || event.metaKey);
  const { optionCount, activeIndex } = state;
  switch (event.key) {
    case "ArrowDown":
    case "ArrowUp": {
      if (chord || event.shiftKey || optionCount === 0) return NO_INTENT;
      const step = event.key === "ArrowDown" ? 1 : -1;
      const from = activeIndex < 0 || activeIndex >= optionCount ? (step > 0 ? -1 : 0) : activeIndex;
      return { type: "highlight", index: (from + step + optionCount) % optionCount };
    }
    case "Enter":
    case "Tab":
      if (chord || event.shiftKey || optionCount === 0) return NO_INTENT;
      return { type: "pick", index: activeIndex >= 0 && activeIndex < optionCount ? activeIndex : 0 };
    case "Escape":
      return { type: "dismiss" };
    default:
      return NO_INTENT;
  }
};
