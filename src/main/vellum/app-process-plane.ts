import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  captureProcessGroupObservation,
  refreshProcessGroupObservations,
  type ProcessGroupObservation,
  type ProcessGroupObservationRefresh,
} from "./process-epoch";
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
  readonly shell?: boolean | string;
  readonly uid?: number;
  readonly gid?: number;
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
  | "ownership-unverified"
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
  groupObservation: ProcessGroupObservation | undefined;
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
  shell: spec.shell,
  uid: spec.uid,
  gid: spec.gid,
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
  if (record.mode === "group" && record.groupObservation === undefined) {
    return "ownership-unverified";
  }
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

const validMemberEpoch = (
  value: unknown,
): boolean => typeof value === "object" && value !== null &&
  "pid" in value && typeof value.pid === "number" &&
  Number.isSafeInteger(value.pid) && value.pid > 0 &&
  "startKey" in value && typeof value.startKey === "string" &&
  value.startKey.length > 0;

const validCapturedGroupObservation = (
  value: ProcessGroupObservation | undefined,
  leaderPid: number,
): value is ProcessGroupObservation => value !== undefined &&
  value.originalProcessGroupId === leaderPid &&
  Number.isSafeInteger(value.sessionId) && value.sessionId >= 0 &&
  Array.isArray(value.observedMemberEpochs) &&
  value.observedMemberEpochs.every(validMemberEpoch) &&
  value.observedMemberEpochs.some((member) => member.pid === leaderPid);

const validGroupRefresh = (
  previous: ProcessGroupObservation,
  value: ProcessGroupObservationRefresh | undefined,
): value is ProcessGroupObservationRefresh => value !== undefined &&
  typeof value === "object" && value !== null &&
  typeof value.clean === "boolean" &&
  typeof value.observation === "object" && value.observation !== null &&
  value.observation.originalProcessGroupId === previous.originalProcessGroupId &&
  value.observation.sessionId === previous.sessionId &&
  Array.isArray(value.observation.observedMemberEpochs) &&
  value.observation.observedMemberEpochs.every(validMemberEpoch) &&
  previous.observedMemberEpochs.every((prior) =>
    value.observation.observedMemberEpochs.some((next) =>
      next.pid === prior.pid && next.startKey === prior.startKey
    )
  );

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

  const retireRecord = (record: AppProcessRecord): void => {
    if (!records.delete(record)) return;
    notifyRegistryEmpty();
  };

  const captureGroupObservation = (
    leaderPid: number | undefined,
  ): ProcessGroupObservation | undefined => {
    if (leaderPid === undefined) return undefined;
    try {
      const observation = captureProcessGroupObservation(leaderPid);
      return observation !== undefined &&
          validCapturedGroupObservation(observation, leaderPid)
        ? observation
        : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * Refresh every verified group from one coherent process table. A failed or
   * malformed refresh mutates nothing. Only close plus verified emptiness can
   * retire a group tombstone; this function never restores signal authority.
   */
  const refreshObservedGroups = (): void => {
    const observed = [...records].filter(
      (record): record is AppProcessRecord & {
        groupObservation: ProcessGroupObservation;
      } => record.mode === "group" && record.groupObservation !== undefined,
    );
    if (observed.length === 0) return;

    let refreshed: readonly ProcessGroupObservationRefresh[] | undefined;
    try {
      refreshed = refreshProcessGroupObservations(
        observed.map((record) => record.groupObservation),
      );
    } catch {
      return;
    }
    if (refreshed === undefined || refreshed.length !== observed.length) return;

    for (let index = 0; index < observed.length; index += 1) {
      const record = observed[index]!;
      const next = refreshed[index]!;
      if (!validGroupRefresh(record.groupObservation, next)) continue;
      record.groupObservation = next.observation;
      if (next.clean && record.closeEvent !== undefined) retireRecord(record);
    }
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
      record.child.off("error", onError);
      if (record.exitEvent === undefined) {
        // Close is enough to settle the terminal promise, but it is not an
        // observed exit event. Keep onExit diagnostic callbacks distinct.
        resolveExit(event);
      }
      releaseRecordAuthority(record);
      // A group leader's close proves only that its pipes drained, not that
      // every descendant in the process group is gone. Retain a non-signalable
      // tombstone until a future group-empty observer can prove convergence.
      if (record.mode === "child") retireRecord(record);
      resolveClose(event);
      notify(record.closeListeners, event);
      record.closeListeners.clear();
      record.exitListeners.clear();
      record.errorListeners.clear();
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
      onExit: (listener) => record.closeEvent !== undefined &&
          record.exitEvent === undefined
        ? () => undefined
        : subscribe(record.exitListeners, () => record.exitEvent, listener),
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
      groupObservation: undefined,
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
    const lease = register({
      source: spec.source,
      purpose: spec.purpose,
      child: spawned.child,
      owned: spawned.process,
      mode: spawned.mode,
    });
    if (spawned.mode === "group") {
      // Lifecycle listeners are already attached. Capture before exposing the
      // lease so the observed/unverified ownership state is immutable in time.
      const record = leases.get(lease)!;
      record.groupObservation = captureGroupObservation(spawned.child.pid);
    }
    return lease;
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
      // A retry can retire tombstones whose descendants exited after an
      // earlier bounded receipt. Refresh before issuing any new signal.
      refreshObservedGroups();
      if (records.size === 0) return { clean: true, stragglers: [] };

      for (const record of [...records]) {
        if (record.exitEvent === undefined && record.closeEvent === undefined) {
          signalRecord(record, "SIGTERM", "app-quit-drain");
        }
      }

      await waitForRegistryEmpty(termGraceMs);
      refreshObservedGroups();
      if (records.size === 0) {
        return { clean: true, stragglers: [] };
      }

      for (const record of [...records]) {
        if (record.exitEvent === undefined && record.closeEvent === undefined) {
          signalRecord(record, "SIGKILL", "app-quit-drain");
        }
      }

      await waitForRegistryEmpty(killGraceMs);
      refreshObservedGroups();
      if (records.size === 0) {
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
