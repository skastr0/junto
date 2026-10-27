import { useEffect, useState, useSyncExternalStore } from "react";
import type { NodeId } from "@shared/physics/schema";
import { mintItemId } from "@shared/resource-command";
import type { Anchor } from "@shared/thread-subject";
import type { SubjectThread, ThreadPost } from "./subject-threads-source";

/**
 * The Files node's reach into its folder (0.11, F2), as the modal sees it.
 *
 * Tech owns the contract (`src/shared/files.ts`, IPC in `src/shared/ipc.ts`,
 * bytes on `junto-file://`). Until it lands this module carries the plan's
 * sketch of it and an in-memory stand-in, so the modal builds against the
 * shape it will get; `installFilesSource` swaps main's in. Every call names
 * the node and a path relative to its root, never an absolute path.
 */

/** A path relative to the node's root, `/` separated, no `..`. */
export type FilePath = string;
export type FileStamp = { readonly mtimeMs: number; readonly size: number };
export type FileEntry = { readonly path: FilePath; readonly dir: boolean; readonly stamp: FileStamp };
export type FileRead =
  | { readonly kind: "text"; readonly text: string; readonly stamp: FileStamp }
  | { readonly kind: "binary"; readonly mime: string; readonly stamp: FileStamp }
  | { readonly kind: "too-large"; readonly size: number };
export type FilesError = "outside-root" | "not-found" | "exists" | "stale" | "too-large" | "denied" | "root-missing";
export type FilesResult<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: FilesError };

export interface FilesSource {
  readonly list: (nodeId: NodeId) => Promise<FilesResult<ReadonlyArray<FileEntry>>>;
  readonly read: (nodeId: NodeId, path: FilePath) => Promise<FilesResult<FileRead>>;
  /** Refused `stale` when the file on disk is no longer `base`. */
  readonly write: (nodeId: NodeId, path: FilePath, text: string, base: FileStamp) => Promise<FilesResult<FileStamp>>;
  readonly openInDefaultApp: (nodeId: NodeId, path: FilePath) => Promise<FilesResult<void>>;
  readonly revealInFinder: (nodeId: NodeId, path: FilePath) => Promise<FilesResult<void>>;
  /** Called with the paths that changed under the node's root; returns the unsubscribe. */
  readonly watch: (nodeId: NodeId, listener: (paths: ReadonlyArray<FilePath>) => void) => () => void;
}

/** The bytes of a file for a viewer, by node and relative path (the `junto-file:` contract). */
export const fileUrlOf = (nodeId: NodeId, path: FilePath): string =>
  `junto-file://${encodeURIComponent(nodeId)}/${path.split("/").map(encodeURIComponent).join("/")}`;

// --- the stand-in -------------------------------------------------------------

type HeldFile = { text?: string; mime?: string; size: number; mtimeMs: number };

/** An in-memory folder per node, as the stand-in and for tests. `files` maps a path to its text, or a binary's mime. */
export const makeLocalFiles = (
  seed: Readonly<Record<string, string | { readonly mime: string; readonly size: number }>> = {},
  now: () => number = Date.now,
): FilesSource & { readonly touch: (nodeId: NodeId, path: FilePath, text: string) => void } => {
  const roots = new Map<NodeId, Map<FilePath, HeldFile>>();
  const listeners = new Map<NodeId, Set<(paths: ReadonlyArray<FilePath>) => void>>();
  const rootOf = (nodeId: NodeId): Map<FilePath, HeldFile> => {
    let root = roots.get(nodeId);
    if (root === undefined) {
      root = new Map(
        Object.entries(seed).map(([path, held]): [FilePath, HeldFile] =>
          typeof held === "string"
            ? [path, { text: held, size: held.length, mtimeMs: now() }]
            : [path, { mime: held.mime, size: held.size, mtimeMs: now() }],
        ),
      );
      roots.set(nodeId, root);
    }
    return root;
  };
  const stampOf = (held: HeldFile): FileStamp => ({ mtimeMs: held.mtimeMs, size: held.size });
  const changed = (nodeId: NodeId, path: FilePath): void => {
    for (const listener of listeners.get(nodeId) ?? []) listener([path]);
  };
  const put = (nodeId: NodeId, path: FilePath, text: string): FileStamp => {
    const root = rootOf(nodeId);
    const before = root.get(path)?.mtimeMs ?? 0;
    // A write always moves the clock, so two writes in one millisecond still differ.
    const held = { text, size: text.length, mtimeMs: Math.max(now(), before + 1) };
    root.set(path, held);
    return stampOf(held);
  };
  const dirsOf = (paths: Iterable<FilePath>): Set<FilePath> => {
    const dirs = new Set<FilePath>();
    for (const path of paths) {
      const parts = path.split("/");
      for (let index = 1; index < parts.length; index += 1) dirs.add(parts.slice(0, index).join("/"));
    }
    return dirs;
  };
  return {
    list: async (nodeId) => {
      const root = rootOf(nodeId);
      const files = [...root].map(([path, held]) => ({ path, dir: false, stamp: stampOf(held) }));
      const dirs = [...dirsOf(root.keys())].map((path) => ({ path, dir: true, stamp: { mtimeMs: 0, size: 0 } }));
      return { ok: true, value: [...dirs, ...files] };
    },
    read: async (nodeId, path) => {
      const held = rootOf(nodeId).get(path);
      if (held === undefined) return { ok: false, error: "not-found" };
      if (held.text !== undefined) return { ok: true, value: { kind: "text", text: held.text, stamp: stampOf(held) } };
      return { ok: true, value: { kind: "binary", mime: held.mime ?? "application/octet-stream", stamp: stampOf(held) } };
    },
    write: async (nodeId, path, text, base) => {
      const held = rootOf(nodeId).get(path);
      if (held !== undefined && (held.mtimeMs !== base.mtimeMs || held.size !== base.size)) return { ok: false, error: "stale" };
      const stamp = put(nodeId, path, text);
      changed(nodeId, path);
      return { ok: true, value: stamp };
    },
    openInDefaultApp: async (nodeId, path) => (rootOf(nodeId).has(path) ? { ok: true, value: undefined } : { ok: false, error: "not-found" }),
    revealInFinder: async (nodeId, path) => (rootOf(nodeId).has(path) ? { ok: true, value: undefined } : { ok: false, error: "not-found" }),
    watch: (nodeId, listener) => {
      const set = listeners.get(nodeId) ?? new Set();
      set.add(listener);
      listeners.set(nodeId, set);
      return () => set.delete(listener);
    },
    /** Another program wrote the file: what a watcher reports. */
    touch: (nodeId, path, text) => {
      put(nodeId, path, text);
      changed(nodeId, path);
    },
  };
};

let source: FilesSource = makeLocalFiles({
  "README.md": "# Files\n\nThe Files node's stand-in folder, until main serves the real one.\n",
  "src/index.ts": 'export const hello = (name: string): string => `Hello, ${name}`;\n',
  "assets/logo.png": { mime: "image/png", size: 2048 },
  "docs/brief.pdf": { mime: "application/pdf", size: 81920 },
  "dist/app.zip": { mime: "application/zip", size: 1048576 },
});

export const filesSource = (): FilesSource => source;

/** Main's source, once the Files service lands (or a test's). */
export const installFilesSource = (next: FilesSource): void => {
  source = next;
};

// --- what the main pane shows -------------------------------------------------

export type FileView = "markdown" | "code" | "image" | "pdf" | "other" | "too-large";

const MARKDOWN = /\.(md|markdown|mdx)$/i;

/** The main pane's viewer for a read: the editor for text, a viewer for PDFs and images, else the way out. */
export const fileViewOf = (path: FilePath, read: FileRead): FileView => {
  if (read.kind === "too-large") return "too-large";
  if (read.kind === "text") return MARKDOWN.test(path) ? "markdown" : "code";
  if (read.mime === "application/pdf") return "pdf";
  if (read.mime.startsWith("image/")) return "image";
  return "other";
};

/** A refusal in the operator's words. */
export const filesErrorLine = (error: FilesError): string => {
  switch (error) {
    case "outside-root":
      return "That path is outside this folder.";
    case "not-found":
      return "This file is gone from the folder.";
    case "exists":
      return "A file with that name is already here.";
    case "stale":
      return "This file changed on disk since you opened it.";
    case "too-large":
      return "This file is too large to open here.";
    case "denied":
      return "Junto is not allowed to read or write this file.";
    case "root-missing":
      return "This node's folder is missing on this machine.";
  }
};

// --- drafts -------------------------------------------------------------------
//
// Unsaved text outlives the modal for the session, keyed by node and path:
// switching files or closing the modal never drops a change. Held outside
// React so the tree's marks and the editor read one store.

export type FileDraft = { readonly text: string; readonly base: FileStamp };

const drafts = new Map<string, FileDraft>();
const draftListeners = new Set<() => void>();
let draftsVersion = 0;
const draftKey = (nodeId: NodeId, path: FilePath): string => `${nodeId}\u0000${path}`;

export const fileDraft = (nodeId: NodeId, path: FilePath): FileDraft | undefined => drafts.get(draftKey(nodeId, path));

/** Hold `text` as the unsaved draft; text equal to what was read clears it. */
export const setFileDraft = (nodeId: NodeId, path: FilePath, draft: FileDraft | undefined): void => {
  const key = draftKey(nodeId, path);
  const held = drafts.get(key);
  if (draft === undefined) {
    if (held === undefined) return;
    drafts.delete(key);
  } else {
    if (held?.text === draft.text && held.base === draft.base) return;
    drafts.set(key, draft);
  }
  draftsVersion += 1;
  for (const listener of draftListeners) listener();
};

/** The node's paths with unsaved changes. */
export const dirtyPaths = (nodeId: NodeId): ReadonlyArray<FilePath> => {
  const prefix = `${nodeId}\u0000`;
  return [...drafts.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
};

/** Re-renders on any draft change. */
export const useDraftsVersion = (): number =>
  useSyncExternalStore(
    (listener) => {
      draftListeners.add(listener);
      return () => draftListeners.delete(listener);
    },
    () => draftsVersion,
  );

// --- comments -------------------------------------------------------------------
//
// A file's threads (F7, product-feed) hang on a `file` subject that the
// thread contract does not carry yet. Until it does they live here, in this
// window only, so the rail is whole; F7 points these at the subject source.

const fileThreads = new Map<string, SubjectThread[]>();
const threadListeners = new Set<() => void>();
let threadsVersion = 0;

export const fileThreadsOf = (nodeId: NodeId, path: FilePath): ReadonlyArray<SubjectThread> =>
  fileThreads.get(draftKey(nodeId, path)) ?? [];

/** Post on a file: a new thread at `anchor`, or a reply in `threadId`. The refusal in words, or null. */
export const postFileComment = async (
  nodeId: NodeId,
  path: FilePath,
  post: { readonly text: string; readonly anchor?: Anchor; readonly threadId?: string },
): Promise<string | null> => {
  if (post.text.trim() === "") return "Write something to post.";
  const key = draftKey(nodeId, path);
  const threads = fileThreads.get(key) ?? [];
  const entry: ThreadPost = { messageId: mintItemId(), author: { kind: "operator" }, text: post.text, at: Date.now() };
  const target = post.threadId === undefined ? undefined : threads.find((thread) => thread.threadId === post.threadId);
  fileThreads.set(
    key,
    target === undefined
      ? [...threads, { threadId: entry.messageId, ...(post.anchor === undefined ? {} : { anchor: post.anchor }), posts: [entry] }]
      : threads.map((thread) => (thread === target ? { ...thread, posts: [...thread.posts, entry] } : thread)),
  );
  threadsVersion += 1;
  for (const listener of threadListeners) listener();
  return null;
};

export const useFileThreads = (nodeId: NodeId, path: FilePath): ReadonlyArray<SubjectThread> => {
  useSyncExternalStore(
    (listener) => {
      threadListeners.add(listener);
      return () => threadListeners.delete(listener);
    },
    () => threadsVersion,
  );
  return fileThreadsOf(nodeId, path);
};

// --- hooks ----------------------------------------------------------------------

export type Loaded<A> = { readonly state: "loading" } | { readonly state: "ready"; readonly value: A } | { readonly state: "refused"; readonly error: FilesError };

/** The node's entries, read again when the watcher reports a change. */
export const useFileEntries = (nodeId: NodeId): Loaded<ReadonlyArray<FileEntry>> => {
  const [entries, setEntries] = useState<Loaded<ReadonlyArray<FileEntry>>>({ state: "loading" });
  useEffect(() => {
    let live = true;
    const load = (): void => {
      void filesSource()
        .list(nodeId)
        .then((result) => {
          if (live) setEntries(result.ok ? { state: "ready", value: result.value } : { state: "refused", error: result.error });
        });
    };
    load();
    const stop = filesSource().watch(nodeId, load);
    return () => {
      live = false;
      stop();
    };
  }, [nodeId]);
  return entries;
};
