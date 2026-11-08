/**
 * JUNTO_PERF — the one runtime switch for renderer performance telemetry.
 *
 * The renderer window runs sandboxed (`contextIsolation: true`,
 * `nodeIntegration: false`, `sandbox: true`), so it cannot read the main
 * process environment: exporting `JUNTO_PERF=1` before launching the app
 * does not, on its own, reach this side. The flag is therefore resolved from
 * every source a sandboxed renderer can actually see, and the durable one for
 * a packaged build is localStorage:
 *
 *     localStorage.setItem("JUNTO_PERF", "1")   // then reload the window
 *
 * Resolution order (first hit wins):
 *   1. `globalThis.JUNTO_PERF`   — harness injection (Playwright
 *      `addInitScript`, a devtools one-liner, an e2e preamble)
 *   2. `?JUNTO_PERF=1` / `#JUNTO_PERF=1` on the renderer URL — dev server
 *      and the e2e static renderer server
 *   3. `localStorage["JUNTO_PERF"]` — survives restarts; the packaged path
 *   4. `process.env.JUNTO_PERF` — Node-visible contexts only (unit tests, or
 *      a future preload bridge that forwards the variable)
 *
 * Resolved exactly once at module load. Every call site reads a constant, so
 * an always-off build never touches storage on a render path.
 */

const TRUTHY = new Set(["1", "on", "true", "yes", "y"]);

const readable = (value: unknown): boolean => {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return TRUTHY.has(value.trim().toLowerCase());
};

/** Injected switch: an e2e init script or a devtools assignment. */
const fromGlobal = (): boolean | undefined => {
  const injected = (globalThis as { JUNTO_PERF?: unknown }).JUNTO_PERF;
  return injected === undefined ? undefined : readable(injected);
};

/** URL switch: `?JUNTO_PERF=1` or `#JUNTO_PERF=1`. */
const fromLocation = (): boolean | undefined => {
  try {
    const href = globalThis.location?.href;
    if (!href) return undefined;
    const url = new URL(href);
    const search = url.searchParams.get("JUNTO_PERF");
    if (search !== null) return readable(search);
    const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    if (!hash) return undefined;
    const hashed = new URLSearchParams(hash).get("JUNTO_PERF");
    return hashed === null ? undefined : readable(hashed);
  } catch {
    return undefined;
  }
};

/** Durable switch: the only one that survives an app restart. */
const fromStorage = (): boolean | undefined => {
  try {
    const stored = globalThis.localStorage?.getItem("JUNTO_PERF");
    return stored === null || stored === undefined ? undefined : readable(stored);
  } catch {
    // Storage can be denied (opaque origin, disabled cookies). Never throw
    // from a boot-path flag read.
    return undefined;
  }
};

/** Environment switch: unit tests and any Node-side renderer host. */
const fromEnv = (): boolean | undefined => {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env;
    const value = env?.JUNTO_PERF;
    return value === undefined ? undefined : readable(value);
  } catch {
    return undefined;
  }
};

/** Live resolution — exported for tests; production reads the frozen constant. */
export const resolvePerfFlag = (): boolean =>
  fromGlobal() ?? fromLocation() ?? fromStorage() ?? fromEnv() ?? false;

/**
 * Frozen at module load. `true` means telemetry is armed for this window;
 * `false` means every performance call site stays the no-op it is by default.
 */
export const PERF_ENABLED: boolean = resolvePerfFlag();
