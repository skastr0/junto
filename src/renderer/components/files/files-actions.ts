import type { FileTree } from "@pierre/trees";
import { baseName, parentOf, parseFilePath, ROOT_PATH, type FilePath, type FilesNodeRef } from "@shared/files";
import { filesSource } from "../../lib/files-source";
import { claimFocus } from "../../lib/focus-ownership";
import { treePathOf } from "./files-tree";

/**
 * What a row's menu, a header button or a key asked of the folder (0.11, F2):
 * a new file or folder in `into`, or a move or a trash of `path`. Rename has
 * no dialog: it is the tree's own inline field.
 */
export type FilesAction =
  | { readonly kind: "create"; readonly dir: boolean; readonly into: FilePath }
  | { readonly kind: "move"; readonly path: FilePath; readonly dir: boolean }
  | { readonly kind: "trash"; readonly path: FilePath; readonly dir: boolean };

/** The folder a new entry goes in from a row: a folder row is that folder, a file row its folder. */
export const folderOfRow = (path: FilePath, dir: boolean): FilePath => (dir ? path : parentOf(path));

/** A row of the tree, as a path and whether it is a folder; undefined for none. */
export const rowOf = (treePath: string | null | undefined): { readonly path: FilePath; readonly dir: boolean } | undefined => {
  if (treePath == null) return undefined;
  const dir = treePath.endsWith("/");
  const path = parseFilePath(dir ? treePath.slice(0, -1) : treePath);
  return path === undefined || path === ROOT_PATH ? undefined : { path, dir };
};

/** `path` is `under` or inside it. */
export const isWithin = (path: FilePath, under: FilePath): boolean => path === under || path.startsWith(`${under}/`);

/**
 * A folder typed as a path under the root: leading and trailing slashes and
 * spaces dropped, `/` or nothing the root itself. Undefined when it is not a
 * path at all; main still says whether it is a folder and inside the root.
 */
export const typedFolder = (typed: string): FilePath | undefined => {
  const trimmed = typed.trim().replace(/^\/+|\/+$/gu, "");
  return trimmed === "" ? ROOT_PATH : parseFilePath(trimmed);
};

/** The folders a move may land in: every one but the entry itself, those under it, and the one it is in now. */
export const moveTargets = (folders: ReadonlyArray<FilePath>, moving: FilePath): ReadonlyArray<FilePath> => {
  const from = parentOf(moving);
  return folders.filter((folder) => folder !== from && !isWithin(folder, moving));
};

/** Folders a walk skips: they are large, and nothing is moved into them by hand. */
const SKIPPED = new Set([".git", "node_modules"]);
/** A walk lists at most this many folders; a deeper one is typed. */
export const FOLDER_WALK_LIMIT = 2000;

/**
 * Every folder under the root, root first then by depth, for the Move to list.
 * One listing per folder, a few at a time, stopping at the limit.
 */
export const walkFolders = async (ref: FilesNodeRef, live: () => boolean): Promise<ReadonlyArray<FilePath>> => {
  const found: FilePath[] = [ROOT_PATH];
  let level: FilePath[] = [ROOT_PATH];
  while (level.length > 0 && found.length < FOLDER_WALK_LIMIT && live()) {
    const next: FilePath[] = [];
    for (let at = 0; at < level.length && found.length < FOLDER_WALK_LIMIT; at += 8) {
      const listed = await Promise.all(level.slice(at, at + 8).map((dir) => filesSource().list(ref, dir)));
      for (const result of listed) {
        if (!result.ok) continue;
        for (const entry of result.value) {
          if (!entry.dir || SKIPPED.has(baseName(entry.path))) continue;
          if (found.length >= FOLDER_WALK_LIMIT) break;
          found.push(entry.path);
          next.push(entry.path);
        }
      }
    }
    level = next;
  }
  return found;
};

/** The row's button in the tree's shadow root, by its tree path. */
const rowButton = (tree: FileTree, treePath: string): HTMLElement | null => {
  const shadow = tree.getFileTreeContainer()?.shadowRoot;
  if (shadow == null) return null;
  for (const row of shadow.querySelectorAll<HTMLElement>('[role="treeitem"][data-item-path]')) {
    if (row.dataset.itemPath === treePath) return row;
  }
  return null;
};

/**
 * Give the keyboard to an entry's row once the tree shows it: a folder on the
 * way is expanded as its row appears, since the tree lists a folder only once
 * it is open. Gives up after `waitMs` (a refused or slow watch), leaving focus
 * on the nearest row. Answers a cancel.
 */
export const focusRowWhenShown = (tree: FileTree, entry: { readonly path: FilePath; readonly dir: boolean } | null, waitMs = 3000): (() => void) => {
  if (entry === null) {
    tree.focusFirstItem();
    return () => undefined;
  }
  const target = treePathOf(entry);
  const ancestors: string[] = [];
  for (let dir = parentOf(entry.path); dir !== ROOT_PATH; dir = parentOf(dir)) ancestors.unshift(treePathOf({ path: dir, dir: true }));
  let done = false;
  /** A focus or an expand here tells the tree's subscribers at once, this one among them. */
  let landing = false;
  const land = (): boolean => {
    if (landing) return false;
    landing = true;
    try {
      return landOnce();
    } finally {
      landing = false;
    }
  };
  const landOnce = (): boolean => {
    for (const folder of ancestors) {
      const item = tree.getItem(folder);
      if (item === null) return false;
      if ("expand" in item && !item.isExpanded()) item.expand();
    }
    if (tree.getItem(target) === null) return false;
    done = true;
    tree.focusPath(target);
    tree.scrollToPath(target, { offset: "nearest", focus: true });
    // The tree moves its own focus only while it holds the keyboard; after a dialog it does not.
    // A row just added is drawn a frame or more later.
    const claim = (frames: number): void => {
      const button = rowButton(tree, target);
      if (button !== null) claimFocus(button, "gesture");
      else if (frames > 0) requestAnimationFrame(() => claim(frames - 1));
    };
    requestAnimationFrame(() => claim(30));
    return true;
  };
  let unsubscribe = (): void => undefined;
  const stop = (): void => {
    done = true;
    unsubscribe();
    clearTimeout(timer);
  };
  unsubscribe = tree.subscribe(() => {
    if (!done && land()) stop();
  });
  const timer = setTimeout(() => {
    if (done) return;
    stop();
    const near = tree.focusNearestPath(target);
    const button = near === null ? null : rowButton(tree, near);
    if (button !== null) claimFocus(button, "gesture");
  }, waitMs);
  if (land()) stop();
  return stop;
};
