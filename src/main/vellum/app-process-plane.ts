import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  admitChildProcess,
  releaseOwned,
  signalOwned,
  spawnDetachedProcessGroup,
  type OwnedProcess,
  type SignalChildHandle,
  type SignalOwnedResult,
} from "./process-signal";

export const APP_PROCESS_PLANE_QUIESCING_ERROR =
  "app process plane is shutting down";

export const APP_PROCESS_TERM_GRACE_MS = 1_000;
export const APP_PROCESS_KILL_GRACE_MS = 1_500;

type AppProcessMode = "child" | "group";
type AppProcessSignal = "SIGTERM" | "SIGKILL";

export interface AppProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export type AppProcessClose = AppProcessExit;

export interface AppChildIo {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Diagnostics only. This value is never accepted as signal authority. */
  readonly pidForDiagnostics: number | undefined;
  readonly exited: Promise<AppProcessExit>;
  readonly closed: Promise<AppProcessClose>;
  readonly onExit: (listener: (event: AppProcessExit) => void) => () => void;
  readonly onClose: (listener: (event: AppProcessClose) => void) => () => void;
  readonly onError: (listener: (error: Error) => void) => () => void;
}

const AppProcessLeaseTypeId: unique symbol = Symbol("@vellum/AppProcessLease");

/**
 * A lookup key for plane-owned authority. The private symbol prevents normal
 * construction and the plane's WeakMap identity check rejects cast forgeries.
 */
export interface AppProcessLease {
  readonly [AppProcessLeaseTypeId]: typeof AppProcessLeaseTypeId;
  readonly generation: number;
  readonly source: string;
  readonly purpose: string;
  readonly mode: AppProcessMode;
  readonly io: AppChildIo;
}

export interface AppProcessSpawnSpec {
  readonly source: string;
  readonly purpose: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
}

export interface AppOutlivingDaemonSpec extends AppProcessSpawnSpec {
  /** Makes the lifetime exception explicit at every callsite. */
  readonly lifetime: "outlives-app";
}

export interface AppOutlivingDaemonReadiness {
  readonly ready: true;
}

/** Deliberately contains no child, pid, signal, or termination lease. */
export interface AppOutlivingDaemonHandoff {
  readonly readiness: Promise<AppOutlivingDaemonReadiness>;
}

export interface AppProcessSignalReceipt extends SignalOwnedResult {
  readonly signal: AppProcessSignal;
  readonly reason: string;
}

export type AppProcessStragglerState =
  | "running"
  | "exited-awaiting-close"
  | "leaderless-group"
  | "refused";

export interface AppProcessStraggler {
  readonly generation: number;
  readonly source: string;
  readonly purpose: string;
  readonly mode: AppProcessMode;
  readonly state: AppProcessStragglerState;
  readonly pid?: number;
  readonly term?: AppProcessSignalReceipt;
  readonly kill?: AppProcessSignalReceipt;
}

export type AppProcessDrainResult =
  | { readonly clean: true; readonly stragglers: readonly [] }
  | { readonly clean: false; readonly stragglers: readonly AppProcessStraggler[] };

export interface AppProcessPlaneOptions {
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
}

export interface AppProcessPlane {
  readonly spawnChild: (spec: AppProcessSpawnSpec) => AppProcessLease;
  readonly spawnGroup: (spec: AppProcessSpawnSpec) => AppProcessLease;
  readonly spawnOutlivingDaemon: (
    spec: AppOutlivingDaemonSpec,
  ) => AppOutlivingDaemonHandoff;
  readonly terminate: (
    lease: AppProcessLease,
    reason: string,
  ) => AppProcessSignalReceipt;
  readonly forceTerminate: (
    lease: AppProcessLease,
    reason: string,
  ) => AppProcessSignalReceipt;
  /** Synchronously and permanently closes every spawn admission path. */
  readonly beginShutdown: () => void;
  readonly drainOnQuit: () => Promise<AppProcessDrainResult>;
  readonly isQuiescing: () => boolean;
}

interface AppProcessRecord {
  readonly generation: number;
  readonly source: string;
  readonly purpose: string;
  readonly mode: AppProcessMode;
  readonly child: ChildProcessWithoutNullStreams;
  readonly owned: OwnedProcess;
  readonly pidForDiagnostics: number | undefined;
  readonly exitListeners: Set<(event: AppProcessExit) => void>;
  readonly closeListeners: Set<(event: AppProcessClose) => void>;
  readonly errorListeners: Set<(error: Error) => void>;
  exitEvent: AppProcessExit | undefined;
  closeEvent: AppProcessClose | undefined;
  authorityReleased: boolean;
  term: AppProcessSignalReceipt | undefined;
  kill: AppProcessSignalReceipt | undefined;
}

type RegistryEmptyWaiter = {
  readonly resolve: (empty: boolean) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

const MAX_DRAIN_PHASE_MS = 30_000;

const validateDrainPhaseMs = (
  value: number | undefined,
  fallback: number,
  label: string,
): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_DRAIN_PHASE_MS) {
    throw new RangeError(`${label} must be a bounded positive integer`);
  }
  return value;
};

const notify = <Value>(
  listeners: ReadonlySet<(value: Value) => void>,
  value: Value,
): void => {
  for (const listener of [...listeners]) {
    try {
      listener(value);
    } catch {
      // An I/O observer is never allowed to interrupt ownership retirement.
    }
  }
};

const frozenExit = (
  code: number | null,
  signal: NodeJS.Signals | null,
): AppProcessExit => Object.freeze({ code, signal });

const makeSignalSink = (
  child: ChildProcessWithoutNullStreams,
): SignalChildHandle => {
  // Bind once at spawn. Mutating a ChildProcess.kill property later cannot
  // redirect the signal authority held by process-signal.
  const kill = child.kill.bind(child);
  const pid = child.pid;
  return pid === undefined
    ? Object.freeze({ kill })
    : Object.freeze({ pid, kill });
};

const spawnOptions = (spec: AppProcessSpawnSpec) => ({
  cwd: spec.cwd,
  env: spec.env === undefined ? undefined : { ...spec.env },
});

const rejectedSignalReceipt = (
  signal: AppProcessSignal,
  reason: string,
  decisionReason: string,
): AppProcessSignalReceipt => Object.freeze({
  signal,
  reason,
  attempted: false,
  decision: { ok: false as const, reason: decisionReason },
  via: "none",
});

const withSignalReceipt = (
  signal: AppProcessSignal,
  reason: string,
  result: SignalOwnedResult,
): AppProcessSignalReceipt => Object.freeze({ signal, reason, ...result });

const stragglerState = (record: AppProcessRecord): AppProcessStragglerState => {
  if (record.mode === "group" && record.closeEvent !== undefined) {
    return "leaderless-group";
  }
  if (record.exitEvent !== undefined) return "exited-awaiting-close";
  if (record.term?.attempted === false || record.kill?.attempted === false) {
    return "refused";
  }
  return "running";
};

const summarizeStraggler = (record: AppProcessRecord): AppProcessStraggler =>
  Object.freeze({
    generation: record.generation,
    source: record.source,
    purpose: record.purpose,
    mode: record.mode,
    state: stragglerState(record),
    ...(record.pidForDiagnostics === undefined
      ? {}
      : { pid: record.pidForDiagnostics }),
    ...(record.term === undefined ? {} : { term: record.term }),
    ...(record.kill === undefined ? {} : { kill: record.kill }),
  });

const quiescingError = (): Error =>
  new Error(APP_PROCESS_PLANE_QUIESCING_ERROR);

/**
 * Central lifetime registry for every process owned by the desktop app.
 *
 * The low-level OwnedProcess and release capability never cross this closure.
 * A record remains strongly held through operation settlement and `exit`; only
 * the terminal `close` witness retires it from the registry.
 */
export const createAppProcessPlane = (
  options: AppProcessPlaneOptions = {},
): AppProcessPlane => {
  const termGraceMs = validateDrainPhaseMs(
    options.termGraceMs,
    APP_PROCESS_TERM_GRACE_MS,
    "app process TERM grace",
  );
  const killGraceMs = validateDrainPhaseMs(
    options.killGraceMs,
    APP_PROCESS_KILL_GRACE_MS,
    "app process KILL grace",
  );

  const records = new Set<AppProcessRecord>();
  const leases = new WeakMap<AppProcessLease, AppProcessRecord>();
  const registryEmptyWaiters = new Set<RegistryEmptyWaiter>();
  let nextGeneration = 1;
  let quiescing = false;
  let drainFlight: Promise<AppProcessDrainResult> | undefined;

  const assertSpawnAllowed = (): void => {
    if (quiescing) throw quiescingError();
  };

  const releaseRecordAuthority = (record: AppProcessRecord): void => {
    if (record.authorityReleased) return;
    record.authorityReleased = true;
    try {
      releaseOwned(record.owned);
    } catch {
      // Authority is still made unreachable from this plane after retirement.
    }
  };

  const notifyRegistryEmpty = (): void => {
    if (records.size !== 0) return;
    for (const waiter of registryEmptyWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(true);
    }
    registryEmptyWaiters.clear();
  };

  const makeIo = (record: AppProcessRecord): AppChildIo => {
    let resolveExit!: (event: AppProcessExit) => void;
    let resolveClose!: (event: AppProcessClose) => void;
    const exited = new Promise<AppProcessExit>((resolve) => {
      resolveExit = resolve;
    });
    const closed = new Promise<AppProcessClose>((resolve) => {
      resolveClose = resolve;
    });

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (record.exitEvent !== undefined || record.closeEvent !== undefined) return;
      const event = frozenExit(code, signal);
      record.exitEvent = event;
      // An exited leader can no longer be safely targeted. Keep the record
      // strong until close drains its inherited stdio endpoints.
      releaseRecordAuthority(record);
      resolveExit(event);
      notify(record.exitListeners, event);
      record.exitListeners.clear();
    };

    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (record.closeEvent !== undefined) return;
      const event = frozenExit(code, signal);
      record.closeEvent = event;
      record.child.off("exit", onExit);
      if (record.exitEvent === undefined) {
        // Node may report close directly for a failed spawn. Close is the
        // terminal witness for both promises, but remains distinct in state.
        record.exitEvent = event;
        resolveExit(event);
        notify(record.exitListeners, event);
      }
      releaseRecordAuthority(record);
      // A group leader's close proves only that its pipes drained, not that
      // every descendant in the process group is gone. Retain a non-signalable
      // tombstone until a future group-empty observer can prove convergence.
      if (record.mode === "child") records.delete(record);
      resolveClose(event);
      notify(record.closeListeners, event);
      record.closeListeners.clear();
      record.exitListeners.clear();
      record.errorListeners.clear();
      notifyRegistryEmpty();
    };

    const onError = (error: Error): void => {
      // Error is diagnostic, not a terminal witness. In particular, a failed
      // signal delivery may emit error while the child is still running.
      notify(record.errorListeners, error);
    };

    // Register the persistent error sink before the terminal witnesses. A
    // hostile/reentrant test child may synchronously fire while listeners are
    // being attached; the record and its authority already exist at this point.
    record.child.on("error", onError);
    record.child.once("exit", onExit);
    record.child.once("close", onClose);

    const subscribe = <Value>(
      listeners: Set<(value: Value) => void>,
      observed: () => Value | undefined,
      listener: (value: Value) => void,
    ): (() => void) => {
      const value = observed();
      if (value !== undefined) {
        try {
          listener(value);
        } catch {
          // Match asynchronous delivery containment.
        }
        return () => undefined;
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };

    const io: AppChildIo = {
      stdin: record.child.stdin,
      stdout: record.child.stdout,
      stderr: record.child.stderr,
      pidForDiagnostics: record.pidForDiagnostics,
      exited,
      closed,
      onExit: (listener) =>
        subscribe(record.exitListeners, () => record.exitEvent, listener),
      onClose: (listener) =>
        subscribe(record.closeListeners, () => record.closeEvent, listener),
      onError: (listener) => {
        if (record.closeEvent !== undefined) return () => undefined;
        record.errorListeners.add(listener);
        return () => {
          record.errorListeners.delete(listener);
        };
      },
    };
    return Object.freeze(io);
  };

  const register = (input: {
    readonly source: string;
    readonly purpose: string;
    readonly child: ChildProcessWithoutNullStreams;
    readonly owned: OwnedProcess;
    readonly mode: AppProcessMode;
  }): AppProcessLease => {
    const record: AppProcessRecord = {
      generation: nextGeneration++,
      source: input.source,
      purpose: input.purpose,
      mode: input.mode,
      child: input.child,
      owned: input.owned,
      pidForDiagnostics: input.child.pid,
      exitListeners: new Set(),
      closeListeners: new Set(),
      errorListeners: new Set(),
      exitEvent: undefined,
      closeEvent: undefined,
      authorityReleased: false,
      term: undefined,
      kill: undefined,
    };
    records.add(record);

    const io = makeIo(record);
    const leaseValue: AppProcessLease = {
      [AppProcessLeaseTypeId]: AppProcessLeaseTypeId,
      generation: record.generation,
      source: record.source,
      purpose: record.purpose,
      mode: record.mode,
      io,
    };
    const lease = Object.freeze(leaseValue);
    leases.set(lease, record);
    return lease;
  };

  const spawnChild = (spec: AppProcessSpawnSpec): AppProcessLease => {
    assertSpawnAllowed();
    const child = spawn(spec.command, [...(spec.args ?? [])], {
      ...spawnOptions(spec),
      detached: false,
      stdio: "pipe",
    });
    const signalSink = makeSignalSink(child);
    const owned = admitChildProcess({ source: spec.source, child: signalSink });
    return register({
      source: spec.source,
      purpose: spec.purpose,
      child,
      owned,
      mode: "child",
    });
  };

  const spawnGroup = (spec: AppProcessSpawnSpec): AppProcessLease => {
    assertSpawnAllowed();
    const spawned = spawnDetachedProcessGroup({
      source: spec.source,
      command: spec.command,
      args: spec.args ?? [],
      options: spawnOptions(spec),
    });
    return register({
      source: spec.source,
      purpose: spec.purpose,
      child: spawned.child,
      owned: spawned.process,
      mode: spawned.mode,
    });
  };

  const spawnOutlivingDaemon = (
    spec: AppOutlivingDaemonSpec,
  ): AppOutlivingDaemonHandoff => {
    assertSpawnAllowed();
    const child: ChildProcess = spawn(spec.command, [...(spec.args ?? [])], {
      ...spawnOptions(spec),
      detached: true,
      stdio: "ignore",
    });
    let settled = false;
    const readiness = new Promise<AppOutlivingDaemonReadiness>((resolve, reject) => {
      // Keep an error sink for the daemon lifetime. Only a pre-readiness error
      // rejects handoff; later errors cannot become an unhandled EventEmitter
      // exception and do not mint termination authority.
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.once("spawn", () => {
        if (settled) return;
        settled = true;
        resolve(Object.freeze({ ready: true }));
      });
    });
    child.unref();
    return Object.freeze({ readiness });
  };

  const signalRecord = (
    record: AppProcessRecord,
    signal: AppProcessSignal,
    reason: string,
  ): AppProcessSignalReceipt => {
    if (record.exitEvent !== undefined || record.authorityReleased) {
      return rejectedSignalReceipt(signal, reason, "process-already-exited");
    }
    const receipt = withSignalReceipt(signal, reason, signalOwned(record.owned, signal));
    if (signal === "SIGTERM") record.term = receipt;
    else record.kill = receipt;
    return receipt;
  };

  const signalLease = (
    lease: AppProcessLease,
    signal: AppProcessSignal,
    reason: string,
  ): AppProcessSignalReceipt => {
    const record = leases.get(lease);
    if (record === undefined || record.closeEvent !== undefined) {
      return rejectedSignalReceipt(signal, reason, "lease-not-registered");
    }
    return signalRecord(record, signal, reason);
  };

  const waitForRegistryEmpty = (timeoutMs: number): Promise<boolean> => {
    if (records.size === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter: RegistryEmptyWaiter = {
        resolve,
        // Deliberately referenced: app quit may not outrun its child drain.
        timer: setTimeout(() => {
          registryEmptyWaiters.delete(waiter);
          resolve(false);
        }, timeoutMs),
      };
      registryEmptyWaiters.add(waiter);
    });
  };

  const beginShutdown = (): void => {
    quiescing = true;
  };

  const drainOnQuit = (): Promise<AppProcessDrainResult> => {
    if (drainFlight !== undefined) return drainFlight;
    // This is the synchronous cut line. Publish the coalesced flight before
    // invoking any kill callback, which may re-enter spawn or drain.
    beginShutdown();
    const flight: Promise<AppProcessDrainResult> = Promise.resolve().then(async () => {
      for (const record of [...records]) {
        if (record.exitEvent === undefined && record.closeEvent === undefined) {
          signalRecord(record, "SIGTERM", "app-quit-drain");
        }
      }

      if (await waitForRegistryEmpty(termGraceMs)) {
        return { clean: true, stragglers: [] };
      }

      for (const record of [...records]) {
        if (record.exitEvent === undefined && record.closeEvent === undefined) {
          signalRecord(record, "SIGKILL", "app-quit-drain");
        }
      }

      if (await waitForRegistryEmpty(killGraceMs)) {
        return { clean: true, stragglers: [] };
      }

      return {
        clean: false,
        stragglers: Object.freeze([...records].map(summarizeStraggler)),
      };
    });
    drainFlight = flight;
    void flight.then(
      () => {
        if (drainFlight === flight) drainFlight = undefined;
      },
      () => {
        if (drainFlight === flight) drainFlight = undefined;
      },
    );
    return flight;
  };

  const plane: AppProcessPlane = {
    spawnChild,
    spawnGroup,
    spawnOutlivingDaemon,
    terminate: (lease, reason) => signalLease(lease, "SIGTERM", reason),
    forceTerminate: (lease, reason) => signalLease(lease, "SIGKILL", reason),
    beginShutdown,
    drainOnQuit,
    isQuiescing: () => quiescing,
  };
  return Object.freeze(plane);
};

/** Shared product plane; tests should create isolated planes. */
export const appProcessPlane: AppProcessPlane = createAppProcessPlane();
