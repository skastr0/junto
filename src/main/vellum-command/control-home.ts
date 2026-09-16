/**
 * Control-plane home root resolution.
 *
 * Electron's `app.getPath("home")` ignores a sandboxed `HOME` env. E2E sets
 * `HOME` + `JUNTO_E2E=1` + `--user-data-dir`; writing browser/term control
 * sockets under the real operator home fights live listeners and rotates the
 * operator token. Work control already prefers `JUNTO_WORK_HOME` /
 * `os.homedir()` (which honors `HOME`); this helper keeps browser + term on
 * the same isolation contract.
 *
 * Precedence (first match wins):
 * 1. `explicitHome` — absolute override (tests / `JUNTO_BROWSER_HOME`)
 * 2. Absolute `envHome` (`process.env.HOME`) — matches `os.homedir()` and the
 *    E2E harness (`sandboxControlSocketPath(sandbox.homeDir)`)
 * 3. Headless + unpackaged → `userData` (probes that only set `--user-data-dir`)
 * 4. `e2e` → `userData` (fail-closed when HOME was not sandboxed)
 * 5. `electronHome` — production default (`app.getPath("home")`)
 *
 * Never returns `electronHome` when `e2e` is true without a usable sandboxed
 * HOME, and never invents ambient grants — only chooses the directory root
 * under which control sockets/tokens live.
 */
import { isAbsolute, resolve } from "node:path";

export interface ResolveControlHomeInput {
  /** `process.env.HOME` — may be sandboxed by E2E / probes. */
  readonly envHome?: string | undefined;
  /** `app.getPath("home")` — Electron path that ignores sandboxed HOME. */
  readonly electronHome: string;
  /** `app.getPath("userData")` — sandboxed via `--user-data-dir`. */
  readonly userData: string;
  /** `process.env.JUNTO_E2E === "1"`. */
  readonly e2e?: boolean;
  /** `--vellum-headless` present on argv. */
  readonly headless?: boolean;
  /** `app.isPackaged`. */
  readonly packaged?: boolean;
  /**
   * Highest-priority absolute override (e.g. `JUNTO_BROWSER_HOME` for the
   * browser plane, or a test fixture root).
   */
  readonly explicitHome?: string | undefined;
}

/** Absolute, bounded home path — rejects empty, relative, or control-char input. */
export const usableControlHome = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > 4_096) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  if (!isAbsolute(trimmed)) return undefined;
  return resolve(trimmed);
};

export const resolveControlHome = (input: ResolveControlHomeInput): string => {
  const explicit = usableControlHome(input.explicitHome);
  if (explicit !== undefined) return explicit;

  const envHome = usableControlHome(input.envHome);
  if (envHome !== undefined) return envHome;

  if (input.headless === true && input.packaged !== true) {
    return resolve(input.userData);
  }

  if (input.e2e === true) {
    return resolve(input.userData);
  }

  return resolve(input.electronHome);
};
