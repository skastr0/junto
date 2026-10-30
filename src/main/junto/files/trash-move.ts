import { lstat, mkdir, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
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
 *   as the spec orders.
 *
 * A name is reserved before anything moves, because `rename` replaces what is
 * at its target and checking for a free name first is a race: two trashes of
 * `notes.md` would both see it free and the second would replace the first.
 * The reservation is an empty file made with `wx` (for a file or a link) or a
 * new empty folder (for a folder), which fails `EEXIST` for whoever comes
 * second; the move then renames onto our own placeholder. A move that fails
 * takes its placeholder away again, only while it is still empty.
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

const codeOf = (cause: unknown): unknown => (cause as { code?: unknown } | null)?.code;

/**
 * Reserve `target` as an empty file or folder; false when the name is taken
 * (`EEXIST`), whoever holds it, so the caller goes on to the next name.
 */
const reserve = async (target: string, directory: boolean): Promise<boolean> => {
  try {
    if (directory) await mkdir(target, { mode: 0o700 });
    else await writeFile(target, "", { flag: "wx", mode: 0o600 });
    return true;
  } catch (cause) {
    if (codeOf(cause) === "EEXIST") return false;
    throw cause;
  }
};

/** Take a placeholder away if nothing has been put in it; anything else there is left alone. */
const release = async (target: string, directory: boolean): Promise<void> => {
  try {
    if (directory) {
      if ((await readdir(target)).length === 0) await rmdir(target);
      return;
    }
    const info = await lstat(target);
    if (info.isFile() && info.size === 0) await unlink(target);
  } catch {
    // Already gone, or no longer ours to remove.
  }
};

/** The spec's DeletionDate: local time, `YYYY-MM-DDThh:mm:ss`, no zone. */
const dayTime = (at: Date): string => {
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${String(at.getFullYear())}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
};

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

/** Move onto our own placeholder at `target`; a refused move takes the placeholder away. */
const moveReserved = async (move: NonNullable<TrashEnv["move"]>, from: string, target: string, directory: boolean): Promise<void> => {
  try {
    await moved(move, from, target);
  } catch (cause) {
    await release(target, directory);
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
    if (!(await reserve(target, directory))) continue;
    await moveReserved(move, absolute, target, directory);
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
    // The record first, as the spec orders: it reserves the name against other trashers.
    try {
      await writeFile(record, body, { flag: "wx", mode: 0o600 });
    } catch (cause) {
      if (codeOf(cause) === "EEXIST") continue;
      throw cause;
    }
    // And the name in files/, so a writer that skips the record cannot be overwritten either.
    const target = join(files, chosen);
    let reserved = false;
    try {
      reserved = await reserve(target, directory);
    } catch (cause) {
      await unlink(record).catch(() => undefined);
      throw cause;
    }
    if (!reserved) {
      // The record is this call's own; the name belongs to someone else.
      await unlink(record).catch(() => undefined);
      continue;
    }
    try {
      await moved(move, absolute, target);
    } catch (cause) {
      await release(target, directory);
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
