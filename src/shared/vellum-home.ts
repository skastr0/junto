import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/**
 * Vellum Command-specific home directory.
 *
 * Vellum Command's state, control sockets, and internal caches live under this
 * directory (`<home>/.vellum/...`). By default it is the OS user home, but the
 * `VELLUM_HOME` environment variable overrides it. This lets a dev build run
 * with an isolated `.vellum` tree while leaving `HOME` (and therefore the shell
 * home seen by child terminals/tools) unchanged.
 *
 * Only Vellum Command-owned paths should use this helper. External tool caches
 * (`~/.codex`, `~/.hermes`, `~/.claude.json`, etc.) and the shell's `~`
 * resolution intentionally stay on the real `HOME` for predictable behavior.
 */

let cachedVellumHome: string | undefined;

const usableVellumHome = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > 4_096) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  if (!isAbsolute(trimmed)) return undefined;
  return resolve(trimmed);
};

export const resolveVellumHome = (): string => {
  if (cachedVellumHome === undefined) {
    cachedVellumHome =
      usableVellumHome(process.env.VELLUM_HOME) ?? homedir();
  }
  return cachedVellumHome;
};

/** Test hook: clear the memoized Vellum Command home. */
export const __resetVellumHomeCache = (): void => {
  cachedVellumHome = undefined;
};
