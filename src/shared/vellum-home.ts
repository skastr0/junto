import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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
 *
 * Side-by-side with a production install: official `bun run dev` sets
 * `VELLUM_HOME=~/.vellum-dev` and pins Electron `userData` under that tree so
 * the single-instance lock does not fight `/Applications/Vellum Command.app`.
 */

let cachedVellumHome: string | undefined;

export const usableVellumHome = (
  value: string | undefined,
): string | undefined => {
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

/**
 * Electron userData for an unpackaged process with explicit `VELLUM_HOME`.
 * Lives under the isolated home so Chromium's singleton lock file is not
 * shared with the packaged production install's Application Support tree.
 */
export const unpackagedElectronUserDataPath = (vellumHome: string): string =>
  join(resolve(vellumHome), ".vellum", "electron-user-data");

/**
 * Pin unpackaged Electron userData only when the operator opted into an
 * isolated `VELLUM_HOME` tree (official `bun run dev`). Never override
 * packaged installs or an explicit `--user-data-dir` (e2e / probes).
 *
 * Coupling to `VELLUM_HOME` is intentional: pinning userData alone without
 * state isolation would let a second process race the production DB.
 */
export const shouldPinUnpackagedElectronUserData = (input: {
  readonly packaged: boolean;
  readonly vellumHomeEnv: string | undefined;
  readonly hasUserDataDirSwitch: boolean;
}): boolean => {
  if (input.packaged) return false;
  if (input.hasUserDataDirSwitch) return false;
  return usableVellumHome(input.vellumHomeEnv) !== undefined;
};

/** Test hook: clear the memoized Vellum Command home. */
export const __resetVellumHomeCache = (): void => {
  cachedVellumHome = undefined;
};
