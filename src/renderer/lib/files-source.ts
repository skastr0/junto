import { useEffect, useState, useSyncExternalStore } from "react";
import type { NodeId } from "@shared/physics/schema";
import { fileMime } from "@shared/file-url";
import {
  FILES_SEARCH_LIMIT,
  foldForSearch,
  parentOf,
  sameStamp,
  scoreFilePath,
  ROOT_PATH,
  type FileEntry,
  type FilePath,
  type FileRead,
  type FilesChanged,
  type FilesError,
  type FilesNodeRef,
  type FilesResult,
  type FilesRoot,
  type FileStamp,
  type JuntoFilesApi,
} from "@shared/files";

/**
 * The Files node's reach into its folder (0.11, F2), as the modal sees it:
 * main's `window.junto.files` (`src/shared/files.ts`). Every call names the
 * node and a path relative to its root, never an absolute path.
 */
export type FilesSource = JuntoFilesApi["files"];

// --- an in-memory folder, for tests --------------------------------------------

type HeldFile = { text?: string; size: number; mtimeMs: number };

/**
 * An in-memory folder per node, for tests. `seed` maps a
 * path to its text, or to a binary's size; a binary's mime is read off its
 * name as main does. `touch` is another program writing a file.
 */
export const makeLocalFiles = (
  seed: Readonly<Record<string, string | { readonly size: number }>> = {},
  now: () => number = Date.now,
): FilesSource & { readonly touch: (node: NodeId, path: string, text: string) => void } => {
  const roots = new Map<NodeId, Map<string, HeldFile>>();
  const listeners = new Set<(event: FilesChanged) => void>();
  const rootOf = (node: NodeId): Map<string, HeldFile> => {
    let root = roots.get(node);
    if (root === undefined) {
      root = new Map(
        Object.entries(seed).map(([path, held]): [string, HeldFile] =>
          typeof held === "string" ? [path, { text: held, size: held.length, mtimeMs: now() }] : [path, { size: held.size, mtimeMs: now() }],
        ),
      );
      roots.set(node, root);
    }
    return root;
  };
  const stampOf = (held: HeldFile): FileStamp => ({ mtimeMs: held.mtimeMs, size: held.size });
  const changed = (node: NodeId, path: FilePath): void => {
    for (const listener of listeners) listener({ node, kind: "paths", paths: [path] });
  };
  const put = (node: NodeId, path: string, text: string): FileStamp => {
    const root = rootOf(node);
    // A write always moves the clock, so two writes in one millisecond still differ.
    const held = { text, size: text.length, mtimeMs: Math.max(now(), (root.get(path)?.mtimeMs ?? 0) + 1) };
    root.set(path, held);
    return stampOf(held);
  };
  const ok = <A>(value: A): FilesResult<A> => ({ ok: true, value });
  const refused = <A>(error: FilesError): FilesResult<A> => ({ ok: false, error });
  const has = (ref: FilesNodeRef, path: FilePath): boolean => rootOf(ref.node).has(path);
  return {
    open: async () => ok<FilesRoot>({ name: "folder", repo: false }),
    close: async () => ok(null),
    count: async (ref) => ok({ files: rootOf(ref.node).size, capped: false }),
    list: async (ref, dir) => {
      const prefix = dir === ROOT_PATH ? "" : `${dir}/`;
      const children = new Map<string, FileEntry>();
      for (const [path, held] of rootOf(ref.node)) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf("/");
        const name = slash < 0 ? rest : rest.slice(0, slash);
        const child = `${prefix}${name}` as FilePath;
        children.set(child, { path: child, dir: slash >= 0, stamp: slash >= 0 ? { mtimeMs: 0, size: 0 } : stampOf(held) });
      }
      const entries = [...children.values()].sort((a, b) => Number(b.dir) - Number(a.dir) || a.path.localeCompare(b.path));
      return ok(entries);
    },
    search: async (ref, query) => {
      const folded = foldForSearch(query);
      const ranked = [...rootOf(ref.node).keys()].flatMap((path) => {
        const positions: number[] = [];
        const score = scoreFilePath(foldForSearch(path), folded, positions);
        return score === undefined ? [] : [{ path: path as FilePath, positions, score }];
      });
      ranked.sort((a, b) => b.score - a.score);
      const matches = ranked.slice(0, FILES_SEARCH_LIMIT).map(({ path, positions }) => ({ path, positions }));
      return ok({ kind: "results", query, matches, total: rootOf(ref.node).size });
    },
    read: async (ref, path) => {
      const held = rootOf(ref.node).get(path);
      if (held === undefined) return refused("not-found");
      if (held.text !== undefined) return ok<FileRead>({ kind: "text", text: held.text, stamp: stampOf(held) });
      return ok<FileRead>({ kind: "binary", mime: fileMime(path), stamp: stampOf(held) });
    },
    write: async (ref, path, text, base) => {
      const held = rootOf(ref.node).get(path);
      if (held !== undefined && (held.mtimeMs !== base.mtimeMs || held.size !== base.size)) return refused("stale");
      const stamp = put(ref.node, path, text);
      changed(ref.node, path);
      return ok(stamp);
    },
    create: async () => refused("failed"),
    rename: async (ref, path, name) => {
      const root = rootOf(ref.node);
      const dir = parentOf(path);
      const next = (dir === ROOT_PATH ? name : `${dir}/${name}`) as FilePath;
      const under = (key: string): boolean => key === path || key.startsWith(`${path}/`);
      if (![...root.keys()].some(under)) return refused("not-found");
      if ([...root.keys()].some((key) => key === next || key.startsWith(`${next}/`))) return refused("exists");
      for (const [key, held] of [...root]) {
        if (!under(key)) continue;
        root.delete(key);
        root.set(`${next}${key.slice(path.length)}`, held);
      }
      changed(ref.node, path);
      changed(ref.node, next);
      return ok(next);
    },
    move: async () => refused("failed"),
    trash: async () => refused("failed"),
    import: async () => refused("failed"),
    openInDefaultApp: async (ref, path) => (has(ref, path) ? ok(null) : refused("not-found")),
    revealInFinder: async (ref, path) => (has(ref, path) ? ok(null) : refused("not-found")),
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pathForDroppedFile: () => "",
    touch: (node, path, text) => {
      put(node, path, text);
      changed(node, path as FilePath);
    },
  };
};

const refuse = async (): Promise<FilesResult<never>> => ({ ok: false, error: "failed" });

/** Without main's files API (a window with no preload), every call refuses, so the modal says it cannot open the folder. */
const refusing: FilesSource = {
  open: refuse,
  close: refuse,
  count: refuse,
  list: refuse,
  search: refuse,
  read: refuse,
  write: refuse,
  create: refuse,
  rename: refuse,
  move: refuse,
  trash: refuse,
  import: refuse,
  openInDefaultApp: refuse,
  revealInFinder: refuse,
  onChange: () => () => undefined,
  pathForDroppedFile: () => "",
};

let installed: FilesSource | null = null;

/** What a test installed, else main's files API. */
export const filesSource = (): FilesSource =>
  installed ?? (typeof window === "undefined" ? undefined : (window.junto as Partial<JuntoFilesApi> | undefined)?.files) ?? refusing;

/** A test's source; null goes back to main's. */
export const installFilesSource = (next: FilesSource | null): void => {
  installed = next;
};

// --- what the main pane shows -------------------------------------------------

export type FileView = "markdown" | "code" | "image" | "pdf" | "other" | "too-large";

const MARKDOWN = /\.(md|markdown|mdx)$/i;

/** The main pane's viewer for a read: the editor for text, a viewer for PDFs and images, else the way out. */
export const fileViewOf = (path: FilePath, read: FileRead): FileView => {
  // The name decides a preview first: an all-ASCII PDF or an SVG reads as text,
  // and a large one as too large, yet its bytes still preview over junto-file.
  const mime = fileMime(path);
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (read.kind === "too-large") return "too-large";
  if (read.kind === "text") return MARKDOWN.test(path) ? "markdown" : "code";
  return "other";
};

/** A refusal in the operator's words. */
export const filesErrorLine = (error: FilesError): string => {
  switch (error) {
    case "no-node":
      return "This Files node is gone from the canvas.";
    case "elsewhere":
      return "This folder lives on another machine. Open it there.";
    case "root-missing":
      return "This node's folder is missing on this machine.";
    case "invalid-path":
      return "That is not a name a file can have here.";
    case "outside-root":
      return "That path leads outside this folder.";
    case "not-found":
      return "This file is gone from the folder.";
    case "exists":
      return "A file with that name is already here.";
    case "not-dir":
      return "That is a file, not a folder.";
    case "is-dir":
      return "That is a folder, not a file.";
    case "stale":
      return "This file changed on disk since you opened it.";
    case "too-large":
      return "This file is too large to open here.";
    case "denied":
      return "Junto is not allowed to read or write this file.";
    case "failed":
      return "That did not work. Try again.";
  }
};

/** Whether a change event names `path`: a write to it, or a reset of the whole tree. */
export const changeTouches = (event: FilesChanged, node: NodeId, path: FilePath): boolean =>
  event.node === node && (event.kind === "reset" || (event.kind === "paths" && event.paths.includes(path)));

/** The folders whose listing a change event makes stale. */
export const foldersTouched = (event: FilesChanged): ReadonlyArray<FilePath> | "all" =>
  event.kind === "paths" ? [...new Set(event.paths.map(parentOf))] : "all";

// --- drafts -------------------------------------------------------------------
//
// Unsaved text outlives the modal for the session, keyed by node and path:
// switching files or closing the modal never drops a change. Held outside
// React so the tree's marks and the editor read one store.

export type FileDraft = { readonly text: string; readonly base: FileStamp };

const drafts = new Map<string, FileDraft>();
const draftListeners = new Set<() => void>();
let draftsVersion = 0;
const draftKey = (node: NodeId, path: FilePath): string => `${node}\u0000${path}`;

export const fileDraft = (node: NodeId, path: FilePath): FileDraft | undefined => drafts.get(draftKey(node, path));

/** Hold `draft` as the file's unsaved text; undefined drops it. */
export const setFileDraft = (node: NodeId, path: FilePath, draft: FileDraft | undefined): void => {
  const key = draftKey(node, path);
  const held = drafts.get(key);
  if (draft === undefined) {
    if (held === undefined) return;
    drafts.delete(key);
  } else {
    if (held?.text === draft.text && sameStamp(held.base, draft.base)) return;
    drafts.set(key, draft);
  }
  draftsVersion += 1;
  for (const listener of draftListeners) listener();
};

/** The node's paths with unsaved changes. */
export const dirtyPaths = (node: NodeId): ReadonlyArray<FilePath> => {
  const prefix = `${node}\u0000`;
  return [...drafts.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length) as FilePath);
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

// --- the node's folder ------------------------------------------------------------

export type Loaded<A> = { readonly state: "loading" } | { readonly state: "ready"; readonly value: A } | { readonly state: "refused"; readonly error: FilesError };

/** Serve the node to this window while the modal shows it: `open` on mount, `close` on unmount. */
export const useFilesRoot = (ref: FilesNodeRef): Loaded<FilesRoot> => {
  const [root, setRoot] = useState<Loaded<FilesRoot>>({ state: "loading" });
  const { canvas, node } = ref;
  useEffect(() => {
    let live = true;
    const source = filesSource();
    void source.open({ canvas, node }).then((result) => {
      if (live) setRoot(result.ok ? { state: "ready", value: result.value } : { state: "refused", error: result.error });
    });
    const stop = source.onChange((event) => {
      if (live && event.node === node && event.kind === "closed") setRoot({ state: "refused", error: event.error });
    });
    return () => {
      live = false;
      stop();
      void source.close({ canvas, node });
    };
  }, [canvas, node]);
  return root;
};
