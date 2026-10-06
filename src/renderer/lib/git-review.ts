import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import { EMPTY_REVIEW, reviewIsEmpty, type PendingReview, type ReviewComment } from "@shared/git-review";

/**
 * The operator's pending reviews, one per repository, and what was last sent.
 *
 * A pending review survives closing and reopening the git detail: it is kept
 * in this window's memory, keyed by the repository's top level, until it is
 * sent or discarded. It does not survive a reload or a restart yet; the
 * browser's own storage is not a store for the app (settings state
 * architecture), so keeping it longer means the state engine. It is the
 * operator's draft, not work: nothing in main knows about it until it is
 * sent as mail.
 */

export type SentReview = {
  /** Epoch ms it was sent. */
  readonly at: number;
  /** Who received a mail, by name, and how many comments each mail carried. */
  readonly mails: ReadonlyArray<{ readonly name: string; readonly comments: number }>;
};

const pending$ = observable<Record<string, PendingReview>>({});
const sent$ = observable<Record<string, SentReview>>({});

const write = (root: string, next: PendingReview): void => {
  if (reviewIsEmpty(next)) pending$[root].delete();
  else pending$[root].set(next);
};

export const pendingReview = (root: string): PendingReview => pending$[root].peek() ?? EMPTY_REVIEW;

export const usePendingReview = (root: string): PendingReview => use$(() => pending$[root].get()) ?? EMPTY_REVIEW;

/** What was last sent for this repository in this window, if anything. */
export const useSentReview = (root: string): SentReview | undefined => use$(() => sent$[root].get());

/** Add a comment, or replace the one with the same id. */
export const saveReviewComment = (root: string, comment: ReviewComment): void => {
  const review = pendingReview(root);
  const exists = review.comments.some((entry) => entry.id === comment.id);
  write(root, {
    ...review,
    comments: exists ? review.comments.map((entry) => (entry.id === comment.id ? comment : entry)) : [...review.comments, comment],
  });
};

export const removeReviewComment = (root: string, id: string): void => {
  const review = pendingReview(root);
  write(root, { ...review, comments: review.comments.filter((entry) => entry.id !== id) });
};

export const setReviewNote = (root: string, note: string): void => write(root, { ...pendingReview(root), note });

/** Drop the pending review: it was sent, or the operator discarded it. */
export const clearPendingReview = (root: string): void => {
  pending$[root].delete();
};

/** Keep the comments that could not be sent (no recipient); everything else went. */
export const keepUnsentComments = (root: string, comments: ReadonlyArray<ReviewComment>): void =>
  write(root, { comments, note: "" });

export const recordSentReview = (root: string, sent: SentReview): void => sent$[root].set(sent);

/** How many comment composers are open in a repository's review right now. */
const composing$ = observable<Record<string, number>>({});

/** A composer opened (+1) or closed (-1): the surface shows one primary action at a time. */
export const noteReviewComposer = (root: string, delta: 1 | -1): void =>
  composing$[root].set(Math.max(0, (composing$[root].peek() ?? 0) + delta));

export const useReviewComposing = (root: string): boolean => use$(() => (composing$[root].get() ?? 0) > 0);
