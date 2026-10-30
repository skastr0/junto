import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { FilePath } from "@shared/files";

/**
 * A rename made outside Junto (Finder, a shell, git) reaches main as a watch
 * batch naming the old path, now gone, and the new one, now there: nothing in
 * the batch pairs them. A file keeps its id (`FileId`) across a rename on
 * one volume, so a file Junto read is paired with an appeared path
 * holding the same id. A folder renamed over a file Junto read pairs the same
 * way, through the file's place under the new folder.
 *
 * Only files Junto read are paired: those are the ones a window has open or
 * holds a draft of. The rest of a rename is the tree's, which lists again.
 */

/**
 * Device and inode, as one key, with the birth time, size and modified time
 * a rename keeps: a filesystem that reuses an inode at once (ext4, tmpfs)
 * gives a new file the old one's inode, but not all of these.
 */
export type FileId = string;

export type Moved = { readonly from: FilePath; readonly to: FilePath };

export type Probe = { readonly kind: "gone" } | { readonly kind: "file"; readonly id: FileId } | { readonly kind: "dir" } | { readonly kind: "other" };

export const probePath = async (absolute: string): Promise<Probe> => {
  try {
    const info = await stat(absolute);
    if (info.isFile()) {
      return { kind: "file", id: [info.dev, info.ino, info.birthtimeMs, info.size, info.mtimeMs].map(String).join(":") };
    }
    return info.isDirectory() ? { kind: "dir" } : { kind: "other" };
  } catch (cause) {
    const code = (cause as { readonly code?: unknown }).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "gone" } : { kind: "other" };
  }
};

const under = (path: string, dir: string): boolean => path.startsWith(`${dir}/`);

/**
 * The renames in one batch of changed paths. `known` is each file Junto read
 * and its id; `held` are paths an earlier batch saw go unpaired, since a
 * rename's two halves may fall in two batches. `unpaired` are the gone paths
 * still worth holding for the next batch; `expired` are held paths that
 * paired with nothing in theirs, deleted rather than renamed.
 */
export const pairRenames = async (
  root: string,
  batch: ReadonlyArray<FilePath>,
  known: ReadonlyMap<FilePath, FileId>,
  held: ReadonlyArray<FilePath> = [],
  probe: (absolute: string) => Promise<Probe> = probePath,
): Promise<{ readonly moves: ReadonlyArray<Moved>; readonly unpaired: ReadonlyArray<FilePath>; readonly expired: ReadonlyArray<FilePath> }> => {
  const paths = [...new Set([...held, ...batch])];
  const worth = (path: FilePath): boolean => known.has(path) || [...known.keys()].some((file) => under(file, path));
  // Nothing Junto read is named, under a named folder, or held: no stat at all.
  if (!paths.some(worth)) return { moves: [], unpaired: [], expired: [] };
  const probes = new Map(await Promise.all(paths.map(async (path) => [path, await probe(join(root, path))] as const)));
  const gone = paths.filter((path) => probes.get(path)?.kind === "gone" && worth(path));
  const appeared = batch.filter((path) => probes.get(path)?.kind !== "gone");
  const moves: Moved[] = [];
  const taken = new Set<FilePath>();
  for (const from of gone) {
    const file = known.get(from);
    for (const to of appeared) {
      if (taken.has(to) || to === from) continue;
      const there = probes.get(to);
      let same = false;
      if (file !== undefined) same = there?.kind === "file" && there.id === file;
      else if (there?.kind === "dir") {
        // A folder: one file Junto read under it is where it was, under the new name.
        const inside = [...known].find(([path]) => under(path, from));
        if (inside !== undefined) {
          const moved = await probe(join(root, `${to}${inside[0].slice(from.length)}`));
          same = moved.kind === "file" && moved.id === inside[1];
        }
      }
      if (same) {
        moves.push({ from, to });
        taken.add(to);
        break;
      }
    }
  }
  const paired = new Set(moves.map((move) => move.from));
  // A held path gets one more batch, not more: by then it was deleted, not renamed.
  const unpaired = gone.filter((path) => !paired.has(path) && !held.includes(path));
  const expired = gone.filter((path) => !paired.has(path) && held.includes(path));
  return { moves, unpaired, expired };
};

/** The ids Junto holds, carried by a rename (in Junto or outside it): a folder's, everything under it. */
export const moveIds = (ids: Map<FilePath, FileId>, from: FilePath, to: FilePath): void => {
  for (const [path, id] of [...ids]) {
    if (path !== from && !under(path, from)) continue;
    ids.delete(path);
    ids.set(`${to}${path.slice(from.length)}` as FilePath, id);
  }
};
