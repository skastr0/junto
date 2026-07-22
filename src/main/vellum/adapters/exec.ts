import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  releaseOwned,
  signalOwned,
  spawnDetachedProcessGroup,
  type OwnedProcess,
  type TerminatingSignal,
} from "../process-signal";
import {
  captureProcessGroupObservation,
  refreshProcessGroupObservations,
  type ChildProcessEpoch,
  type ProcessGroupObservation,
} from "../process-epoch";

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
  owned: OwnedProcess | undefined;
  groupObservation: AdapterProcessGroupTombstone | undefined;
  readonly spawned: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  released?: boolean;
}

const ownedAdapterChildren = new Set<OwnedAdapterChild>();
type ObservedAdapterProcessGroup = {
  readonly kind: "observed";
  readonly originalProcessGroupId: number;
  readonly sessionId: number;
  readonly observedMemberEpochs: readonly ChildProcessEpoch[];
};
type UnverifiedAdapterProcessGroup = {
  readonly kind: "ownership-unverified";
  readonly originalProcessGroupId: number;
  readonly sessionId: undefined;
  readonly observedMemberEpochs: readonly [];
};
type AdapterProcessGroupTombstone =
  | ObservedAdapterProcessGroup
  | UnverifiedAdapterProcessGroup;
const adapterProcessGroupTombstones = new Set<AdapterProcessGroupTombstone>();
let adapterProcessesQuiescing = false;
let adapterQuitDrain: Promise<AdapterQuitDrainResult> | undefined;

export interface CliResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly error?: string;
}

const signalOwnedAdapterChild = (
  owned: OwnedAdapterChild,
  signal: NodeJS.Signals,
): void => {
  if (owned.owned !== undefined) {
    signalOwned(owned.owned, signal as TerminatingSignal);
  }
};

const observedTombstone = (
  observation: ProcessGroupObservation,
): ObservedAdapterProcessGroup => ({
  kind: "observed",
  originalProcessGroupId: observation.originalProcessGroupId,
  sessionId: observation.sessionId,
  observedMemberEpochs: observation.observedMemberEpochs,
});

const refreshAdapterProcessGroupTombstones = (): void => {
  const observed = [...adapterProcessGroupTombstones]
    .filter((tombstone): tombstone is ObservedAdapterProcessGroup =>
      tombstone.kind === "observed"
    );
  if (observed.length === 0) return;
  const refreshed = refreshProcessGroupObservations(observed);
  // One unavailable or malformed table proves nothing. Keep every prior
  // observation unclean and unchanged until a later drain can read a full one.
  if (!refreshed) return;
  refreshed.forEach((result, index) => {
    const previous = observed[index]!;
    adapterProcessGroupTombstones.delete(previous);
    if (!result.clean) {
      adapterProcessGroupTombstones.add(observedTombstone(result.observation));
    }
  });
};

const retireOwnedAdapterLeader = (owned: OwnedAdapterChild): void => {
  if (owned.released) return;
  owned.released = true;
  if (owned.cleanupTimer !== undefined) clearTimeout(owned.cleanupTimer);
  owned.cleanupTimer = undefined;
  const capability = owned.owned;
  owned.owned = undefined;
  releaseOwned(capability);
  ownedAdapterChildren.delete(owned);

  // From this point onward the global registry contains only read-only facts:
  // original pgid, session, and exact member epochs. It retains neither an
  // OwnedProcess nor a ChildProcess handle and therefore cannot signal.
  const tombstone = owned.groupObservation;
  owned.groupObservation = undefined;
  if (owned.spawned && tombstone !== undefined) {
    adapterProcessGroupTombstones.add(tombstone);
    refreshAdapterProcessGroupTombstones();
  }
};

const QUIT_KILL_GRACE_MS = 1_000;
const LEADER_STREAM_DRAIN_GRACE_MS = 100;
const LEADERLESS_STREAM_ERROR =
  "adapter command leader exited while output streams remained open; original process group retained for read-only observation";

const retainOwnedAdapterChildUntilKill = (owned: OwnedAdapterChild): void => {
  if (owned.released || owned.owned === undefined) return;
  if (owned.cleanupTimer === undefined) {
    owned.cleanupTimer = setTimeout(() => {
      signalOwnedAdapterChild(owned, "SIGKILL");
      owned.cleanupTimer = undefined;
    }, QUIT_KILL_GRACE_MS);
    owned.cleanupTimer.unref?.();
  }
};

const terminateOwnedAdapterChild = (owned: OwnedAdapterChild): void => {
  retainOwnedAdapterChildUntilKill(owned);
  if (owned.released) return;
  signalOwnedAdapterChild(owned, "SIGTERM");
};

/**
 * Monotonically close the read-only adapter process plane during app quit.
 *
 * Each live adapter command owns a distinct POSIX process group, so signalling
 * it cannot touch the intentionally persistent Herdr server/session plane.
 * Once its leader exits, only capability-free facts about that original group
 * survive. This observes the original process group, never a process tree.
 */
export interface AdapterQuitDrainResult {
  readonly scope: "original-process-group";
  readonly clean: boolean;
  readonly retained: number;
  readonly ownershipUnverified: number;
}

const observeAdapterQuitDrain = (): AdapterQuitDrainResult => {
  refreshAdapterProcessGroupTombstones();
  const ownershipUnverified = [...adapterProcessGroupTombstones]
    .filter((tombstone) => tombstone.kind === "ownership-unverified")
    .length;
  const retained = ownedAdapterChildren.size + adapterProcessGroupTombstones.size;
  return {
    scope: "original-process-group",
    clean: retained === 0,
    retained,
    ownershipUnverified,
  };
};

export const terminateAdapterChildrenOnQuit = (): Promise<AdapterQuitDrainResult> => {
  if (adapterQuitDrain) return adapterQuitDrain;
  adapterProcessesQuiescing = true;
  const activeAtQuiesce = ownedAdapterChildren.size;
  for (const owned of ownedAdapterChildren) {
    terminateOwnedAdapterChild(owned);
  }
  const inFlight = activeAtQuiesce === 0
    ? Promise.resolve().then(observeAdapterQuitDrain)
    : new Promise<AdapterQuitDrainResult>((resolve) => {
      const drainTimer = setTimeout(() => {
        resolve(observeAdapterQuitDrain());
      }, QUIT_KILL_GRACE_MS + LEADER_STREAM_DRAIN_GRACE_MS);
      drainTimer.unref?.();
    });
  adapterQuitDrain = inFlight.finally(() => {
    // Quiescence is permanent, but a later retry must observe exact records
    // that closed after an earlier bounded drain reported them retained.
    adapterQuitDrain = undefined;
  });
  return adapterQuitDrain;
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
      const spawned = spawnDetachedProcessGroup({
        source: "adapter.cli",
        command,
        args,
        options: options.env === undefined ? undefined : { env: options.env },
      });
      child = spawned.child;
      const owned: OwnedAdapterChild = {
        child,
        owned: spawned.process,
        groupObservation: process.platform === "win32" || child.pid === undefined
          ? undefined
          : (() => {
            const observation = captureProcessGroupObservation(child.pid!);
            return observation === undefined
              ? {
                kind: "ownership-unverified" as const,
                originalProcessGroupId: child.pid!,
                sessionId: undefined,
                observedMemberEpochs: [] as const,
              }
              : observedTombstone(observation);
          })(),
        spawned: child.pid !== undefined,
      };
      ownedAdapterChildren.add(owned);
      return runRegisteredAdapterChild(owned, options, resolve);
    } catch (error) {
      resolve({
        ok: false,
        stdout: "",
        error: error instanceof Error ? error.message : "adapter command spawn failed",
      });
      return;
    }

    // spawnDetachedProcessGroup registers before this point; late-spawn is closed.
  });
};

const runRegisteredAdapterChild = (
  owned: OwnedAdapterChild,
  options: { readonly timeoutMs: number; readonly maxBuffer: number },
  resolve: (result: CliResult) => void,
): void => {
    const child = owned.child;
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let resultSettled = false;
    let closeObserved = false;
    let leaderExited = false;
    let timedOut = false;
    let bufferExceeded = false;
    let leaderExitTimer: ReturnType<typeof setTimeout> | undefined;

    const detachChildStreams = (): void => {
      child.stdout.removeAllListeners("data");
      child.stderr.removeAllListeners("data");
      child.stdout.on("error", () => undefined);
      child.stderr.on("error", () => undefined);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      signalOwnedAdapterChild(owned, "SIGKILL");
      retainOwnedAdapterChildUntilKill(owned);
      settleResult({
        ok: false,
        stdout,
        error: `adapter command timed out after ${options.timeoutMs}ms`,
      });
    }, options.timeoutMs);
    timer.unref?.();

    const settleResult = (result: CliResult): void => {
      if (resultSettled) return;
      resultSettled = true;
      detachChildStreams();
      resolve(result);
    };

    const releaseAfterClose = (): void => {
      closeObserved = true;
      clearTimeout(timer);
      if (leaderExitTimer !== undefined) clearTimeout(leaderExitTimer);
      // Close may settle I/O, but it never erases an original-group tombstone.
      // This call is only a fallback for spawn-error paths without `exit`.
      retireOwnedAdapterLeader(owned);
    };

    const abandonLeaderlessGroup = (): void => {
      clearTimeout(timer);
      if (leaderExitTimer !== undefined) clearTimeout(leaderExitTimer);
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
      signalOwnedAdapterChild(owned, "SIGKILL");
      retainOwnedAdapterChildUntilKill(owned);
      settleResult({ ok: false, stdout, error: "adapter command exceeded the output limit" });
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: unknown) => append("stdout", chunk));
    child.stderr.on("data", (chunk: unknown) => append("stderr", chunk));
    child.on("error", (error) => {
      // A failed spawn has no live leader or group to tear down. Later errors
      // are not exit witnesses: retain bounded teardown and keep consuming
      // repeated events so EventEmitter never throws an unhandled error.
      if (!owned.spawned) {
        settleResult({ ok: false, stdout: "", error: error.message });
        retireOwnedAdapterLeader(owned);
        return;
      }
      if (closeObserved || leaderExited) return;
      terminateOwnedAdapterChild(owned);
      settleResult({ ok: false, stdout, error: error.message });
    });
    child.once("exit", () => {
      if (closeObserved) return;
      leaderExited = true;
      clearTimeout(timer);
      // Revoke all signal authority synchronously with leader exit. From here,
      // only capability-free original-group observations survive.
      retireOwnedAdapterLeader(owned);
      // A normal leader drains its pipes and reaches `close` first. If an
      // inherited pipe stays open, stop waiting and detach our endpoints.
      leaderExitTimer = setTimeout(() => {
        abandonLeaderlessGroup();
      }, LEADER_STREAM_DRAIN_GRACE_MS);
      leaderExitTimer.unref?.();
    });
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null && !timedOut && !bufferExceeded) {
        settleResult({ ok: true, stdout });
        releaseAfterClose();
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
      // Keep stdout on failure: tools like `codexbar usage --json` often exit
      // non-zero when a single provider errors while still emitting a useful
      // JSON payload on stdout. Callers decide whether to recover from it.
      settleResult({ ok: false, stdout, error });
      releaseAfterClose();
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
