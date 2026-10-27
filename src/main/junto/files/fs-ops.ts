import { constants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, cp, lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, extname, isAbsolute, join, sep } from "node:path";
import { randomBytes } from "node:crypto";
import {
  baseName,
  FILE_TEXT_MAX_BYTES,
  joinFilePath,
  parentOf,
  ROOT_PATH,
  sameStamp,
  type FileEntry,
  type FileImported,
  type FilePath,
  type FileRead,
  type FilesError,
  type FilesResult,
  type FileStamp,
} from "@shared/files";
import { fileMime } from "@shared/file-url";

/**
 * Filesystem work for one Files root. `root` is always the root's realpath,
 * found by the caller from the node. Every target resolves under it:
 *
 * - content (read, write, list, bytes, open, reveal): the whole path is
 *   `realpath`ed and must land inside the root, so a symlink out is refused;
 * - an entry itself (create, rename, move, trash): its folder is
 *   `realpath`ed and must land inside the root; the last segment is acted on
 *   as it is, so renaming or trashing a symlink touches only the link.
 *
 * Nothing here returns an absolute path: refusals are `FilesError` codes.
 */

export type Ok<A> = Extract<FilesResult<A>, { ok: true }>;
export type Refused = Extract<FilesResult<never>, { ok: false }>;

export const ok = <A>(value: A): Ok<A> => ({ ok: true, value });
export const refused = (error: FilesError): Refused => ({ ok: false, error });

/** The `FilesError` for a thrown filesystem error; the cause stays in main's log. */
export const errorOf = (cause: unknown): FilesError => {
  const code = (cause as { code?: unknown } | null)?.code;
  switch (code) {
    case "ENOENT":
      return "not-found";
    case "EEXIST":
    case "ENOTEMPTY":
      return "exists";
    case "ENOTDIR":
      return "not-dir";
    case "EISDIR":
      return "is-dir";
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return "denied";
    case "EINVAL":
      return "invalid-path";
    default:
      console.error("[files] filesystem call failed", typeof code === "string" ? code : cause);
      return "failed";
  }
};

const attempt = async <A>(work: () => Promise<FilesResult<A>>): Promise<FilesResult<A>> => {
  try {
    return await work();
  } catch (cause) {
    return refused(errorOf(cause));
  }
};

export const stampOf = (info: Stats): FileStamp => ({ mtimeMs: info.mtimeMs, size: info.size });

const inside = (root: string, real: string): boolean => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Where a call may reach: the root's realpath, and folders inside it that
 * stay refused (`denied`) however the root is drawn: Junto's own home, so the
 * editor never overwrites junto.db or a seat token, and nothing in it is
 * read into a comment or an extract. A root that holds the home (`~`) still opens.
 */
export type Scope = { readonly root: string; readonly deny: ReadonlyArray<string> };

const denied = (scope: Scope, absolute: string): boolean => scope.deny.some((dir) => inside(dir, absolute));

/** The realpath of the root, or `root-missing` when it is gone or not a folder. */
export const realRoot = async (root: string): Promise<FilesResult<string>> => {
  if (!isAbsolute(root)) return refused("root-missing");
  try {
    const real = await realpath(root);
    return (await stat(real)).isDirectory() ? ok(real) : refused("root-missing");
  } catch {
    return refused("root-missing");
  }
};

/** Content target: the realpath of `path`, refused when it leaves the root. */
export const resolveContent = async (scope: Scope, path: FilePath): Promise<FilesResult<string>> =>
  attempt(async () => {
    const real = await realpath(join(scope.root, path));
    if (!inside(scope.root, real)) return refused("outside-root");
    return denied(scope, real) ? refused("denied") : ok(real);
  });

/** Entry target: its folder's realpath inside the root, joined with its own name untouched. */
export const resolveEntry = async (scope: Scope, path: FilePath): Promise<FilesResult<string>> => {
  if (path === ROOT_PATH) return refused("invalid-path");
  const folder = await resolveContent(scope, parentOf(path));
  if (!folder.ok) return folder;
  const entry = join(folder.value, baseName(path));
  return denied(scope, entry) ? refused("denied") : ok(entry);
};

const exists = async (absolute: string): Promise<boolean> => {
  try {
    await lstat(absolute);
    return true;
  } catch (cause) {
    if ((cause as { code?: unknown }).code === "ENOENT") return false;
    throw cause;
  }
};

/** Shown in no tree: Git's own folder and Finder's litter. */
const HIDDEN_NAMES: ReadonlySet<string> = new Set([".git", ".DS_Store"]);

const byFolderThenName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export const listDir = (scope: Scope, dir: FilePath): Promise<FilesResult<ReadonlyArray<FileEntry>>> =>
  attempt(async () => {
    const real = await resolveContent(scope, dir);
    if (!real.ok) return real;
    const names = (await readdir(real.value)).filter((name) => !HIDDEN_NAMES.has(name));
    const entries: FileEntry[] = [];
    await Promise.all(
      names.map(async (name) => {
        const path = joinFilePath(dir, name);
        if (path === undefined) return;
        try {
          if (denied(scope, join(real.value, name))) return;
          const own = await lstat(join(real.value, name));
          let target = own;
          if (own.isSymbolicLink()) {
            // A symlink shows as what it points at. A broken one, or one out
            // of the root or into Junto's home, could only refuse: no row.
            const resolved = await realpath(join(real.value, name)).catch(() => undefined);
            if (resolved === undefined || !inside(scope.root, resolved) || denied(scope, resolved)) return;
            target = await stat(resolved);
          }
          entries.push({ path, dir: target.isDirectory(), stamp: stampOf(target) });
        } catch {
          // gone between readdir and lstat
        }
      }),
    );
    entries.sort((a, b) => (a.dir === b.dir ? byFolderThenName.compare(baseName(a.path), baseName(b.path)) : a.dir ? -1 : 1));
    return ok(entries);
  });

/** Bytes read to decide text or binary. */
const SNIFF_BYTES = 8192;

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export const readFileAt = (scope: Scope, path: FilePath): Promise<FilesResult<FileRead>> =>
  attempt(async () => {
    const real = await resolveContent(scope, path);
    if (!real.ok) return real;
    const handle = await open(real.value, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (info.isDirectory()) return refused("is-dir");
      // A FIFO or device would block or never end.
      if (!info.isFile()) return refused("denied");
      const stamp = stampOf(info);
      const head = Buffer.alloc(Math.min(SNIFF_BYTES, info.size));
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      const binary = (): Ok<FileRead> => ok({ kind: "binary", mime: fileMime(path), stamp });
      if (head.subarray(0, bytesRead).includes(0)) return binary();
      if (info.size > FILE_TEXT_MAX_BYTES) return ok({ kind: "too-large", size: info.size, stamp });
      const bytes = await handle.readFile();
      try {
        return ok({ kind: "text", text: decoder.decode(bytes), stamp });
      } catch {
        return binary();
      }
    } finally {
      await handle.close();
    }
  });

/**
 * Replace a text file, atomically: a sibling temp file renamed over it, with
 * the old file's mode. Refused `stale` when the file is no longer `base`.
 */
export const writeFileAt = (
  scope: Scope,
  path: FilePath,
  text: string,
  base: FileStamp,
): Promise<FilesResult<FileStamp>> =>
  attempt(async () => {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength > FILE_TEXT_MAX_BYTES) return refused("too-large");
    const real = await resolveContent(scope, path);
    if (!real.ok) return real;
    const before = await stat(real.value);
    if (before.isDirectory()) return refused("is-dir");
    if (!before.isFile()) return refused("denied");
    if (!sameStamp(stampOf(before), base)) return refused("stale");
    const temp = join(real.value, "..", `.${basename(real.value)}.junto-${randomBytes(6).toString("hex")}`);
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, before.mode & 0o7777);
    let written: FileStamp;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      // The stamp answered is this file's, taken before the swap (rename keeps
      // mtime): a writer landing right after cannot become this save's base.
      written = stampOf(await handle.stat());
    } finally {
      await handle.close();
    }
    try {
      await chmod(temp, before.mode & 0o7777);
      // Last look before the swap: a write that landed meanwhile wins.
      if (!sameStamp(stampOf(await stat(real.value)), base)) {
        await unlink(temp);
        return refused("stale");
      }
      await rename(temp, real.value);
    } catch (cause) {
      await unlink(temp).catch(() => undefined);
      throw cause;
    }
    return ok(written);
  });

export const createAt = (scope: Scope, path: FilePath, dir: boolean): Promise<FilesResult<FileEntry>> =>
  attempt(async () => {
    const target = await resolveEntry(scope, path);
    if (!target.ok) return target;
    if (dir) await mkdir(target.value);
    else await (await open(target.value, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644)).close();
    return ok({ path, dir, stamp: stampOf(await lstat(target.value)) });
  });

/**
 * Rename `from` to `to` without replacing anything at `to`. A case-only
 * rename on a case-insensitive disk finds itself at `to`, and is allowed.
 */
const renameNoReplace = async (from: string, to: string): Promise<FilesResult<null>> => {
  const source = await lstat(from);
  try {
    const there = await lstat(to);
    if (there.ino !== source.ino || there.dev !== source.dev) return refused("exists");
  } catch (cause) {
    if ((cause as { code?: unknown }).code !== "ENOENT") throw cause;
  }
  await rename(from, to);
  return ok(null);
};

export const renameAt = (scope: Scope, path: FilePath, name: string): Promise<FilesResult<FilePath>> =>
  attempt(async () => {
    const next = path === ROOT_PATH ? undefined : joinFilePath(parentOf(path), name);
    if (next === undefined) return refused("invalid-path");
    const from = await resolveEntry(scope, path);
    if (!from.ok) return from;
    const to = await resolveEntry(scope, next);
    if (!to.ok) return to;
    const moved = await renameNoReplace(from.value, to.value);
    return moved.ok ? ok(next) : moved;
  });

export const moveAt = (scope: Scope, path: FilePath, intoDir: FilePath): Promise<FilesResult<FilePath>> =>
  attempt(async () => {
    const next = path === ROOT_PATH ? undefined : joinFilePath(intoDir, baseName(path));
    if (next === undefined) return refused("invalid-path");
    // A folder into itself or below it.
    if (intoDir === path || intoDir.startsWith(`${path}/`)) return refused("invalid-path");
    const from = await resolveEntry(scope, path);
    if (!from.ok) return from;
    const into = await resolveContent(scope, intoDir);
    if (!into.ok) return into;
    if (!(await stat(into.value)).isDirectory()) return refused("not-dir");
    const moved = await renameNoReplace(from.value, join(into.value, baseName(path)));
    return moved.ok ? ok(next) : moved;
  });

/** Hand an entry to the system Trash (`shell.trashItem`); never unlink. */
export const trashAt = (
  scope: Scope,
  path: FilePath,
  trash: (absolute: string) => Promise<void>,
): Promise<FilesResult<null>> =>
  attempt(async () => {
    const target = await resolveEntry(scope, path);
    if (!target.ok) return target;
    await lstat(target.value);
    await trash(target.value);
    return ok(null);
  });

/** `name 2.ext`, `name 3.ext`, ...; a folder or a dotfile keeps its whole name as the stem. */
export const numberedName = (name: string, n: number, dir: boolean): string => {
  const extension = dir ? "" : extname(name);
  const stem = extension === "" || extension === name ? name : name.slice(0, -extension.length);
  return `${stem} ${String(n)}${extension === name ? "" : extension}`;
};

/** Copy dropped OS paths into `intoDir`. Sources are read, never changed; nothing at the root is overwritten. */
export const importInto = (
  scope: Scope,
  intoDir: FilePath,
  sources: ReadonlyArray<string>,
): Promise<FilesResult<ReadonlyArray<FileImported>>> =>
  attempt(async () => {
    const into = await resolveContent(scope, intoDir);
    if (!into.ok) return into;
    if (!(await stat(into.value)).isDirectory()) return refused("not-dir");
    const imported: FileImported[] = [];
    for (const dropped of sources) {
      // Copy what the drop names, from where it really is; nothing from Junto's home.
      const source = await realpath(dropped);
      if (denied(scope, source)) return refused("denied");
      const info = await lstat(source);
      const dir = info.isDirectory();
      if (!dir && !info.isFile() && !info.isSymbolicLink()) return refused("denied");
      const name = basename(dropped);
      let chosen = name;
      for (let n = 2; await exists(join(into.value, chosen)); n += 1) {
        if (n > 10_000) return refused("exists");
        chosen = numberedName(name, n, dir);
      }
      const path = joinFilePath(intoDir, chosen);
      if (path === undefined) return refused("invalid-path");
      await cp(source, join(into.value, chosen), {
        recursive: true,
        force: false,
        errorOnExist: true,
        // A link inside a dropped folder stays a link; reads through it are still refused outside the root.
        dereference: false,
        verbatimSymlinks: true,
        preserveTimestamps: true,
        // A dropped folder that holds Junto's home (`~`) copies without it.
        filter: (from) => !denied(scope, from),
      });
      imported.push({ path, dir });
    }
    return ok(imported);
  });

/**
 * Names the default app would run rather than open (a folder named `.app` is
 * a bundle and launches). Open in its default app refuses them, and any file
 * with an execute bit; Reveal in Finder still works.
 */
const LAUNCHABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".app", ".command", ".tool", ".terminal", ".workflow", ".action", ".pkg", ".mpkg",
  ".scpt", ".scptd", ".applescript", ".jar", ".sh", ".zsh", ".bash", ".csh", ".fish",
  ".webloc", ".inetloc", ".fileloc", ".url", ".prefpane", ".saver", ".kext", ".dmg",
  ".bundle", ".plugin", ".appex", ".xpc", ".mobileconfig", ".shortcut", ".service",
  ".qlgenerator", ".mdimporter", ".component", ".osax", ".wdgt", ".definition",
]);

/** The realpath of a file or folder (the root too) the default app may open, or why not. */
export const openableAt = (scope: Scope, path: FilePath): Promise<FilesResult<string>> =>
  attempt(async () => {
    const real = await resolveContent(scope, path);
    if (!real.ok) return real;
    if (LAUNCHABLE_EXTENSIONS.has(extname(real.value).toLowerCase())) return refused("denied");
    const info = await stat(real.value);
    if (info.isDirectory()) return ok(real.value);
    if (!info.isFile() || (info.mode & 0o111) !== 0) return refused("denied");
    return ok(real.value);
  });

/** Any entry under the root, folders and the root included, to show in Finder. */
export const revealableAt = (scope: Scope, path: FilePath): Promise<FilesResult<string>> =>
  resolveContent(scope, path);

/**
 * For the protocol: an open handle on a regular file under the root, and its
 * size. Bytes stream from this handle, so a symlink swapped in after the
 * check is never followed. The caller closes it.
 */
export const fileForBytes = (
  scope: Scope,
  path: FilePath,
): Promise<FilesResult<{ readonly handle: FileHandle; readonly size: number }>> =>
  attempt(async () => {
    const real = await resolveContent(scope, path);
    if (!real.ok) return real;
    const handle = await open(real.value, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (info.isDirectory()) throw Object.assign(new Error("is a directory"), { code: "EISDIR" });
      if (!info.isFile()) throw Object.assign(new Error("not a file"), { code: "EPERM" });
      return ok({ handle, size: info.size });
    } catch (cause) {
      await handle.close();
      throw cause;
    }
  });
