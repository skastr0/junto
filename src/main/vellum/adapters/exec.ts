import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

// Shared shell-out helper for the read-only adapter plane. Every adapter
// call goes through here so the timeout, resolved environment, and buffer
// size are consistent, and so a failing CLI degrades to a result object
// instead of throwing — adapters decide how to fold that into a SnapshotBundle.

// Bulk queries over the tailnet (e.g. `tower projects --json` plus per-hint
// dashboard fan-out) routinely exceed 10s, so the default is generous.
// Callers with a tighter budget can override per call.
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 16 * 1024 * 1024;

// Login-shell PATH probe budget. A hung/misconfigured login shell must not
// stall the whole spawn plane — on timeout we fall back to the static merge,
// which alone resolves every reference CLI (proven under a hostile env).
const LOGIN_SHELL_TIMEOUT_MS = 4_000;
const ADAPTER_QUIESCING_ERROR = "adapter process plane is shutting down";

interface OwnedAdapterChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly processGroupId?: number;
}

const ownedAdapterChildren = new Set<OwnedAdapterChild>();
let adapterProcessesQuiescing = false;

export interface CliResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly error?: string;
}

const signalOwnedAdapterChild = (
  owned: OwnedAdapterChild,
  signal: NodeJS.Signals,
): void => {
  if (owned.processGroupId !== undefined) {
    try {
      process.kill(-owned.processGroupId, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      // Fall back to the direct child if group signalling is unavailable.
    }
  }

  if (owned.child.exitCode !== null || owned.child.signalCode !== null) return;
  try {
    owned.child.kill(signal);
  } catch {
    // The owned child may have exited between the liveness check and signal.
  }
};

/**
 * Monotonically close the read-only adapter process plane during app quit.
 *
 * Each adapter command owns a distinct POSIX process group, so signalling it
 * cannot touch the intentionally persistent Herdr server/session plane. The
 * registry stores child handles and group ids only — never argv, which may
 * contain user prompt material for Hermes calls.
 */
export const terminateAdapterChildrenOnQuit = (): void => {
  if (adapterProcessesQuiescing) return;
  adapterProcessesQuiescing = true;
  for (const owned of ownedAdapterChildren) {
    signalOwnedAdapterChild(owned, "SIGTERM");
  }
};

const runOwnedFile = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly timeoutMs: number;
    readonly maxBuffer: number;
    readonly env?: NodeJS.ProcessEnv;
  },
): Promise<CliResult> => {
  if (adapterProcessesQuiescing) {
    return Promise.resolve({ ok: false, stdout: "", error: ADAPTER_QUIESCING_ERROR });
  }

  return new Promise((resolve) => {
    // No await occurs between this final gate and registration, closing the
    // late-spawn race with terminateAdapterChildrenOnQuit().
    if (adapterProcessesQuiescing) {
      resolve({ ok: false, stdout: "", error: ADAPTER_QUIESCING_ERROR });
      return;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, [...args], {
        detached: process.platform !== "win32",
        ...(options.env === undefined ? {} : { env: options.env }),
      });
    } catch (error) {
      resolve({
        ok: false,
        stdout: "",
        error: error instanceof Error ? error.message : "adapter command spawn failed",
      });
      return;
    }

    child.stdin.end();
    const owned: OwnedAdapterChild = {
      child,
      ...(process.platform !== "win32" && child.pid !== undefined
        ? { processGroupId: child.pid }
        : {}),
    };
    ownedAdapterChildren.add(owned);

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let bufferExceeded = false;

    const timer = setTimeout(() => {
      timedOut = true;
      signalOwnedAdapterChild(owned, "SIGKILL");
    }, options.timeoutMs);
    timer.unref?.();

    const settle = (result: CliResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A one-shot adapter command never owns a persistent descendant. Reap
      // anything that outlived its group leader before forgetting the group.
      signalOwnedAdapterChild(owned, "SIGTERM");
      ownedAdapterChildren.delete(owned);
      resolve(result);
    };

    const append = (target: "stdout" | "stderr", chunk: unknown): void => {
      if (bufferExceeded) return;
      const text = String(chunk);
      const bytes = Buffer.byteLength(text);
      if (target === "stdout") {
        stdoutBytes += bytes;
        if (stdoutBytes <= options.maxBuffer) stdout += text;
      } else {
        stderrBytes += bytes;
        if (stderrBytes <= options.maxBuffer) stderr += text;
      }
      if (stdoutBytes <= options.maxBuffer && stderrBytes <= options.maxBuffer) return;
      bufferExceeded = true;
      signalOwnedAdapterChild(owned, "SIGKILL");
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: unknown) => append("stdout", chunk));
    child.stderr.on("data", (chunk: unknown) => append("stderr", chunk));
    child.once("error", (error) => {
      settle({ ok: false, stdout: "", error: error.message });
    });
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null && !timedOut && !bufferExceeded) {
        settle({ ok: true, stdout });
        return;
      }
      const error = stderr.trim() ||
        (timedOut
          ? `adapter command timed out after ${options.timeoutMs}ms`
          : bufferExceeded
            ? "adapter command exceeded the output limit"
            : signal !== null
              ? `adapter command terminated by ${signal}`
              : `adapter command exited with code ${String(code)}`);
      settle({ ok: false, stdout: "", error });
    });
  });
};

// Well-known install roots, in priority order. This is the guaranteed floor:
// under a packaged/launchd/Finder launch the process inherits launchd's
// minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) and does NOT source the user's
// shell rc, so bare CLI names (tower/quasar/booth/hermes/codex/bun) would
// ENOENT. These dirs — ~/.local/bin + the mise shims dir chiefly — resolve all
// of them without any login shell, so even a broken login shell still works.
export const staticPathDirs = (home: string): ReadonlyArray<string> => [
  join(home, ".local", "bin"),
  join(home, ".local", "share", "mise", "shims"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

// Pure PATH-merge — extracted so the ordering/dedup contract is unit-testable
// without spawning a shell. Precedence: the user's real login-shell PATH first
// (it reflects their actual toolchain, mise/asdf/homebrew ordering included),
// then whatever PATH the process already inherited, then the static floor as a
// guaranteed fallback. First occurrence of each dir wins; empties are dropped.
export const mergePath = (inputs: {
  readonly loginShellPath?: string;
  readonly currentPath?: string;
  readonly home: string;
}): string => {
  const segments: string[] = [];
  const pushAll = (value: string | undefined) => {
    if (!value) return;
    for (const part of value.split(":")) {
      const dir = part.trim();
      if (dir) segments.push(dir);
    }
  };

  pushAll(inputs.loginShellPath);
  pushAll(inputs.currentPath);
  for (const dir of staticPathDirs(inputs.home)) segments.push(dir);

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const dir of segments) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    merged.push(dir);
  }
  return merged.join(":");
};

// Ask the user's login shell for its resolved PATH. Resolves to `undefined`
// (never rejects) on any failure — a broken shell degrades to the static
// merge rather than taking down the spawn plane.
const queryLoginShellPath = (): Promise<string | undefined> =>
  new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh";
    void runOwnedFile(shell, ["-lc", "echo $PATH"], {
      timeoutMs: LOGIN_SHELL_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    }).then((result) => {
      const line = result.ok ? result.stdout.trim() : "";
      resolve(line || undefined);
    });
  });

let resolvedEnvPromise: Promise<NodeJS.ProcessEnv> | undefined;
let resolvedEnvCache: NodeJS.ProcessEnv | undefined;

// The one resolved environment every spawn call-site should use. Built ONCE
// (memoized) at first use: probe the login shell, merge with the static floor,
// and hand back an env object suitable for child_process { env } options.
//
// Chat/agent spawn (chat/spawn.ts, wired by a later change), the codex/prism
// service spawns, and runCli below all route through here so that a
// packaged/launchd launch resolves user-installed CLIs identically to a
// dev-from-terminal launch.
//
// SINGLE documented mutation of the app's own environment: we assign the
// resolved PATH back onto process.env.PATH. This is deliberate and the cleanest
// single point — any spawn that still inherits process.env verbatim (e.g. the
// services/process.ts helper) picks up the resolved PATH for free, and the
// assignment is idempotent. No other key of process.env is touched.
export const resolvedSpawnEnv = (): Promise<NodeJS.ProcessEnv> => {
  if (resolvedEnvPromise) return resolvedEnvPromise;
  resolvedEnvPromise = queryLoginShellPath().then((loginShellPath) => {
    const mergedPath = mergePath({
      loginShellPath,
      currentPath: process.env.PATH,
      home: homedir(),
    });
    process.env.PATH = mergedPath;
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: mergedPath };
    resolvedEnvCache = env;
    return env;
  });
  return resolvedEnvPromise;
};

// Synchronous accessor for call-sites that cannot await (e.g. inside a spawn
// options literal). Returns the memoized env once resolvedSpawnEnv() has
// settled; before that, a best-effort static merge (no login-shell round-trip)
// so a synchronous caller still gets the guaranteed floor and never ships the
// bare minimal PATH.
export const resolvedSpawnEnvSync = (): NodeJS.ProcessEnv => {
  if (resolvedEnvCache) return resolvedEnvCache;
  const mergedPath = mergePath({ currentPath: process.env.PATH, home: homedir() });
  return { ...process.env, PATH: mergedPath };
};

export const runCli = async (
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs: number = TIMEOUT_MS,
): Promise<CliResult> => {
  // Env resolution must never take down the read-only adapter plane. In the
  // pathological case it rejects, fall back to the sync static merge so the
  // call still degrades to an {ok:false} result on ENOENT rather than throwing.
  const env = await resolvedSpawnEnv().catch(() => resolvedSpawnEnvSync());
  if (adapterProcessesQuiescing) {
    return { ok: false, stdout: "", error: ADAPTER_QUIESCING_ERROR };
  }
  return runOwnedFile(command, args, { timeoutMs, env, maxBuffer: MAX_BUFFER });
};

export const parseJson = <T>(text: string): T | undefined => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
};
