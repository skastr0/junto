import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Junto-specific home directory.
 *
 * Junto's state, control sockets, and internal caches live under this
 * directory (`<home>/.junto/...`). By default it is the OS user home, but the
 * `JUNTO_HOME` environment variable overrides it. This lets a dev build run
 * with an isolated `.junto` tree while leaving `HOME` (and therefore the shell
 * home seen by child terminals/tools) unchanged.
 *
 * Only Junto-owned paths should use this helper. External tool caches
 * (`~/.codex`, `~/.hermes`, `~/.claude.json`, etc.) and the shell's `~`
 * resolution intentionally stay on the real `HOME` for predictable behavior.
 *
 * Side-by-side with a production install: official `bun run dev` sets
 * `JUNTO_HOME=~/.junto-dev` and pins Electron `userData` under that tree so
 * the single-instance lock does not fight `/Applications/Junto.app`.
 */

let cachedJuntoHome: string | undefined;

export const usableJuntoHome = (
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

export const resolveJuntoHome = (): string => {
  if (cachedJuntoHome === undefined) {
    cachedJuntoHome =
      usableJuntoHome(process.env.JUNTO_HOME) ?? homedir();
  }
  return cachedJuntoHome;
};

/**
 * Electron userData for an unpackaged process with explicit `JUNTO_HOME`.
 * Lives under the isolated home so Chromium's singleton lock file is not
 * shared with the packaged production install's Application Support tree.
 */
export const unpackagedElectronUserDataPath = (juntoHome: string): string =>
  join(resolve(juntoHome), ".junto", "electron-user-data");

/**
 * Pin unpackaged Electron userData only when the operator opted into an
 * isolated `JUNTO_HOME` tree (official `bun run dev`). Never override
 * packaged installs or an explicit `--user-data-dir` (e2e / probes).
 *
 * Coupling to `JUNTO_HOME` is intentional: pinning userData alone without
 * state isolation would let a second process race the production DB.
 */
export const shouldPinUnpackagedElectronUserData = (input: {
  readonly packaged: boolean;
  readonly juntoHomeEnv: string | undefined;
  readonly hasUserDataDirSwitch: boolean;
}): boolean => {
  if (input.packaged) return false;
  if (input.hasUserDataDirSwitch) return false;
  return usableJuntoHome(input.juntoHomeEnv) !== undefined;
};

/** Test hook: clear the memoized Junto home. */
export const __resetJuntoHomeCache = (): void => {
  cachedJuntoHome = undefined;
};
