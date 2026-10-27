import { newPostOpId } from "./subject-threads-source";

/**
 * One op id per post, as `TaskThread` keeps it: a resend of the same post
 * (same text, place and thread) after a lost answer reuses the id, so main
 * meets it as written and it posts once. A post that lands, or a different
 * one, starts afresh.
 */
export type PostOps = {
  /** The op id for this post: the pending one when it is the same post, else a fresh one. */
  readonly opFor: (post: PostKey) => string;
  /** An answer came back, posted or refused: the next post gets a fresh id. Leave it unsettled only when the answer was lost. */
  readonly settle: () => void;
};

export type PostKey = { readonly text: string; readonly anchor?: unknown; readonly threadId?: string };

const keyOf = (post: PostKey): string => JSON.stringify([post.text, post.anchor ?? null, post.threadId ?? null]);

export const makePostOps = (mint: () => string = newPostOpId): PostOps => {
  let pending: { readonly key: string; readonly opId: string } | null = null;
  return {
    opFor: (post) => {
      const key = keyOf(post);
      if (pending?.key !== key) pending = { key, opId: mint() };
      return pending.opId;
    },
    settle: () => {
      pending = null;
    },
  };
};
