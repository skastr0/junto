import { shellEnvironment } from "../shell-environment";
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

// The operator's shell environment lives in ../shell-environment: what `codex`
// or `bun` means on this machine, and which SSH agent, API keys and
// version-manager activation a seat runs with, comes from the operator's
// login shell, read once per app start and again on request. Any failure is
// fail-open: the spawn PATH is then the inherited PATH, operator tool
// directories and the static floor.
export { staticPathDirs, mergePath } from "../shell-environment/path";

/** Operator-configured tool directories. Detection and launch both read this. */
export const configuredToolDirectories = (): ReadonlyArray<string> => shellEnvironment.toolDirectories();

export const setConfiguredToolDirectories = (directories: ReadonlyArray<string>): void =>
  shellEnvironment.setToolDirectories(directories);

// The one resolved environment every spawn call-site should use: the shell
// environment module's `ensure()`, the operator's shell environment with PATH
// merged over the inherited PATH, operator tool directories and the static
// floor.
//
// Seats, terminals, the codex/prism service spawns, SSH and runCli below all
// route through here, so a packaged/launchd launch runs CLIs with the same
// environment as a dev-from-terminal launch.
//
// SINGLE documented mutation of the app's own environment: the module assigns
// the shell's variables and the merged PATH onto process.env, so any spawn
// that inherits process.env verbatim (seat launches, the services/process.ts
// helper) carries the operator environment for free. Shell bookkeeping keys
// and the app's own JUNTO_*/ELECTRON_* keys are never taken from the shell.
export const resolvedSpawnEnv = (): Promise<NodeJS.ProcessEnv> => shellEnvironment.ensure();

// Synchronous accessor for call-sites that cannot await (e.g. inside a spawn
// options literal). The environment last applied; before the first read, the
// inherited PATH merged with the floor, so a synchronous caller never ships
// the bare minimal PATH.
export const resolvedSpawnEnvSync = (): NodeJS.ProcessEnv => shellEnvironment.environmentNow();

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
