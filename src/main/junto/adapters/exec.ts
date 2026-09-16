import { homedir } from "node:os";
import { join } from "node:path";
import { ACCESS_CANCELLED_ERROR } from "../access-signal";
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
    readonly signal?: AbortSignal;
  },
): Promise<CliResult> => {
  if (options.signal?.aborted) {
    return Promise.resolve({ ok: false, stdout: "", error: ACCESS_CANCELLED_ERROR });
  }
  if (adapterProcessesQuiescing) {
    return Promise.resolve({ ok: false, stdout: "", error: ADAPTER_QUIESCING_ERROR });
  }

  return new Promise((resolve) => {
    // No await occurs between this final gate and registration, closing the
    // late-spawn race with terminateAdapterChildrenOnQuit().
    if (options.signal?.aborted) {
      resolve({ ok: false, stdout: "", error: ACCESS_CANCELLED_ERROR });
      return;
    }
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
      return runRegisteredAdapterOperation(
        operation,
        {
          timeoutMs: options.timeoutMs,
          maxBuffer: options.maxBuffer,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        resolve,
      );
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
  options: {
    readonly timeoutMs: number;
    readonly maxBuffer: number;
    readonly signal?: AbortSignal;
  },
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

    let abortOperation = (): void => undefined;

    const settleResult = (result: CliResult): void => {
      if (resultSettled) return;
      resultSettled = true;
      options.signal?.removeEventListener("abort", abortOperation);
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

    abortOperation = (): void => {
      try {
        appProcessPlane.terminate(operation.process, "provider access cancelled");
      } catch {
        // The global process plane retains the lease for its authoritative drain.
      }
      settleResult({
        ok: false,
        stdout,
        error: ACCESS_CANCELLED_ERROR,
      });
    };

    if (options.signal?.aborted) {
      abortOperation();
      return;
    }
    options.signal?.addEventListener("abort", abortOperation, { once: true });

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
// minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin). Bare CLI names
// (hermes/codex/bun) would ENOENT, so these dirs resolve the common roots even
// when the login-shell PATH capture below cannot run. Real binary dirs rank
// ahead of shim dirs: a mise shim only works inside an activated context, so
// a genuine binary must win whenever both exist.
export const staticPathDirs = (home: string): ReadonlyArray<string> => [
  join(home, ".local", "bin"),
  join(home, ".kimi-code", "bin"),
  join(home, ".bun", "bin"),
  join(home, ".local", "share", "mise", "shims"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

// ── Login-shell PATH capture ────────────────────────────────────────────────
//
// The authoritative answer to "what does `codex` mean on this machine" lives
// in the operator's shell startup files, not in any directory list we can
// hardcode. A packaged launch cannot see ~/.bun/bin, nvm, volta, or mise
// hook-env dirs until the user's own shell reports them. So once per app run
// we ask the login shell for its environment — the same approach every app
// that spawns user CLIs uses — bounded by a timeout and fail-open: any probe
// failure just falls back to the static floor.
//
// This is the ONLY sanctioned execution of shell startup files in the spawn
// plane, and it is used strictly for PATH discovery — never as a permission
// probe and never on a per-spawn hot path.

const LOGIN_SHELL_PROBE_TIMEOUT_MS = 10_000;
const LOGIN_SHELL_PROBE_MAX_OUTPUT_BYTES = 1024 * 1024;
const LOGIN_ENV_BEGIN = "JUNTO_ENV_BEGIN";
const LOGIN_ENV_END = "JUNTO_ENV_END";

const loginProbeShell = (): string | undefined => {
  const fromEnv = process.env.SHELL?.trim();
  if (fromEnv) return fromEnv;
  if (process.platform === "win32") return undefined;
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
};

/**
 * Extract PATH from the `env` dump between the probe sentinels. Shell rc
 * output (motd, prompts, hook noise) lands outside the sentinels and is
 * discarded; a missing sentinel or PATH line yields undefined.
 */
export const loginShellPathFromProbeOutput = (
  output: string,
): string | undefined => {
  const begin = output.indexOf(LOGIN_ENV_BEGIN);
  if (begin < 0) return undefined;
  const bodyStart = begin + LOGIN_ENV_BEGIN.length;
  const end = output.indexOf(LOGIN_ENV_END, bodyStart);
  if (end < 0) return undefined;
  const body = output.slice(bodyStart, end);
  for (const line of body.split(/\r?\n/u)) {
    if (!line.startsWith("PATH=")) continue;
    const value = line.slice("PATH=".length).trim();
    if (value.length > 0) return value;
  }
  return undefined;
};

/**
 * Run the operator's default shell as login+interactive once and read its
 * PATH. `-l` sources login files (.zprofile/.zlogin/.profile), `-i` sources
 * interactive rc (.zshrc/.bashrc) where PATH exports and version-manager
 * activation (mise/nvm/volta) actually live.
 *
 * Never throws, never blocks longer than the timeout, and never feeds stdin —
 * rc files that prompt simply die with the probe.
 */
const captureLoginShellPath = (): Promise<string | undefined> =>
  new Promise((resolve) => {
    const shell = loginProbeShell();
    if (shell === undefined) {
      resolve(undefined);
      return;
    }
    // The probe is an owned child like every other spawn: admission, group
    // tracking, and quit drainage stay with the central plane.
    let lease: AppProcessLease;
    try {
      lease = appProcessPlane.spawnGroup({
        source: "adapter.login-shell-probe",
        purpose: "operator login-shell PATH discovery",
        command: shell,
        args: [
          "-l",
          "-i",
          "-c",
          // The markers are split mid-token so a tracing rc (set -x/verbose)
          // echoing this command cannot forge a sentinel and corrupt the parse.
          `echo JUNTO_ENV_""BEGIN; env; echo JUNTO_ENV_""END`,
        ],
        env: { ...process.env, TERM: "dumb" },
      });
    } catch {
      resolve(undefined);
      return;
    }
    const io = lease.io;
    io.stdin.end();
    let output = "";
    let settled = false;
    const finish = (path: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(path);
    };
    const kill = (): void => {
      try {
        appProcessPlane.forceTerminate(lease, "login shell PATH probe bound");
      } catch {
        // The central plane retains the lease for its authoritative drain.
      }
    };
    const timer = setTimeout(() => {
      kill();
      finish(undefined);
    }, LOGIN_SHELL_PROBE_TIMEOUT_MS);
    timer.unref?.();
    io.onError(() => finish(undefined));
    io.stdout.setEncoding("utf8");
    io.stdout.on("data", (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > LOGIN_SHELL_PROBE_MAX_OUTPUT_BYTES) {
        kill();
      }
    });
    // Plane children always pipe stderr; drain and discard rc noise so a
    // chatty startup file cannot fill the pipe and stall the probe.
    io.stderr.on("data", () => undefined);
    io.onClose(() => finish(loginShellPathFromProbeOutput(output)));
  });

// Pure PATH merge, extracted so the ordering/dedup contract is unit-testable.
// Precedence: the operator's login-shell PATH, then the environment Electron
// inherited, then operator tool dirs, then the static floor. First occurrence
// of each directory wins; empty entries are dropped.
export const mergePath = (inputs: {
  readonly loginShellPath?: string;
  readonly currentPath?: string;
  readonly home: string;
  readonly extraDirs?: ReadonlyArray<string>;
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
  for (const dir of inputs.extraDirs ?? []) {
    const trimmed = dir.trim();
    if (trimmed) segments.push(trimmed);
  }
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

let extraPathDirs: ReadonlyArray<string> = [];
let inheritedPath: string | undefined;
let loginShellPath: string | undefined;
let resolvedEnvPromise: Promise<NodeJS.ProcessEnv> | undefined;
let resolvedEnvCache: NodeJS.ProcessEnv | undefined;

const spawnPath = (): string =>
  mergePath({
    loginShellPath,
    currentPath: inheritedPath ?? process.env.PATH,
    home: homedir(),
    extraDirs: extraPathDirs,
  });

/** Operator-configured tool directories. Detection and launch both read this. */
export const configuredToolDirectories = (): ReadonlyArray<string> => extraPathDirs;

export const setConfiguredToolDirectories = (
  directories: ReadonlyArray<string>,
): void => {
  extraPathDirs = directories;
  if (resolvedEnvCache === undefined && resolvedEnvPromise === undefined) return;
  const mergedPath = spawnPath();
  process.env.PATH = mergedPath;
  resolvedEnvCache = { ...process.env, PATH: mergedPath };
  resolvedEnvPromise = Promise.resolve(resolvedEnvCache);
};

// The one resolved environment every spawn call-site should use. Built once
// from the operator's login-shell PATH (the authoritative user PATH), then
// inherited PATH, then the static floor, and handed back for child_process
// { env } options.
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
  resolvedEnvPromise = Promise.resolve()
    .then(() => captureLoginShellPath())
    .then((captured) => {
      loginShellPath = captured;
      inheritedPath ??= process.env.PATH;
      const mergedPath = spawnPath();
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
  inheritedPath ??= process.env.PATH;
  return { ...process.env, PATH: spawnPath() };
};

export const runCli = async (
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs: number = TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<CliResult> => {
  // Env resolution must never take down the read-only adapter plane. In the
  // pathological case it rejects, fall back to the sync static merge so the
  // call still degrades to an {ok:false} result on ENOENT rather than throwing.
  if (signal?.aborted) {
    return { ok: false, stdout: "", error: ACCESS_CANCELLED_ERROR };
  }
  const env = await resolvedSpawnEnv().catch(() => resolvedSpawnEnvSync());
  if (signal?.aborted) {
    return { ok: false, stdout: "", error: ACCESS_CANCELLED_ERROR };
  }
  if (adapterProcessesQuiescing) {
    return { ok: false, stdout: "", error: ADAPTER_QUIESCING_ERROR };
  }
  return runOwnedFile(command, args, {
    timeoutMs,
    env,
    maxBuffer: MAX_BUFFER,
    ...(signal === undefined ? {} : { signal }),
  });
};

export const parseJson = <T>(text: string): T | undefined => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
};
