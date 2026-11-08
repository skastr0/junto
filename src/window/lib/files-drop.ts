/**
 * Drops on the Files modal (0.11, F5), as pure rules the hook applies.
 *
 * Two drags reach the modal. A Finder drag carries files (`Files` in its
 * types) and copies them into a folder: the folder row under the pointer, the
 * folder of a file row, else the node's root. A drag that starts on a tree row
 * moves it: the tree plans it, and each move becomes a rename on disk.
 *
 * The tree names a folder with a trailing `/` ("src/"); the Files service
 * names it without ("src"), and the root is "". Both live here.
 */

/** A path relative to the node's root, `/` separated; "" is the root. */
export type FolderPath = string;

/** A Finder drag: the one drag that carries files from outside the app. */
export const hasFinderFiles = (types: ReadonlyArray<string> | undefined): boolean =>
  types !== undefined && [...types].includes("Files");

/** The tree's path as the Files service names it: no trailing slash. */
export const filePathOfTree = (treePath: string): string =>
  treePath.endsWith("/") ? treePath.slice(0, -1) : treePath;

/** The tree's name for a file or folder at `path`. */
export const treePathOf = (path: string, dir: boolean): string => (dir && path.length > 0 ? `${path}/` : path);

export const basenameOf = (path: string): string => {
  const trimmed = filePathOfTree(path);
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
};

export const parentOf = (path: string): FolderPath => {
  const trimmed = filePathOfTree(path);
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? "" : trimmed.slice(0, slash);
};

const joinPath = (dir: FolderPath, name: string): string => (dir.length === 0 ? name : `${dir}/${name}`);

/** Where a Finder drop lands, and the row to mark; no row means the root. */
export type FinderDropTarget = { readonly dir: FolderPath; readonly row: HTMLElement | null };

const ROOT_TARGET: FinderDropTarget = { dir: "", row: null };

/**
 * The folder under a Finder drag, read off the event's composed path, since
 * the tree's rows live in its shadow root and the event is retargeted to its
 * host. A folder row takes the drop, a flattened folder segment ("a/b") takes
 * it for that segment, a file row hands it to its folder, anything else is
 * the root.
 */
export const finderDropTargetOf = (eventPath: ReadonlyArray<EventTarget>): FinderDropTarget => {
  let segment: string | null = null;
  for (const target of eventPath) {
    if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) continue;
    const flattened = target.getAttribute("data-item-flattened-subitem");
    if (flattened !== null && segment === null) segment = flattened;
    if (target.getAttribute("data-type") !== "item") continue;
    const path = target.getAttribute("data-item-path");
    if (path === null) return ROOT_TARGET;
    if (segment !== null && segment.endsWith("/")) return { dir: filePathOfTree(segment), row: target };
    if (target.getAttribute("data-item-type") === "folder") return { dir: filePathOfTree(path), row: target };
    const parent = target.getAttribute("data-item-parent-path");
    return parent === null || parent.length === 0 ? ROOT_TARGET : { dir: filePathOfTree(parent), row: target };
  }
  return ROOT_TARGET;
};

/** One planned move, in the service's names and the tree's. */
export type FileMove = {
  readonly from: string;
  readonly intoDir: FolderPath;
  readonly treeFrom: string;
  readonly treeTo: string;
};

/**
 * The moves a tree drop asks for: each dragged path into the target folder
 * under its own name. A path already in that folder is no move.
 */
export const movesForDrop = (
  draggedPaths: ReadonlyArray<string>,
  target: { readonly kind: "directory" | "root"; readonly directoryPath: string | null },
): ReadonlyArray<FileMove> => {
  const dir = target.kind === "root" || target.directoryPath === null ? "" : filePathOfTree(target.directoryPath);
  const moves: FileMove[] = [];
  for (const treeFrom of draggedPaths) {
    const from = filePathOfTree(treeFrom);
    if (parentOf(from) === dir) continue;
    const isDir = treeFrom.endsWith("/");
    moves.push({ from, intoDir: dir, treeFrom, treeTo: treePathOf(joinPath(dir, basenameOf(from)), isDir) });
  }
  return moves;
};

/** A folder in the operator's words: its own name, or the root's label. */
export const folderLabel = (dir: FolderPath, rootLabel: string): string => (dir.length === 0 ? rootLabel : basenameOf(dir));

/**
 * What a finished copy says. A name that was taken lands with a suffix
 * (" 2"), so a renamed copy is named; the rest are counted. A source is
 * paired with a landed name only when there is one landed per source:
 * the contract does not promise it (`FileImported`, src/shared/files.ts),
 * and a wrong pairing would name the wrong file, so otherwise it counts.
 */
export const importNotice = (
  sources: ReadonlyArray<string>,
  landed: ReadonlyArray<string>,
  into: string,
): string => {
  if (landed.length !== sources.length) {
    return landed.length === 1
      ? `Copied ${basenameOf(landed[0]!)} into ${into}.`
      : `Copied ${landed.length} items into ${into}.`;
  }
  const renamed = landed.flatMap((path, index) => {
    const source = sources[index];
    if (source === undefined) return [];
    const from = basenameOf(source);
    const to = basenameOf(path);
    return from === to ? [] : [{ from, to }];
  });
  if (landed.length === 1) {
    const name = basenameOf(sources[0] ?? landed[0]!);
    const only = renamed[0];
    return only === undefined ? `Copied ${name} into ${into}.` : `Copied ${name} into ${into} as ${only.to}.`;
  }
  const head = `Copied ${landed.length} files into ${into}`;
  if (renamed.length === 0) return `${head}.`;
  if (renamed.length === 1) return `${head}, ${renamed[0]!.from} as ${renamed[0]!.to}.`;
  return `${head}, ${renamed.length} under new names since theirs were taken.`;
};
