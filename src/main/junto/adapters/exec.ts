import { accessSync, constants } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { resolveJuntoHome } from "@shared/junto-home";
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
  /** Present on success; some CLIs print their tables to stderr. */
  readonly stderr?: string;
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
    readonly cwd?: string;
    readonly signal?: AbortSignal;
    readonly source?: string;
    readonly purpose?: string;
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
        source: options.source ?? "adapter.cli",
        purpose: options.purpose ?? "read-only adapter command",
        command,
        args,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
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
        settleResult({ ok: true, stdout, stderr });
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
// (hermes/codex/bun) would ENOENT, so these dirs resolve the common roots.
// Real binary dirs rank ahead of shim dirs: a mise/asdf/pyenv shim only works
// inside an activated context, so a genuine binary must win whenever both
// exist.
export const staticPathDirs = (home: string): ReadonlyArray<string> => [
  join(home, ".local", "bin"),
  join(home, ".kimi-code", "bin"),
  join(home, ".bun", "bin"),
  join(home, ".grok", "bin"),
  join(home, ".volta", "bin"),
  join(home, ".cargo", "bin"),
  join(home, ".deno", "bin"),
  join(home, "go", "bin"),
  join(home, "bin"),
  join(home, ".local", "share", "pnpm"),
  join(home, "Library", "pnpm"),
  join(home, ".nix-profile", "bin"),
  join(home, ".local", "share", "mise", "shims"),
  join(home, ".asdf", "shims"),
  join(home, ".pyenv", "shims"),
  join(home, ".rbenv", "shims"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/opt/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

// ── The operator's shell environment ────────────────────────────────────────
//
// What `codex` or `bun` means on this machine, and which SSH agent, API keys
// and version-manager activation a seat runs with, lives in the operator's
// shell startup files. A Finder/launchd launch inherits none of it. So once
// per app start each Junto (a window, or the windowless core on a linked
// machine or a Linux sandbox) asks the operator's own login shell for its
// environment, the way VS Code does, and every spawn uses the answer.
//
// The probe is `$SHELL -l -i -c` printing a sentinel-framed `env -0`. It runs
// as an owned child on the process plane with stdin closed, a hard timeout
// and an output cap, from an app-owned directory (never the operator home),
// with JUNTO_RESOLVING_ENVIRONMENT=1 so an rc file can skip heavy work. Its
// rc files run under Junto's TCC identity exactly as a Junto terminal's
// `$SHELL -l` does; measured on 2026-10-19, they raised no TCC check at all
// (docs/macos-privacy.md). Any failure is fail-open: the spawn PATH is then
// the inherited PATH, operator tool directories and the static floor.

const SHELL_ENVIRONMENT_TIMEOUT_MS = 10_000;
const SHELL_ENVIRONMENT_MAX_OUTPUT_BYTES = 1024 * 1024;
const SHELL_ENVIRONMENT_BEGIN = "JUNTO_ENV_BEGIN";
const SHELL_ENVIRONMENT_END = "JUNTO_ENV_END";
export const SHELL_ENVIRONMENT_RESOLVING_KEY = "JUNTO_RESOLVING_ENVIRONMENT";
/** `inherit` skips the probe: hermetic test runs, or an rc that must not run. */
export const SHELL_ENVIRONMENT_SWITCH_KEY = "JUNTO_SHELL_ENVIRONMENT";

// Shell bookkeeping and the probe's own markers. The app's own namespaces stay
// as its launcher set them: an rc file that exports JUNTO_HOME must not move a
// running Junto onto another home.
const SHELL_SESSION_KEYS: ReadonlySet<string> = new Set([
  "_",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "TERM",
  SHELL_ENVIRONMENT_RESOLVING_KEY,
]);
const APP_OWNED_KEY = /^(?:JUNTO_|ELECTRON_)/u;

/**
 * The environment between the probe sentinels. rc output (motd, prompts,
 * hook noise) lands outside them and is discarded. Undefined when a sentinel
 * is missing (timeout, output cap, a shell that died) or `env -0` was not
 * understood, so nothing half-read is ever applied.
 */
export const shellEnvironmentFromProbeOutput = (
  output: string,
): Readonly<Record<string, string>> | undefined => {
  const marker = `${SHELL_ENVIRONMENT_BEGIN}\n`;
  const begin = output.indexOf(marker);
  if (begin < 0) return undefined;
  const bodyStart = begin + marker.length;
  const end = output.lastIndexOf(SHELL_ENVIRONMENT_END);
  if (end < bodyStart) return undefined;
  const body = output.slice(bodyStart, end);
  if (!body.endsWith("\0")) return undefined;
  const environment: Record<string, string> = {};
  for (const entry of body.slice(0, -1).split("\0")) {
    const equals = entry.indexOf("=");
    if (equals <= 0) continue;
    const key = entry.slice(0, equals);
    if (SHELL_SESSION_KEYS.has(key) || APP_OWNED_KEY.test(key)) continue;
    environment[key] = entry.slice(equals + 1);
  }
  return environment.PATH ? environment : undefined;
};

/** The operator's login shell: `$SHELL`, else the account's, else the platform's. */
export const operatorShell = (): string | undefined => {
  if (process.platform === "win32") return undefined;
  const candidates = [process.env.SHELL, safeAccountShell()];
  for (const candidate of candidates) {
    const shell = candidate?.trim();
    if (shell && isAbsolute(shell) && isExecutable(shell)) return shell;
  }
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
};

const safeAccountShell = (): string | undefined => {
  try {
    return userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
};

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Product state, never the operator home: the probe's rc files start here. */
const shellEnvironmentCwd = async (): Promise<string> => {
  const dir = join(resolveJuntoHome(), ".junto");
  try {
    await mkdir(dir, { recursive: true });
    return dir;
  } catch {
    return tmpdir();
  }
};

export type ShellEnvironmentProbe = {
  readonly shell: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
};

/**
 * Run the operator's login+interactive shell once and read its environment.
 * `-l` sources login files (.zprofile, .profile), `-i` interactive rc
 * (.zshrc, .bashrc) where PATH exports and version-manager activation live.
 * Never throws; a failure answers with its reason.
 */
export const probeShellEnvironment = async (
  probe: ShellEnvironmentProbe,
): Promise<
  | { readonly ok: true; readonly environment: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly reason: string }
> => {
  const result = await runOwnedFile(
    probe.shell,
    [
      "-l",
      "-i",
      "-c",
      // The markers are split mid-token so the command line itself, echoed
      // by a tracing rc, never carries a whole sentinel.
      `echo JUNTO_ENV_""BEGIN; env -0; echo JUNTO_ENV_""END`,
    ],
    {
      timeoutMs: probe.timeoutMs ?? SHELL_ENVIRONMENT_TIMEOUT_MS,
      maxBuffer: SHELL_ENVIRONMENT_MAX_OUTPUT_BYTES,
      cwd: probe.cwd,
      env: { ...probe.env, TERM: "dumb", [SHELL_ENVIRONMENT_RESOLVING_KEY]: "1" },
      source: "adapter.shell-environment",
      purpose: "operator login-shell environment",
    },
  );
  // A shell can exit non-zero after a complete dump (an rc's last command
  // failing); the sentinels, not the exit code, say whether it was read.
  const environment = shellEnvironmentFromProbeOutput(result.stdout);
  if (environment) return { ok: true, environment };
  return { ok: false, reason: result.error ?? "the shell printed no environment" };
};

// Pure PATH merge, extracted so the ordering/dedup contract is unit-testable.
// Precedence: the operator's shell PATH, then the PATH Junto inherited, then
// operator tool dirs, then the static floor. First occurrence of each
// directory wins; empty entries are dropped.
export const mergePath = (inputs: {
  readonly shellPath?: string;
  readonly currentPath?: string;
  readonly home: string;
  readonly extraDirs?: ReadonlyArray<string>;
}): string => {
  const segments: string[] = [];
  const pushAll = (value: string | undefined) => {
    if (!value) return;
    for (const part of value.split(delimiter)) {
      const dir = part.trim();
      if (dir) segments.push(dir);
    }
  };

  pushAll(inputs.shellPath);
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
  return merged.join(delimiter);
};

let extraPathDirs: ReadonlyArray<string> = [];
let inheritedPath: string | undefined;
let shellPath: string | undefined;
let resolvedEnvPromise: Promise<NodeJS.ProcessEnv> | undefined;
let resolvedEnvCache: NodeJS.ProcessEnv | undefined;

const spawnPath = (): string =>
  mergePath({
    ...(shellPath === undefined ? {} : { shellPath }),
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

// The one resolved environment every spawn call-site should use. Resolved
// once per app start from the operator's shell environment (above), with PATH
// merged over the inherited PATH, operator tool directories and the static
// floor, then cached for the life of the process.
//
// Seats, terminals, the codex/prism service spawns, SSH and runCli below all
// route through here, so a packaged/launchd launch runs CLIs with the same
// environment as a dev-from-terminal launch.
//
// SINGLE documented mutation of the app's own environment: the shell's
// variables and the merged PATH are assigned onto process.env, so any spawn
// that inherits process.env verbatim (seat launches, the services/process.ts
// helper) carries the operator environment for free. Shell bookkeeping keys
// and the app's own JUNTO_*/ELECTRON_* keys are never taken from the shell.
export const resolvedSpawnEnv = (): Promise<NodeJS.ProcessEnv> => {
  if (resolvedEnvPromise) return resolvedEnvPromise;
  resolvedEnvPromise = (async () => {
    inheritedPath ??= process.env.PATH;
    const shell = process.env[SHELL_ENVIRONMENT_SWITCH_KEY] === "inherit" ? undefined : operatorShell();
    if (shell !== undefined) {
      const probe = await probeShellEnvironment({
        shell,
        cwd: await shellEnvironmentCwd(),
        env: process.env,
      });
      if (probe.ok) {
        const { PATH: probedPath, ...variables } = probe.environment;
        shellPath = probedPath;
        Object.assign(process.env, variables);
      } else {
        console.warn(
          `[env] ${shell} gave no environment (${probe.reason}); seats use the inherited PATH and the floor`,
        );
      }
    }
    const mergedPath = spawnPath();
    process.env.PATH = mergedPath;
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: mergedPath };
    resolvedEnvCache = env;
    return env;
  })();
  return resolvedEnvPromise;
};

// Synchronous accessor for call-sites that cannot await (e.g. inside a spawn
// options literal). Returns the memoized env once resolvedSpawnEnv() has
// settled; before that, the inherited PATH merged with the floor, so a
// synchronous caller never ships the bare minimal PATH.
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
