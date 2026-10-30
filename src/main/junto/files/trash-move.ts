import { lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { numberedName } from "./fs-ops";

/**
 * Move to the user's trash with no Electron (0.12, X1c0): what a windowless
 * machine's Files service does for `trash`, where `shell.trashItem` does not
 * exist. One rename into the trash, never an unlink and never a copy then
 * delete. A rename across volumes fails `EXDEV` and is refused `denied` (an
 * `EPERM` the caller maps), with the file where it was: the home trash serves
 * the home volume only, and another volume's own trash is not handled here.
 *
 * - macOS: `~/.Trash`, under a free name (`name 2.ext`) so nothing is overwritten.
 * - Linux: the XDG trash (`$XDG_DATA_HOME/Trash`, else `~/.local/share/Trash`).
 *   The `info/<name>.trashinfo` file is created exclusively before the move,
 *   as the spec orders; it reserves the name, so a name is never reused.
 * - Anything else is refused `denied`.
 *
 * The caller has resolved `absolute` inside its root already (`trashAt`); a
 * symlink is moved as the link, because `rename` never follows one.
 */

export type TrashEnv = {
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  /** `$XDG_DATA_HOME`; the default under `home` when unset or not absolute. */
  readonly dataHome?: string;
  readonly now?: () => Date;
  /** Swapped in tests to fail with `EXDEV`. */
  readonly move?: (from: string, to: string) => Promise<void>;
};

/** Names tried before the trash is called full of the same name. */
const NAME_TRIES = 1000;

const refusal = (code: "EPERM", message: string): Error => Object.assign(new Error(message), { code });

const taken = async (absolute: string): Promise<boolean> => {
  try {
    await lstat(absolute);
    return true;
  } catch (cause) {
    if ((cause as { code?: unknown }).code === "ENOENT") return false;
    throw cause;
  }
};

const dayTime = (at: Date): string => at.toISOString().slice(0, 19);

const encodedPath = (absolute: string): string => absolute.split("/").map(encodeURIComponent).join("/");

/** Run the move; an `EXDEV` becomes a `denied`, anything else passes up. */
const moved = async (move: NonNullable<TrashEnv["move"]>, from: string, to: string): Promise<void> => {
  try {
    await move(from, to);
  } catch (cause) {
    if ((cause as { code?: unknown }).code === "EXDEV") throw refusal("EPERM", "the trash is on another volume");
    throw cause;
  }
};

const trashOnMac = async (absolute: string, home: string, move: NonNullable<TrashEnv["move"]>): Promise<void> => {
  const folder = join(home, ".Trash");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const name = basename(absolute);
  const directory = (await lstat(absolute)).isDirectory();
  for (let n = 1; n <= NAME_TRIES; n++) {
    const target = join(folder, n === 1 ? name : numberedName(name, n, directory));
    if (await taken(target)) continue;
    await moved(move, absolute, target);
    return;
  }
  throw refusal("EPERM", "the trash holds too many of that name");
};

const trashOnLinux = async (
  absolute: string,
  dataHome: string,
  move: NonNullable<TrashEnv["move"]>,
  now: () => Date,
): Promise<void> => {
  const folder = join(dataHome, "Trash");
  const files = join(folder, "files");
  const info = join(folder, "info");
  await mkdir(files, { recursive: true, mode: 0o700 });
  await mkdir(info, { recursive: true, mode: 0o700 });
  const name = basename(absolute);
  const directory = (await lstat(absolute)).isDirectory();
  const body = `[Trash Info]\nPath=${encodedPath(absolute)}\nDeletionDate=${dayTime(now())}\n`;
  for (let n = 1; n <= NAME_TRIES; n++) {
    const chosen = n === 1 ? name : numberedName(name, n, directory);
    const record = join(info, `${chosen}.trashinfo`);
    if (await taken(join(files, chosen))) continue;
    try {
      // `wx`: the record reserves the name; another trasher holding it sends this one on.
      await writeFile(record, body, { flag: "wx", mode: 0o600 });
    } catch (cause) {
      if ((cause as { code?: unknown }).code === "EEXIST") continue;
      throw cause;
    }
    try {
      await moved(move, absolute, join(files, chosen));
    } catch (cause) {
      // The record is this call's own; the file never moved.
      await unlink(record).catch(() => undefined);
      throw cause;
    }
    return;
  }
  throw refusal("EPERM", "the trash holds too many of that name");
};

/** A `trash` for `FilesServiceDeps` that needs no Electron. */
export const trashMove = (env: TrashEnv = {}): ((absolute: string) => Promise<void>) => {
  const platform = env.platform ?? process.platform;
  const home = env.home ?? homedir();
  const move = env.move ?? rename;
  const now = env.now ?? (() => new Date());
  const fromEnvironment = env.dataHome ?? process.env["XDG_DATA_HOME"];
  const dataHome = fromEnvironment !== undefined && isAbsolute(fromEnvironment) ? fromEnvironment : join(home, ".local", "share");
  return async (absolute) => {
    if (!isAbsolute(absolute)) throw refusal("EPERM", "the trash takes an absolute path");
    if (platform === "darwin") return trashOnMac(absolute, home, move);
    if (platform === "linux") return trashOnLinux(absolute, dataHome, move, now);
    throw refusal("EPERM", "this system has no trash Junto can reach");
  };
};
