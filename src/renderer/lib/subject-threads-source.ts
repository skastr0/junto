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
import { mintItemId, mintOpId, type ResourceActor } from "@shared/resource-command";
import type { ItemId } from "@shared/work-ids";

/** The resource a thread hangs on. Extended as panes move on (artifact, page). */
export type ThreadSubjectRef =
  | { readonly kind: "task"; readonly nodeId: NodeId; readonly taskId: ItemId }
  | { readonly kind: "artifact"; readonly nodeId: NodeId; readonly artifactId: ItemId };

export const subjectKey = (subject: ThreadSubjectRef): string =>
  subject.kind === "task" ? `task:${subject.nodeId}:${subject.taskId}` : `artifact:${subject.nodeId}:${subject.artifactId}`;

export type ThreadPost = {
  readonly messageId: string;
  readonly author: ResourceActor;
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
  actor: ResourceActor = { kind: "operator" },
  now: () => number = Date.now,
): SubjectThreadsSource => {
  const held = new Map<string, SubjectThread[]>();
  const listeners = new Set<() => void>();
  const answers = new Map<string, ThreadPostOutcome>();
  const keyOf = (canvasName: string, subject: ThreadSubjectRef): string => `${canvasName}\u0000${subjectKey(subject)}`;
  return {
    threads: async (canvasName, subject) => held.get(keyOf(canvasName, subject)) ?? [],
    post: async (canvasName, subject, post) => {
      if (post.text.trim() === "") return { ok: false, message: "Write something to post." };
      const key = keyOf(canvasName, subject);
      const threads = held.get(key) ?? [];
      const entry: ThreadPost = { messageId: mintItemId(), author: actor, text: post.text, at: now() };
      const target = post.threadId === undefined ? threads[0] : threads.find((thread) => thread.threadId === post.threadId);
      if (post.threadId !== undefined && target === undefined) {
        return { ok: false, message: "That thread is not on this task." };
      }
      const replayed = answers.get(post.opId);
      if (replayed !== undefined) return replayed;
      const threadId = target?.threadId ?? mintItemId();
      held.set(
        key,
        target === undefined
          ? [...threads, { threadId, ...(post.anchor === undefined ? {} : { anchor: post.anchor }), posts: [entry] }]
          : threads.map((thread) => (thread === target ? { ...thread, posts: [...thread.posts, entry] } : thread)),
      );
      const outcome: ThreadPostOutcome = { ok: true, threadId, messageId: entry.messageId };
      answers.set(post.opId, outcome);
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

export const subjectThreadsSource = (): SubjectThreadsSource => source;

/** Tests and the main-side switch set the source. */
export const setSubjectThreadsSource = (next: SubjectThreadsSource): void => {
  source = next;
};

/** A fresh id for one post: a resend of the same post reuses it. */
export const newPostOpId = (): string => mintOpId();

const NONE: ReadonlyArray<never> = [];

/** The subject's threads, kept fresh. */
export const useSubjectThreads = (canvasName: string, subject: ThreadSubjectRef): ReadonlyArray<SubjectThread> => {
  const key = `${canvasName}\u0000${subjectKey(subject)}`;
  const [held, setHeld] = useState<{ readonly key: string; readonly value: ReadonlyArray<SubjectThread> }>({ key, value: NONE });
  const subjectRef = useRef(subject);
  subjectRef.current = subject;
  useEffect(() => {
    let live = true;
    const read = (): void => {
      void subjectThreadsSource()
        .threads(canvasName, subjectRef.current)
        .then((value) => {
          if (live) setHeld({ key, value });
        });
    };
    read();
    const off = subjectThreadsSource().subscribe(read);
    return () => {
      live = false;
      off();
    };
  }, [canvasName, key]);
  return held.key === key ? held.value : NONE;
};
