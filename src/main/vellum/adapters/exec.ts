import { homedir } from "node:os";
import { join } from "node:path";
import {
  appProcessPlane,
  type AppProcessLease,
} from "../app-process-plane";

// Shared shell-out helper for the read-only adapter plane. Every adapter
// call goes through here so the timeout, resolved environment, and buffer
// size are consistent, and so a failing CLI degrades to a result object
// instead of throwing — adapters decide how to fold that into a SnapshotBundle.

// Bulk queries over the tailnet (e.g. `hermes profiles --json` plus per-hint
// dashboard fan-out) routinely exceed 10s, so the default is generous.
// Callers with a tighter budget can override per call.
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 16 * 1024 * 1024;

// Login-shell PATH probe budget. A hung/misconfigured login shell must not
// stall the whole spawn plane — on timeout we fall back to the static merge,
// which alone resolves every reference CLI (proven under a hostile env).
const LOGIN_SHELL_TIMEOUT_MS = 4_000;
const ADAPTER_QUIESCING_ERROR = "adapter process plane is shutting down";

interface AdapterOperation {
  readonly process: AppProcessLease;
  settled: boolean;
  settleForShutdown: () => void;
}

const adapterOperations = new Set<AdapterOperation>();
let adapterProcessesQuiescing = false;
let adapterQuitDrain: Promise<AdapterQuitDrainResult> | undefined;

export interface CliResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly error?: string;
}

const LEADER_STREAM_DRAIN_GRACE_MS = 100;
const LEADERLESS_STREAM_ERROR =
  "adapter command leader exited while output streams remained open; adapter operation stopped waiting for stream closure";

const settleAdapterOperation = (operation: AdapterOperation): void => {
  if (operation.settled) return;
  operation.settled = true;
  adapterOperations.delete(operation);
};

const requestAdapterOperationTermination = (operation: AdapterOperation): void => {
  try {
    appProcessPlane.terminate(operation.process, "adapter operation quit");
  } catch {
    // The global process plane retains the lease for its authoritative drain.
  }
};

/**
 * Monotonically close the read-only adapter process plane during app quit.
 *
 * This receipt covers only adapter-domain operation settlement. It says
 * nothing about process-group or process-tree drainage; appProcessPlane owns
 * that OS truth and publishes it separately from drainOnQuit().
 */
export interface AdapterQuitDrainResult {
  readonly scope: "adapter-operations";
  readonly settled: boolean;
  readonly pending: number;
}

export const terminateAdapterChildrenOnQuit = (): Promise<AdapterQuitDrainResult> => {
  if (adapterQuitDrain) return adapterQuitDrain;
  adapterProcessesQuiescing = true;
  const flight = Promise.resolve().then((): AdapterQuitDrainResult => {
    for (const operation of [...adapterOperations]) {
      // Settle caller-facing work first. This receipt owns only domain state;
      // the central plane retains and drains the OS lease independently.
      operation.settleForShutdown();
      requestAdapterOperationTermination(operation);
    }
    const pending = adapterOperations.size;
    return {
      scope: "adapter-operations",
      settled: pending === 0,
      pending,
    };
  });
  // Publish the flight before any terminating callback can re-enter.
  adapterQuitDrain = flight;
  void flight.then(
    () => {
      if (adapterQuitDrain === flight) adapterQuitDrain = undefined;
    },
    () => {
      if (adapterQuitDrain === flight) adapterQuitDrain = undefined;
    },
  );
  return flight;
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

    let processLease: AppProcessLease;
    try {
      processLease = appProcessPlane.spawnGroup({
        source: "adapter.cli",
        purpose: "read-only adapter command",
        command,
        args,
        ...(options.env === undefined ? {} : { env: options.env }),
      });
      const operation: AdapterOperation = {
        process: processLease,
        settled: false,
        settleForShutdown: () => undefined,
      };
      // No await occurs between central admission and domain registration.
      adapterOperations.add(operation);
      return runRegisteredAdapterOperation(operation, options, resolve);
    } catch (error) {
      resolve({
        ok: false,
        stdout: "",
        error: error instanceof Error ? error.message : "adapter command spawn failed",
      });
      return;
    }

    // appProcessPlane registers before this point; late-spawn is closed.
  });
};

const runRegisteredAdapterOperation = (
  operation: AdapterOperation,
  options: { readonly timeoutMs: number; readonly maxBuffer: number },
  resolve: (result: CliResult) => void,
): void => {
    const io = operation.process.io;
    io.stdin.end();
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let resultSettled = false;
    let closeObserved = false;
    let leaderExited = false;
    let timedOut = false;
    let bufferExceeded = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let leaderExitTimer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribeError = (): void => undefined;
    let unsubscribeExit = (): void => undefined;
    let unsubscribeClose = (): void => undefined;

    const clearTimers = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (leaderExitTimer !== undefined) {
        clearTimeout(leaderExitTimer);
        leaderExitTimer = undefined;
      }
    };

    const detachObservers = (): void => {
      unsubscribeError();
      unsubscribeExit();
      unsubscribeClose();
      unsubscribeError = () => undefined;
      unsubscribeExit = () => undefined;
      unsubscribeClose = () => undefined;
    };

    const ignoreStreamError = (): void => undefined;

    const detachStreams = (): void => {
      io.stdout.off("data", onStdoutData);
      io.stderr.off("data", onStderrData);
      io.stdout.on("error", ignoreStreamError);
      io.stderr.on("error", ignoreStreamError);
      io.stdin.destroy();
      io.stdout.destroy();
      io.stderr.destroy();
    };

    const settleResult = (result: CliResult): void => {
      if (resultSettled) return;
      resultSettled = true;
      clearTimers();
      detachObservers();
      settleAdapterOperation(operation);
      detachStreams();
      resolve(result);
    };

    const abandonLeaderlessGroup = (): void => {
      settleResult({ ok: false, stdout, error: LEADERLESS_STREAM_ERROR });
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
      try {
        appProcessPlane.forceTerminate(
          operation.process,
          "adapter command output limit",
        );
      } catch {
        // The lease remains registered for the global process drain.
      }
      settleResult({ ok: false, stdout, error: "adapter command exceeded the output limit" });
    };

    const onStdoutData = (chunk: unknown): void => append("stdout", chunk);
    const onStderrData = (chunk: unknown): void => append("stderr", chunk);

    operation.settleForShutdown = () => {
      settleResult({
        ok: false,
        stdout,
        error: ADAPTER_QUIESCING_ERROR,
      });
    };

    timer = setTimeout(() => {
      timedOut = true;
      try {
        appProcessPlane.forceTerminate(operation.process, "adapter command timeout");
      } catch {
        // The lease remains registered for the global process drain.
      }
      settleResult({
        ok: false,
        stdout,
        error: `adapter command timed out after ${options.timeoutMs}ms`,
      });
    }, options.timeoutMs);
    timer.unref?.();

    io.stdout.setEncoding("utf8");
    io.stderr.setEncoding("utf8");
    io.stdout.on("data", onStdoutData);
    io.stderr.on("data", onStderrData);

    unsubscribeError = io.onError((error) => {
      if (closeObserved || leaderExited || resultSettled) return;
      try {
        appProcessPlane.terminate(operation.process, "adapter command process error");
      } catch {
        // The global process plane remains responsible for any live lease.
      }
      settleResult({ ok: false, stdout, error: error.message });
    });

    unsubscribeExit = io.onExit(() => {
      if (closeObserved || resultSettled) return;
      leaderExited = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      // A normal leader drains its pipes and reaches `close` first. If an
      // inherited pipe stays open, bound only the caller-facing stream wait.
      leaderExitTimer = setTimeout(() => {
        abandonLeaderlessGroup();
      }, LEADER_STREAM_DRAIN_GRACE_MS);
      leaderExitTimer.unref?.();
    });

    unsubscribeClose = io.onClose(({ code, signal }) => {
      if (resultSettled) return;
      closeObserved = true;
      if (code === 0 && signal === null && !timedOut && !bufferExceeded) {
        settleResult({ ok: true, stdout });
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
      // Keep stdout on failure: JSON-emitting CLI adapters often exit
      // non-zero when a single item errors while still emitting a useful
      // payload on stdout. Callers decide whether to recover from it.
      settleResult({ ok: false, stdout, error });
    });
};

// Well-known install roots, in priority order. This is the guaranteed floor:
// under a packaged/launchd/Finder launch the process inherits launchd's
// minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) and does NOT source the user's
// shell rc, so bare CLI names (hermes/codex/bun) would
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
