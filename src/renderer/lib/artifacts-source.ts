/**
 * Where the Artifacts node reads and writes its artifacts, their versions and
 * their comment threads (plan 0.10/05). One interface, so the pane never
 * knows which side answers it.
 *
 * A write is one `ArtifactOp` on a resource command (02), addressed by
 * `target.itemId` and ruled by `artifactDomain` (src/shared/artifact-domain.ts),
 * so a refusal here reads exactly as the editing machine's: `stale` and
 * `rebase_conflict` carry the head in `details.expected`.
 *
 * Stand-in: until cli-identity serves artifacts from main and product-feed's
 * subject threads carry artifact comments (03), `makeLocalArtifactsSource`
 * holds them in this window's memory, ruled by the same domain.
 */
import { useEffect, useRef, useState } from "react";
import type { Anchor } from "@shared/thread-subject";
import { type ArtifactOp, type ArtifactVersion, type ArtifactVersionRecord } from "@shared/artifact";
import {
  artifactDomain,
  type ArtifactEntry,
  type ArtifactFact,
  artifactsOnNode,
  type ArtifactState,
  emptyArtifactState,
} from "@shared/artifact-domain";
import type { NodeId } from "@shared/physics/schema";
import {
  emptyRuled,
  type ItemId,
  mintItemId,
  mintOpId,
  type ResourceActor,
  type ResourceRuling,
  rule,
  type Ruled,
} from "@shared/resource-command";
import type { InstallationId } from "@shared/installation-id";

/** One post in an artifact comment thread. */
export interface ArtifactPost {
  readonly postId: string;
  readonly author: ResourceActor;
  readonly text: string;
  readonly at: number;
}

/** A comment thread on an artifact: its anchor (absent is the whole artifact) and its posts. */
export interface ArtifactThread {
  readonly threadId: string;
  readonly artifactId: ItemId;
  readonly anchor?: Anchor;
  /** The version the thread was started on; an anchor points into that version. */
  readonly version: ArtifactVersion;
  readonly posts: ReadonlyArray<ArtifactPost>;
  readonly resolved: boolean;
}

export type ArtifactRuling = ResourceRuling<ArtifactFact>;

export interface ArtifactsSource {
  readonly list: (canvasName: string, nodeId: NodeId) => Promise<ReadonlyArray<ArtifactEntry>>;
  /** Every version, newest first. */
  readonly history: (canvasName: string, artifactId: ItemId) => Promise<ReadonlyArray<ArtifactVersionRecord>>;
  /** Rule one op. `itemId` is the artifact; on `create` the caller mints it. */
  readonly apply: (canvasName: string, nodeId: NodeId, itemId: ItemId, op: ArtifactOp) => Promise<ArtifactRuling>;
  readonly threads: (canvasName: string, artifactId: ItemId) => Promise<ReadonlyArray<ArtifactThread>>;
  /** Start a thread (no `threadId`) or reply in one. */
  readonly comment: (
    canvasName: string,
    artifactId: ItemId,
    post: { readonly text: string; readonly threadId?: string; readonly anchor?: Anchor; readonly version: ArtifactVersion },
  ) => Promise<ArtifactThread>;
  readonly resolve: (canvasName: string, threadId: string, resolved: boolean) => Promise<void>;
  /** Called after any change; returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
}

const LOCAL_WRITER = "local" as InstallationId;

/** An in-memory source, as the stand-in and for tests. Every write is `actor`'s. */
export const makeLocalArtifactsSource = (
  actor: ResourceActor = { kind: "operator" },
  now: () => number = Date.now,
): ArtifactsSource => {
  const domain = artifactDomain(now);
  const ruled = new Map<string, Ruled<ArtifactState, ArtifactFact>>();
  const versions = new Map<ItemId, ReadonlyArray<ArtifactVersionRecord>>();
  const threads = new Map<string, ArtifactThread>();
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const listener of listeners) listener();
  };
  const ruledOf = (canvasName: string) => ruled.get(canvasName) ?? emptyRuled<ArtifactState, ArtifactFact>(emptyArtifactState());

  const record = (fact: ArtifactFact): void => {
    const push = (artifactId: ItemId, entry: ArtifactVersionRecord): void => {
      versions.set(artifactId, [entry, ...(versions.get(artifactId) ?? [])]);
    };
    if (fact.fact === "artifact.created") {
      push(fact.artifact.artifactId, {
        artifactId: fact.artifact.artifactId,
        version: fact.artifact.version,
        author: fact.artifact.createdBy,
        at: fact.artifact.updatedAt,
        body: fact.body,
      });
    } else if (fact.fact === "artifact.edited") {
      push(fact.artifactId, { artifactId: fact.artifactId, version: fact.version, author: fact.author, at: fact.at, body: fact.body });
    }
  };

  return {
    list: async (canvasName, nodeId) => artifactsOnNode(ruledOf(canvasName).state, nodeId),
    history: async (_canvasName, artifactId) => versions.get(artifactId) ?? [],
    apply: async (canvasName, nodeId, itemId, op) => {
      const result = rule(
        domain,
        ruledOf(canvasName),
        LOCAL_WRITER,
        {
          opId: mintOpId(),
          canvasName,
          actor,
          target: { kind: "artifact", nodeId, itemId },
          basis: null,
          after: [],
          op,
        },
        { inReach: () => true },
      );
      ruled.set(canvasName, result.ruled);
      if (result.ruling.kind === "applied") {
        result.ruling.facts.forEach(record);
        changed();
      }
      return result.ruling;
    },
    threads: async (canvasName, artifactId) =>
      [...threads.entries()]
        .filter(([key, thread]) => key.startsWith(`${canvasName}\u0000`) && thread.artifactId === artifactId)
        .map(([, thread]) => thread),
    comment: async (canvasName, artifactId, post) => {
      const at = now();
      const entry: ArtifactPost = { postId: mintItemId(), author: actor, text: post.text, at };
      const existing = post.threadId === undefined ? undefined : threads.get(`${canvasName}\u0000${post.threadId}`);
      const thread: ArtifactThread =
        existing === undefined
          ? {
              threadId: mintItemId(),
              artifactId,
              ...(post.anchor === undefined || post.anchor.kind === "whole" ? {} : { anchor: post.anchor }),
              version: post.version,
              posts: [entry],
              resolved: false,
            }
          : { ...existing, posts: [...existing.posts, entry] };
      threads.set(`${canvasName}\u0000${thread.threadId}`, thread);
      changed();
      return thread;
    },
    resolve: async (canvasName, threadId, resolved) => {
      const key = `${canvasName}\u0000${threadId}`;
      const thread = threads.get(key);
      if (thread === undefined) return;
      threads.set(key, { ...thread, resolved });
      changed();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

/** This window's source. Swapped for main's when cli-identity's handlers land. */
let source: ArtifactsSource = makeLocalArtifactsSource();

export const artifactsSource = (): ArtifactsSource => source;

/** Tests and the main-side switch set the source. */
export const setArtifactsSource = (next: ArtifactsSource): void => {
  source = next;
};

/** Re-read whenever the source changes or `key` does. */
const useSourced = <T>(read: () => Promise<T>, initial: T, key: string): T => {
  const [value, setValue] = useState<T>(initial);
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    let live = true;
    const refresh = (): void => {
      void readRef.current().then((next) => {
        if (live) setValue(next);
      });
    };
    refresh();
    const unsubscribe = artifactsSource().subscribe(refresh);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [key]);
  return value;
};

const NONE: ReadonlyArray<never> = [];

export const useNodeArtifacts = (canvasName: string, nodeId: NodeId): ReadonlyArray<ArtifactEntry> =>
  useSourced(() => artifactsSource().list(canvasName, nodeId), NONE, `${canvasName}\u0000${nodeId}`);

export const useArtifactHistory = (canvasName: string, artifactId: ItemId | null): ReadonlyArray<ArtifactVersionRecord> =>
  useSourced(
    () => (artifactId === null ? Promise.resolve(NONE) : artifactsSource().history(canvasName, artifactId)),
    NONE,
    `${canvasName}\u0000${artifactId}`,
  );

export const useArtifactThreads = (canvasName: string, artifactId: ItemId | null): ReadonlyArray<ArtifactThread> =>
  useSourced(
    () => (artifactId === null ? Promise.resolve(NONE) : artifactsSource().threads(canvasName, artifactId)),
    NONE,
    `${canvasName}\u0000${artifactId}`,
  );

/** A refusal said in one line for the pane. */
export const refusalLine = (ruling: ArtifactRuling): string | null =>
  ruling.kind === "applied" ? null : ruling.error.message;
