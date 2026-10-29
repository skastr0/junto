/**
 * A subject's comments for the phone: the desktop's own derivation
 * (`listThreads` in work/resource-ipc.ts) cut to the wire's bounds and fitted
 * to one frame. The desktop's `SubjectThreadView` is the source; nothing here
 * decides who may read or write, only what one answer carries.
 *
 * Threads come newest first, a page at a time; a thread's posts are its
 * newest, oldest first, as the desktop reads them. Text is the operator's
 * content and passes through; what cannot fit a bound (an id too long for the
 * wire) is left out rather than failing the whole answer, and what cannot fit
 * the frame is cut with `cut` saying so.
 */
import type { ThreadPostAuthor } from "./resource-ipc";
import type { ContentRef } from "./wire/content-ref";
import type { PlaceAnchor } from "./wire/thread-subject";
import {
  COMPANION_COMMENTS_POSTS_MAX,
  COMPANION_COMMENTS_THREADS_MAX,
  type CompanionCommentAuthor,
  type CompanionCommentPost,
  type CompanionCommentThread,
  type CompanionCommentsListData,
} from "./wire/companion-artifacts";
import { COMPANION_MAX_OUTBOUND_BYTES } from "./wire/companion-protocol";

/** Room the answer may take in a frame: the rest is the envelope. */
export const COMPANION_COMMENTS_BUDGET_BYTES = COMPANION_MAX_OUTBOUND_BYTES - 32 * 1024;

/** One post as a thread read holds it: the desktop's own fields, cut to what the phone reads. */
export type CommentPostView = {
  readonly postId: string;
  readonly author: ThreadPostAuthor;
  readonly text: string;
  readonly at: number;
  readonly attachments?: ReadonlyArray<ContentRef>;
};

/** One thread as a thread read holds it: the desktop's `SubjectThreadView`, without its brands. */
export type CommentThreadView = {
  readonly threadId: string;
  readonly anchor?: PlaceAnchor;
  readonly posts: ReadonlyArray<CommentPostView>;
};

const ID_MAX = 128;
const NAME_MAX = 256;
const CURSOR_MAX = 256;

const encoder = new TextEncoder();
const bytesOf = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

const idOk = (id: string | undefined): id is string => id !== undefined && id.length > 0 && id.length <= ID_MAX;

/** At most `max` UTF-16 units, never splitting a surrogate pair. */
const clip = (text: string, max: number): string => {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
};

const authorOf = (author: ThreadPostAuthor): CompanionCommentAuthor | undefined => {
  const name = clip(author.name, NAME_MAX);
  switch (author.kind) {
    case "operator":
      return { kind: "operator", name };
    case "seat":
      return { kind: "seat", seatId: author.seatId, nodeId: author.nodeId, name };
    case "automation":
      return { kind: "automation", nodeId: author.nodeId, name };
  }
};

const postOf = (post: CommentPostView): CompanionCommentPost | undefined => {
  const postId = idOk(post.postId) ? post.postId : undefined;
  const author = authorOf(post.author);
  if (postId === undefined || author === undefined) return undefined;
  return {
    postId,
    author,
    text: post.text,
    at: post.at,
    ...(post.attachments === undefined || post.attachments.length === 0 ? {} : { attachments: post.attachments }),
  };
};

/** A thread whose ids read on the wire; undefined when they do not. */
type HeldThread = {
  readonly threadId: string;
  readonly posts: ReadonlyArray<CompanionCommentPost>;
  readonly anchor?: CompanionCommentThread["anchor"];
};

const threadOf = (view: CommentThreadView): HeldThread | undefined => {
  const threadId = idOk(view.threadId) ? view.threadId : undefined;
  if (threadId === undefined) return undefined;
  const posts = view.posts.flatMap((post) => {
    const one = postOf(post);
    return one === undefined ? [] : [one];
  });
  if (posts.length === 0) return undefined;
  return { threadId, posts, ...(view.anchor === undefined ? {} : { anchor: view.anchor }) };
};

/**
 * One page of a subject's threads, newest first, as many as fit.
 *
 * `page.before` is the `next` of the page before. A cursor the list no longer
 * holds (a thread cannot be deleted today, so this is a canvas that moved
 * under the phone) starts again from the newest, never from a guess.
 */
export const companionCommentsPage = (
  threads: ReadonlyArray<CommentThreadView>,
  page: { readonly limit?: number; readonly before?: string } = {},
): CompanionCommentsListData => {
  const limit = Math.min(page.limit ?? COMPANION_COMMENTS_THREADS_MAX, COMPANION_COMMENTS_THREADS_MAX);
  // The desktop orders by first post, oldest first; the phone reads the newest thread first.
  const ordered = threads
    .flatMap((view) => {
      const thread = threadOf(view);
      return thread === undefined ? [] : [thread];
    })
    .reverse();
  const from = page.before === undefined
    ? 0
    : (() => {
        const at = ordered.findIndex((thread) => thread.threadId === page.before);
        return at < 0 ? 0 : at + 1;
      })();

  const sent: CompanionCommentThread[] = [];
  let cut = false;
  for (const thread of ordered.slice(from)) {
    if (sent.length >= limit) {
      cut = true;
      break;
    }
    const newest = thread.posts.slice(-COMPANION_COMMENTS_POSTS_MAX);
    const postsCut = newest.length < thread.posts.length;
    const candidate = {
      threadId: thread.threadId,
      ...(thread.anchor === undefined ? {} : { anchor: thread.anchor }),
      posts: newest,
      ...(postsCut ? { cut: true as const } : {}),
    };
    const next = [...sent, candidate];
    if (bytesOf({ threads: next, cut: true }) <= COMPANION_COMMENTS_BUDGET_BYTES) {
      sent.push(candidate);
      continue;
    }
    // The first thread must fit: keep its newest posts that do, and say so.
    if (sent.length === 0) {
      const kept = newest.slice();
      while (kept.length > 1 && bytesOf({ threads: [{ ...candidate, posts: kept, cut: true }], cut: true }) > COMPANION_COMMENTS_BUDGET_BYTES) kept.shift();
      if (bytesOf({ threads: [{ ...candidate, posts: kept, cut: true }], cut: true }) <= COMPANION_COMMENTS_BUDGET_BYTES) {
        sent.push({ ...candidate, posts: kept, cut: true });
      }
    }
    cut = true;
    break;
  }

  const last = sent.at(-1);
  const next = cut && last !== undefined ? clip(last.threadId, CURSOR_MAX) : undefined;
  return { threads: sent, cut, ...(next === undefined ? {} : { next }) };
};
