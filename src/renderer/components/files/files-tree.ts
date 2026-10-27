import { useEffect } from "react";
import type { FileTree, FileTreeBatchOperation } from "@pierre/trees";
import { parseFilePath, ROOT_PATH, type FileEntry, type FilePath, type FilesNodeRef } from "@shared/files";
import { filesSource, foldersTouched } from "../../lib/files-source";

/** The tree's name for an entry: a directory ends in `/`, as `@pierre/trees` reads paths. */
export const treePathOf = (entry: Pick<FileEntry, "path" | "dir">): string => (entry.dir ? `${entry.path}/` : entry.path);

/** A tree path back to the relative path it names. */
export const filePathOfTree = (treePath: string): FilePath | undefined =>
  parseFilePath(treePath.endsWith("/") ? treePath.slice(0, -1) : treePath);

/** The file a tree selection opens: the last selected row that is not a directory. */
export const fileOfSelection = (selected: ReadonlyArray<string>): FilePath | null => {
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const path = selected[index];
    if (path !== undefined && !path.endsWith("/")) return filePathOfTree(path) ?? null;
  }
  return null;
};

/**
 * The tree edits that make a folder's children match a fresh listing: an add
 * for each new entry, a remove (recursive for a folder) for each one gone.
 * `held` is the children the tree has for it now.
 */
export const folderOps = (
  held: ReadonlySet<string>,
  entries: ReadonlyArray<FileEntry>,
): { readonly ops: ReadonlyArray<FileTreeBatchOperation>; readonly children: ReadonlySet<string> } => {
  const children = new Set(entries.map(treePathOf));
  const ops: FileTreeBatchOperation[] = [];
  for (const path of held) if (!children.has(path)) ops.push({ type: "remove", path, recursive: path.endsWith("/") });
  for (const path of children) if (!held.has(path)) ops.push({ type: "add", path });
  return { ops, children };
};

/**
 * Keep the tree to the folder, one level at a time: the root on open, a
 * folder when the operator expands it, and every listed folder a change
 * event names. A folder is never walked before it is opened.
 */
export const useFolderTree = (ref: FilesNodeRef, model: FileTree, ready: boolean): void => {
  const { canvas, node } = ref;
  useEffect(() => {
    if (!ready) return;
    let live = true;
    const source = filesSource();
    /** Each listed folder's children, as tree paths. */
    const listed = new Map<FilePath, ReadonlySet<string>>();
    const loading = new Set<FilePath>();
    const load = async (dir: FilePath): Promise<void> => {
      if (loading.has(dir)) return;
      loading.add(dir);
      const result = await source.list({ canvas, node }, dir);
      loading.delete(dir);
      if (!live || !result.ok) return;
      const { ops, children } = folderOps(listed.get(dir) ?? new Set(), result.value);
      listed.set(dir, children);
      for (const op of ops) {
        if (op.type !== "remove" || !op.path.endsWith("/")) continue;
        // A folder gone takes its listing, and every listing under it, along.
        const gone = filePathOfTree(op.path);
        for (const key of [...listed.keys()]) if (gone !== undefined && (key === gone || key.startsWith(`${gone}/`))) listed.delete(key);
      }
      if (ops.length > 0) model.batch(ops);
    };
    /** A folder the operator expanded that has not been listed yet. */
    const expandUnlisted = (): void => {
      const rows = model.getVisibleRows(0, model.getVisibleCount());
      for (const row of rows) {
        if (row.kind !== "directory" || !row.isExpanded) continue;
        const dir = filePathOfTree(row.path);
        if (dir !== undefined && !listed.has(dir)) void load(dir);
      }
    };
    void load(ROOT_PATH);
    const unsubscribe = model.subscribe(expandUnlisted);
    const stop = source.onChange((event) => {
      if (event.node !== node || event.kind === "closed") return;
      const folders = foldersTouched(event);
      for (const dir of folders === "all" ? [...listed.keys()] : folders) if (listed.has(dir)) void load(dir);
    });
    return () => {
      live = false;
      unsubscribe();
      stop();
    };
  }, [canvas, node, model, ready]);
};
