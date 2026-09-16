import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Junto-specific home directory.
 *
 * Junto's state, control sockets, and internal caches live under this
 * directory (`<home>/.vellum-command/...`). By default it is the OS user home, but the
 * `VELLUM_COMMAND_HOME` environment variable overrides it. This lets a dev build run
 * with an isolated `.vellum-command` tree while leaving `HOME` (and therefore the shell
 * home seen by child terminals/tools) unchanged.
 *
 * Only Junto-owned paths should use this helper. External tool caches
 * (`~/.codex`, `~/.hermes`, `~/.claude.json`, etc.) and the shell's `~`
 * resolution intentionally stay on the real `HOME` for predictable behavior.
 *
 * Side-by-side with a production install: official `bun run dev` sets
 * `VELLUM_COMMAND_HOME=~/.vellum-command-dev` and pins Electron `userData` under that tree so
 * the single-instance lock does not fight `/Applications/Junto.app`.
 */

let cachedVellumCommandHome: string | undefined;

export const usableVellumCommandHome = (
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

export const resolveVellumCommandHome = (): string => {
  if (cachedVellumCommandHome === undefined) {
    cachedVellumCommandHome =
      usableVellumCommandHome(process.env.VELLUM_COMMAND_HOME) ?? homedir();
  }
  return cachedVellumCommandHome;
};

/**
 * Electron userData for an unpackaged process with explicit `VELLUM_COMMAND_HOME`.
 * Lives under the isolated home so Chromium's singleton lock file is not
 * shared with the packaged production install's Application Support tree.
 */
export const unpackagedElectronUserDataPath = (vellumHome: string): string =>
  join(resolve(vellumHome), ".vellum-command", "electron-user-data");

/**
 * Pin unpackaged Electron userData only when the operator opted into an
 * isolated `VELLUM_COMMAND_HOME` tree (official `bun run dev`). Never override
 * packaged installs or an explicit `--user-data-dir` (e2e / probes).
 *
 * Coupling to `VELLUM_COMMAND_HOME` is intentional: pinning userData alone without
 * state isolation would let a second process race the production DB.
 */
export const shouldPinUnpackagedElectronUserData = (input: {
  readonly packaged: boolean;
  readonly vellumHomeEnv: string | undefined;
  readonly hasUserDataDirSwitch: boolean;
}): boolean => {
  if (input.packaged) return false;
  if (input.hasUserDataDirSwitch) return false;
  return usableVellumCommandHome(input.vellumHomeEnv) !== undefined;
};

/** Test hook: clear the memoized Junto home. */
export const __resetVellumCommandHomeCache = (): void => {
  cachedVellumCommandHome = undefined;
};
