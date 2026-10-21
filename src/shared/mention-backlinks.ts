import type { NodeKind } from "./model/kinds";
import { NOTICE_SEAT_ID } from "./mail-author";
import { mentionKey, mentionedOnce, mentionsOf, type MentionRef } from "./mention";
import type { NodeId } from "./physics/schema";
import { SUBJECT_NOTICE_KEY } from "./subject-notice";

/**
 * Backlinks (docs/plans/0.10/03 section 3): where a seat, a task, an artifact
 * or a page is mentioned. Main keeps them as a projection of mail rows,
 * written with each row and rebuildable from the rows; this file says which
 * rows count and what each one mentions. Pure, no Node imports.
 */

/**
 * The metadata key a copy of another row carries, naming the row it copies.
 * A copy repeats words written elsewhere, so it is no place they were written.
 */
export const MENTION_COPY_OF_KEY = "copyOf";

/** What a backlink is read from: one mail row as stored. */
export type BacklinkSource = {
  readonly actorSeatId: string;
  readonly parts: ReadonlyArray<{ readonly kind: string; readonly text?: string }>;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
};

/**
 * Whether a row is where its words were written. A subject notice, a
 * resource's refusal notice and a copy each repeat or report words that
 * stand in another row, so they mention nothing.
 */
export const writtenHere = (row: BacklinkSource): boolean =>
  row.actorSeatId !== NOTICE_SEAT_ID &&
  row.metadata?.[SUBJECT_NOTICE_KEY] === undefined &&
  row.metadata?.[MENTION_COPY_OF_KEY] === undefined;

/** A row's words: its text parts, in order. */
export const backlinkTextOf = (row: BacklinkSource): string =>
  row.parts.flatMap((part) => (part.kind === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n");

/** Each thing a row mentions, once, in the order first named; none for a row its words were not written in. */
export const backlinksOf = (
  row: BacklinkSource,
  nodeKindOf: (nodeId: NodeId) => NodeKind | undefined,
): ReadonlyArray<MentionRef> => (writtenHere(row) ? mentionedOnce(mentionsOf(backlinkTextOf(row), nodeKindOf)) : []);

/** The keys a row is found under (`mentionKey`), one per thing it mentions. */
export const backlinkKeysOf = (
  row: BacklinkSource,
  nodeKindOf: (nodeId: NodeId) => NodeKind | undefined,
): ReadonlyArray<string> => backlinksOf(row, nodeKindOf).map(mentionKey);
