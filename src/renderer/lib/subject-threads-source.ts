/**
 * Where a resource's comment threads are read and posted (plan 0.10/03): the
 * thread of a task, an artifact or a page, as one source for every pane that
 * shows one. A comment is posted through the one write path the CLI uses
 * (`postSubjectComment`), so mentions in the text are read as links and
 * refused in words when out of reach.
 *
 * Stand-in: until main serves subject threads to the window (cli-overseer's
 * `thread` resource IPC), `makeLocalSubjectThreads` keeps them in this
 * window's memory, for the gallery and the tests.
 */
import { useEffect, useRef, useState } from "react";
import type { NodeId } from "@shared/physics/schema";
import type { Anchor } from "@shared/thread-subject";
import { mintItemId, mintOpId } from "@shared/resource-command";
import type { ItemId } from "@shared/work-ids";

/** The resource a thread hangs on. Extended as panes move on (artifact, page). */
export type ThreadSubjectRef =
  | { readonly kind: "task"; readonly nodeId: NodeId; readonly taskId: ItemId }
  | { readonly kind: "artifact"; readonly nodeId: NodeId; readonly artifactId: ItemId };

export const subjectKey = (subject: ThreadSubjectRef): string =>
  subject.kind === "task" ? `task:${subject.nodeId}:${subject.taskId}` : `artifact:${subject.nodeId}:${subject.artifactId}`;

/** Who wrote a post: the operator, or a seat or an automation by its node. */
export type ThreadAuthor =
  | { readonly kind: "operator" }
  | { readonly kind: "seat"; readonly nodeId: NodeId }
  | { readonly kind: "automation"; readonly nodeId: NodeId };

export type ThreadPost = {
  readonly messageId: string;
  readonly author: ThreadAuthor;
  /** The name main shows for the author, when it has one. */
  readonly name?: string;
  /** The written text: mentions as links. */
  readonly text: string;
  /** Epoch ms. */
  readonly at: number;
};

export type SubjectThread = {
  readonly threadId: string;
  /** Where in the resource the thread is rooted; absent is the whole resource. */
  readonly anchor?: Anchor;
  readonly posts: ReadonlyArray<ThreadPost>;
};

/** A post's answer: done, with where it landed, or the words it was refused in (the text stays with the writer). */
export type ThreadPostOutcome =
  | { readonly ok: true; readonly threadId: string; readonly messageId: string }
  | { readonly ok: false; readonly message: string };

export interface SubjectThreadsSource {
  readonly threads: (canvasName: string, subject: ThreadSubjectRef) => Promise<ReadonlyArray<SubjectThread>>;
  /**
   * Post into the subject's thread; `threadId` absent starts or joins the
   * subject's own thread. `opId` is the caller's: a replay answers the first result.
   */
  readonly post: (
    canvasName: string,
    subject: ThreadSubjectRef,
    post: { readonly text: string; readonly threadId?: string; readonly anchor?: Anchor; readonly opId: string },
  ) => Promise<ThreadPostOutcome>;
  /** Called after any change; returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
}

/** An in-memory source, as the stand-in and for tests. Every post is `actor`'s. */
export const makeLocalSubjectThreads = (
  actor: ThreadAuthor = { kind: "operator" },
  now: () => number = Date.now,
): SubjectThreadsSource => {
  const held = new Map<string, SubjectThread[]>();
  const listeners = new Set<() => void>();
  const answers = new Map<string, ThreadPostOutcome>();
  const keyOf = (canvasName: string, subject: ThreadSubjectRef): string => `${canvasName}\u0000${subjectKey(subject)}`;
  return {
    threads: async (canvasName, subject) => held.get(keyOf(canvasName, subject)) ?? [],
    post: async (canvasName, subject, post) => {
      const key = keyOf(canvasName, subject);
      // A replay answers the first result, refusal or not, before anything is judged again.
      const replayKey = `${key}\u0000${post.opId}`;
      const replayed = answers.get(replayKey);
      if (replayed !== undefined) return replayed;
      const remember = (outcome: ThreadPostOutcome): ThreadPostOutcome => {
        answers.set(replayKey, outcome);
        return outcome;
      };
      if (post.text.trim() === "") return remember({ ok: false, message: "Write something to post." });
      const threads = held.get(key) ?? [];
      const entry: ThreadPost = { messageId: mintItemId(), author: actor, text: post.text, at: now() };
      // As main puts it (subject-comment.ts): the thread named, else a task's own thread (its id is the
      // task's), else a new thread rooted at the comment.
      const threadId = post.threadId ?? (subject.kind === "task" ? subject.taskId : entry.messageId);
      const target = threads.find((thread) => thread.threadId === threadId);
      held.set(
        key,
        target === undefined
          ? [...threads, { threadId, ...(post.anchor === undefined ? {} : { anchor: post.anchor }), posts: [entry] }]
          : threads.map((thread) => (thread === target ? { ...thread, posts: [...thread.posts, entry] } : thread)),
      );
      const outcome = remember({ ok: true, threadId, messageId: entry.messageId });
      for (const listener of listeners) listener();
      return outcome;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

let source: SubjectThreadsSource = makeLocalSubjectThreads();
let live = false;

export const subjectThreadsSource = (): SubjectThreadsSource => source;

/**
 * Whether comments reach main (a source was set: main's, or a test's). The
 * default stand-in keeps posts in this window only, so a pane that would
 * lose them must not offer to post until this is true.
 */
export const subjectThreadsLive = (): boolean => live;

/**
 * The shape of main's thread channel (`window.junto.resource.thread`: list,
 * post, onChanged), as this source reads it. Structural, so the window does
 * not depend on main's types: the bridge is read at the edge (`threadApiOf`).
 */
export type ThreadApiLike = {
  readonly list: (
    canvasName: string,
    subject: ThreadSubjectRef,
  ) => Promise<
    ReadonlyArray<{
      readonly threadId: string;
      readonly anchor?: Anchor;
      readonly posts: ReadonlyArray<{
        readonly postId: string;
        readonly author: { readonly kind: "operator" | "seat" | "automation"; readonly nodeId?: string; readonly name: string };
        readonly text: string;
        readonly at: number;
      }>;
    }>
  >;
  readonly post: (
    canvasName: string,
    subject: ThreadSubjectRef,
    post: { readonly opId: string; readonly text: string; readonly threadId?: string; readonly anchor?: Anchor },
  ) => Promise<
    | { readonly kind: "applied"; readonly threadId: string; readonly postId: string }
    | { readonly kind: "refused"; readonly error: { readonly message: string } }
  >;
  readonly onChanged: (listener: (changed: unknown) => void) => () => void;
};

const authorOf = (author: { readonly kind: "operator" | "seat" | "automation"; readonly nodeId?: string }): ThreadAuthor => {
  if (author.kind === "operator" || author.nodeId === undefined) return { kind: "operator" };
  return { kind: author.kind, nodeId: author.nodeId as NodeId };
};

/** Main's threads over the resource IPC: the same list and post as `junto task comment`. */
export const makeIpcSubjectThreads = (api: ThreadApiLike): SubjectThreadsSource => ({
  threads: async (canvasName, subject) =>
    (await api.list(canvasName, subject)).map((thread) => ({
      threadId: thread.threadId,
      ...(thread.anchor === undefined ? {} : { anchor: thread.anchor }),
      posts: thread.posts.map((post) => ({
        messageId: post.postId,
        author: authorOf(post.author),
        name: post.author.name,
        text: post.text,
        at: post.at,
      })),
    })),
  post: async (canvasName, subject, post) => {
    const outcome = await api.post(canvasName, subject, {
      opId: post.opId,
      text: post.text,
      ...(post.threadId === undefined ? {} : { threadId: post.threadId }),
      ...(post.anchor === undefined ? {} : { anchor: post.anchor }),
    });
    return outcome.kind === "applied"
      ? { ok: true, threadId: outcome.threadId, messageId: outcome.postId }
      : { ok: false, message: outcome.error.message };
  },
  subscribe: (listener) => api.onChanged(() => listener()),
});

/** The thread channel off the bridge, if main serves it: absent in a build that leaves threads out. */
export const threadApiOf = (resource: unknown): ThreadApiLike | undefined =>
  (resource as { readonly thread?: ThreadApiLike } | undefined)?.thread;

let installed = false;

/** Point comments at main. Idempotent; without the bridge (a build that leaves threads out) nothing is set and comments stay unoffered. */
export const installIpcSubjectThreads = (api: ThreadApiLike | undefined): boolean => {
  if (api === undefined) return false;
  if (!installed) {
    setSubjectThreadsSource(makeIpcSubjectThreads(api));
    installed = true;
  }
  return true;
};

/** Tests and the main-side switch set the source. */
export const setSubjectThreadsSource = (next: SubjectThreadsSource): void => {
  source = next;
  live = true;
  for (const listener of swapListeners) listener();
};

const swapListeners = new Set<() => void>();

/** A fresh id for one post: a resend of the same post reuses it. */
export const newPostOpId = (): string => mintOpId();

const NONE: ReadonlyArray<never> = [];

/** The subject's threads, kept fresh: a newer read is never overwritten by an older one that lands late, and a swapped source is read again. */
export const useSubjectThreads = (canvasName: string, subject: ThreadSubjectRef): ReadonlyArray<SubjectThread> => {
  const key = `${canvasName}\u0000${subjectKey(subject)}`;
  const [held, setHeld] = useState<{ readonly key: string; readonly value: ReadonlyArray<SubjectThread> }>({ key, value: NONE });
  const subjectRef = useRef(subject);
  subjectRef.current = subject;
  useEffect(() => {
    let live = true;
    let latest = 0;
    let off: () => void = () => undefined;
    const read = (): void => {
      const mine = ++latest;
      void subjectThreadsSource()
        .threads(canvasName, subjectRef.current)
        .then((value) => {
          if (live && mine === latest) setHeld({ key, value });
        });
    };
    const attach = (): void => {
      off();
      off = subjectThreadsSource().subscribe(read);
      read();
    };
    attach();
    swapListeners.add(attach);
    return () => {
      live = false;
      off();
      swapListeners.delete(attach);
    };
  }, [canvasName, key]);
  return held.key === key ? held.value : NONE;
};
