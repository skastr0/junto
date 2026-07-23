import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { IDisposable, IPty } from "node-pty";
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
  signalOwnedGroupLeader,
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
type AppOwnedMode = AppProcessMode | "terminal";
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

export interface AppProcessGroupSpawnSpec extends AppProcessSpawnSpec {
  /**
   * `leader` lets a cooperative multiprocess runtime coordinate its own
   * descendants before the plane escalates to a verified group SIGKILL.
   * The default remains group-wide TERM for ordinary worker trees.
   */
  readonly gracefulSignalScope?: "group" | "leader";
}

export interface AppProcessChildSpawnSpec extends AppProcessSpawnSpec {
  /**
   * Exact already-open descriptor inherited as child fd 3. The caller keeps
   * ownership of the parent descriptor and may close it after spawn returns.
   * No arbitrary child-fd mapping is exposed outside this central plane.
   */
  readonly inheritedFileDescriptor?: {
    readonly parentFd: number;
    readonly childFd: 3;
  };
}

export interface AppTerminalSpawnSpec {
  readonly source: string;
  readonly purpose: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly cols: number;
  readonly rows: number;
}

export interface AppTerminalExit {
  readonly code: number | undefined;
  readonly signal: number | undefined;
}

export interface AppTerminalIo {
  readonly pidForDiagnostics: number | undefined;
  readonly exited: Promise<AppTerminalExit>;
  readonly write: (data: string) => void;
  readonly resize: ((cols: number, rows: number) => void) | undefined;
  readonly onData: (listener: (data: string) => void) => () => void;
  readonly onExit: (listener: (event: AppTerminalExit) => void) => () => void;
  readonly onError: (listener: (error: Error) => void) => () => void;
}

export class TerminalBackendUnavailableError extends Error {
  readonly code = "terminal_pty_unavailable" as const;

  constructor(cause: unknown) {
    super("native PTY backend is unavailable", { cause });
    this.name = "TerminalBackendUnavailableError";
  }
}

const AppTerminalLeaseTypeId: unique symbol = Symbol("@vellum/AppTerminalLease");

export interface AppTerminalLease {
  readonly [AppTerminalLeaseTypeId]: typeof AppTerminalLeaseTypeId;
  readonly generation: number;
  readonly source: string;
  readonly purpose: string;
  /** Terminal readiness can only be backed by the native PTY path. */
  readonly backend: "pty";
  readonly io: AppTerminalIo;
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
  readonly mode: AppOwnedMode;
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
  readonly spawnChild: (spec: AppProcessChildSpawnSpec) => AppProcessLease;
  readonly spawnGroup: (spec: AppProcessGroupSpawnSpec) => AppProcessLease;
  readonly spawnTerminal: (spec: AppTerminalSpawnSpec) => AppTerminalLease;
  readonly spawnOutlivingDaemon: (
    spec: AppOutlivingDaemonSpec,
  ) => AppOutlivingDaemonHandoff;
  readonly terminate: (
    lease: AppProcessLease | AppTerminalLease,
    reason: string,
  ) => AppProcessSignalReceipt;
  readonly forceTerminate: (
    lease: AppProcessLease | AppTerminalLease,
    reason: string,
  ) => AppProcessSignalReceipt;
  /** Synchronously and permanently closes every spawn admission path. */
  readonly beginShutdown: () => void;
  readonly drainOnQuit: () => Promise<AppProcessDrainResult>;
  readonly isQuiescing: () => boolean;
}

interface AppOwnedRecord {
  readonly generation: number;
  readonly source: string;
  readonly purpose: string;
  readonly mode: AppOwnedMode;
  readonly owned: OwnedProcess;
  readonly pidForDiagnostics: number | undefined;
  exitEvent: AppProcessExit | AppTerminalExit | undefined;
  closeEvent: AppProcessClose | AppTerminalExit | undefined;
  authorityReleased: boolean;
  term: AppProcessSignalReceipt | undefined;
  kill: AppProcessSignalReceipt | undefined;
  termInProgressReason: string | undefined;
  killInProgressReason: string | undefined;
}

interface AppProcessRecord extends AppOwnedRecord {
  readonly mode: AppProcessMode;
  readonly gracefulSignalScope: "child" | "group" | "leader";
  readonly child: ChildProcessWithoutNullStreams;
  readonly exitListeners: Set<(event: AppProcessExit) => void>;
  readonly closeListeners: Set<(event: AppProcessClose) => void>;
  readonly errorListeners: Set<(error: Error) => void>;
  exitEvent: AppProcessExit | undefined;
  closeEvent: AppProcessClose | undefined;
  groupObservation: ProcessGroupObservation | undefined;
}

interface AppTerminalRecord extends AppOwnedRecord {
  readonly mode: "terminal";
  readonly backend: "pty";
  readonly dataListeners: Set<(data: string) => void>;
  readonly exitListeners: Set<(event: AppTerminalExit) => void>;
  readonly errorListeners: Set<(error: Error) => void>;
  exitEvent: AppTerminalExit | undefined;
  closeEvent: AppTerminalExit | undefined;
  cleanupListeners: () => void;
}

type AppRecord = AppProcessRecord | AppTerminalRecord;

interface TerminalBackendHandlers {
  readonly onData: (data: string) => void;
  readonly onExit: (event: AppTerminalExit) => void;
  readonly onError: (error: Error) => void;
}

interface TerminalBackend {
  readonly kind: "pty";
  readonly pid: number | undefined;
  readonly signalSink: SignalChildHandle;
  readonly write: (data: string) => void;
  readonly resize: ((cols: number, rows: number) => void) | undefined;
  readonly attach: (handlers: TerminalBackendHandlers) => {
    readonly cleanup: () => void;
    readonly error?: Error;
  };
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

const frozenTerminalExit = (
  code: number | undefined,
  signal: number | undefined,
): AppTerminalExit => Object.freeze({ code, signal });

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

const disposePtyListener = (listener: IDisposable | undefined): void => {
  try {
    listener?.dispose();
  } catch {
    // Listener disposal is best-effort after the terminal witness is recorded.
  }
};

const makePtyBackend = (pty: IPty): TerminalBackend => {
  // Snapshot and bind every authority-bearing member before any facade exists.
  const pid = pty.pid;
  const killPty = pty.kill.bind(pty);
  const signalSink: SignalChildHandle = Object.freeze({
    ...(pid === undefined ? {} : { pid }),
    kill: (signal?: NodeJS.Signals) => killPty(signal),
  });

  return Object.freeze({
    kind: "pty" as const,
    pid,
    signalSink,
    write: (data: string) => pty.write(data),
    resize: (cols: number, rows: number) => pty.resize(cols, rows),
    attach: (handlers: TerminalBackendHandlers) => {
      let exitListener: IDisposable | undefined;
      let dataListener: IDisposable | undefined;
      let setupError: Error | undefined;
      try {
        // Install the sole PTY terminal witness before the non-terminal stream.
        exitListener = pty.onExit(({ exitCode, signal }) => {
          handlers.onExit(frozenTerminalExit(
            exitCode ?? undefined,
            signal ?? undefined,
          ));
        });
      } catch (error) {
        setupError = error instanceof Error ? error : new Error(String(error));
      }
      if (setupError === undefined) {
        try {
          dataListener = pty.onData(handlers.onData);
        } catch (error) {
          setupError = error instanceof Error ? error : new Error(String(error));
        }
      }
      let cleaned = false;
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        disposePtyListener(dataListener);
        disposePtyListener(exitListener);
      };
      return setupError === undefined ? { cleanup } : { cleanup, error: setupError };
    },
  });
};

const spawnOptions = (spec: AppProcessSpawnSpec) => ({
  cwd: spec.cwd,
  env: spec.env === undefined ? undefined : { ...spec.env },
  shell: spec.shell,
  uid: spec.uid,
  gid: spec.gid,
});

const inheritedStdio = (
  spec: AppProcessChildSpawnSpec,
): "pipe" | ["pipe", "pipe", "pipe", number] => {
  const inherited = spec.inheritedFileDescriptor;
  if (inherited === undefined) return "pipe";
  if (
    inherited.childFd !== 3 ||
    !Number.isSafeInteger(inherited.parentFd) ||
    inherited.parentFd <= 2
  ) {
    throw new RangeError(
      "inherited child fd 3 requires a non-stdio parent descriptor",
    );
  }
  return ["pipe", "pipe", "pipe", inherited.parentFd];
};

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

const stragglerState = (record: AppRecord): AppProcessStragglerState => {
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

const summarizeStraggler = (record: AppRecord): AppProcessStraggler =>
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
  const records = new Set<AppRecord>();
  const leases = new WeakMap<AppProcessLease, AppProcessRecord>();
  const terminalLeases = new WeakMap<AppTerminalLease, AppTerminalRecord>();
  const registryEmptyWaiters = new Set<RegistryEmptyWaiter>();
  let nextGeneration = 1;
  let quiescing = false;
  let drainFlight: Promise<AppProcessDrainResult> | undefined;

  const assertSpawnAllowed = (): void => {
    if (quiescing) throw quiescingError();
  };

  const releaseRecordAuthority = (record: AppRecord): void => {
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

  const retireRecord = (record: AppRecord): void => {
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

    if (observed.some((record, index) =>
      !validGroupRefresh(record.groupObservation, refreshed?.[index])
    )) return;

    for (let index = 0; index < observed.length; index += 1) {
      const record = observed[index]!;
      const next = refreshed[index]!;
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
    readonly gracefulSignalScope?: "group" | "leader";
  }): AppProcessLease => {
    const record: AppProcessRecord = {
      generation: nextGeneration++,
      source: input.source,
      purpose: input.purpose,
      mode: input.mode,
      gracefulSignalScope: input.mode === "child"
        ? "child"
        : input.gracefulSignalScope ?? "group",
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
      termInProgressReason: undefined,
      killInProgressReason: undefined,
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

  const registerTerminal = (
    spec: AppTerminalSpawnSpec,
    backend: TerminalBackend,
  ): AppTerminalLease => {
    const owned = admitChildProcess({
      source: spec.source,
      child: backend.signalSink,
    });
    const record: AppTerminalRecord = {
      generation: nextGeneration++,
      source: spec.source,
      purpose: spec.purpose,
      mode: "terminal",
      backend: backend.kind,
      owned,
      pidForDiagnostics: backend.pid,
      dataListeners: new Set(),
      exitListeners: new Set(),
      errorListeners: new Set(),
      exitEvent: undefined,
      closeEvent: undefined,
      cleanupListeners: () => undefined,
      authorityReleased: false,
      term: undefined,
      kill: undefined,
      termInProgressReason: undefined,
      killInProgressReason: undefined,
    };
    records.add(record);

    let resolveExit!: (event: AppTerminalExit) => void;
    const exited = new Promise<AppTerminalExit>((resolve) => {
      resolveExit = resolve;
    });

    const waitForExit = (timeoutMs: number): Promise<boolean> => {
      if (record.exitEvent !== undefined || record.closeEvent !== undefined) {
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve(false);
        }, timeoutMs);
        void exited.then(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(true);
        });
      });
    };

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

    const onData = (data: string): void => {
      if (record.closeEvent === undefined) notify(record.dataListeners, data);
    };
    const onExit = (event: AppTerminalExit): void => {
      if (record.exitEvent !== undefined || record.closeEvent !== undefined) return;
      record.exitEvent = event;
      record.closeEvent = event;
      releaseRecordAuthority(record);
      resolveExit(event);
      notify(record.exitListeners, event);
      record.exitListeners.clear();
      // node-pty exposes no separate close witness: onExit is terminal.
      record.cleanupListeners();
      record.dataListeners.clear();
      record.errorListeners.clear();
      retireRecord(record);
    };
    const onError = (error: Error): void => {
      if (record.closeEvent === undefined) notify(record.errorListeners, error);
    };

    const ensureWritable = (): void => {
      if (record.exitEvent !== undefined || record.closeEvent !== undefined) {
        throw new Error("terminal process already exited");
      }
    };
    const write = (data: string): void => {
      ensureWritable();
      try {
        backend.write(data);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        onError(normalized);
        throw normalized;
      }
    };
    const resize = backend.resize === undefined
      ? undefined
      : (cols: number, rows: number): void => {
        ensureWritable();
        try {
          backend.resize!(cols, rows);
        } catch (error) {
          const normalized = error instanceof Error
            ? error
            : new Error(String(error));
          onError(normalized);
          throw normalized;
        }
      };
    const io: AppTerminalIo = Object.freeze({
      pidForDiagnostics: record.pidForDiagnostics,
      exited,
      write,
      resize,
      onData: (listener: (data: string) => void) => {
        if (record.closeEvent !== undefined) return () => undefined;
        record.dataListeners.add(listener);
        return () => {
          record.dataListeners.delete(listener);
        };
      },
      onExit: (listener: (event: AppTerminalExit) => void) =>
        record.closeEvent !== undefined &&
          record.exitEvent === undefined
        ? () => undefined
        : subscribe(record.exitListeners, () => record.exitEvent, listener),
      onError: (listener: (error: Error) => void) => {
        if (record.closeEvent !== undefined) return () => undefined;
        record.errorListeners.add(listener);
        return () => {
          record.errorListeners.delete(listener);
        };
      },
    });
    const leaseValue: AppTerminalLease = {
      [AppTerminalLeaseTypeId]: AppTerminalLeaseTypeId,
      generation: record.generation,
      source: record.source,
      purpose: record.purpose,
      backend: record.backend,
      io,
    };
    const lease = Object.freeze(leaseValue);
    terminalLeases.set(lease, record);

    const attachment = backend.attach({ onData, onExit, onError });
    record.cleanupListeners = attachment.cleanup;
    // A hostile backend can synchronously terminate while attaching.
    if (record.closeEvent !== undefined) record.cleanupListeners();
    if (attachment.error !== undefined) {
      onError(attachment.error);
      // Setup failure never opens an unowned fallback child. Retain this exact
      // child in the registry and run its bounded teardown even though no lease
      // can be returned to the caller.
      signalRecord(record, "SIGTERM", "terminal-listener-setup-failed");
      void (async () => {
        if (await waitForExit(termGraceMs)) return;
        signalRecord(record, "SIGKILL", "terminal-listener-setup-failed");
        await waitForExit(killGraceMs);
      })();
      throw attachment.error;
    }
    return lease;
  };

  const spawnChild = (spec: AppProcessChildSpawnSpec): AppProcessLease => {
    assertSpawnAllowed();
    // @types/node models only the first three stdio tuple entries. The central
    // builder above fixes all three to "pipe"; an optional fourth numeric
    // entry cannot make stdin/stdout/stderr nullable at runtime.
    const child = spawn(spec.command, [...(spec.args ?? [])], {
      ...spawnOptions(spec),
      detached: false,
      stdio: inheritedStdio(spec),
    }) as ChildProcessWithoutNullStreams;
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

  const spawnGroup = (spec: AppProcessGroupSpawnSpec): AppProcessLease => {
    assertSpawnAllowed();
    const gracefulSignalScope = spec.gracefulSignalScope ?? "group";
    if (
      gracefulSignalScope !== "group" &&
      gracefulSignalScope !== "leader"
    ) {
      throw new RangeError("group graceful signal scope must be group or leader");
    }
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
      gracefulSignalScope,
    });
    if (spawned.mode === "group") {
      // Lifecycle listeners are already attached. Capture before exposing the
      // lease so the observed/unverified ownership state is immutable in time.
      const record = leases.get(lease)!;
      record.groupObservation = captureGroupObservation(spawned.child.pid);
    }
    return lease;
  };

  const spawnTerminal = (spec: AppTerminalSpawnSpec): AppTerminalLease => {
    assertSpawnAllowed();
    let pty: IPty | undefined;
    try {
      // Keep the optional native dependency outside import-time graphs.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nodePty = require("node-pty") as typeof import("node-pty");
      pty = nodePty.spawn(spec.command, [...(spec.args ?? [])], {
        name: "xterm-256color",
        cols: spec.cols,
        rows: spec.rows,
        cwd: spec.cwd,
        env: spec.env === undefined ? undefined : { ...spec.env },
        handleFlowControl: true,
      });
    } catch (error) {
      throw new TerminalBackendUnavailableError(error);
    }
    // Listener/facade setup happens after native spawn. Once PTY
    // spawn succeeds, a setup failure tears down this exact owned process.
    return registerTerminal(spec, makePtyBackend(pty));
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
    record: AppRecord,
    signal: AppProcessSignal,
    reason: string,
  ): AppProcessSignalReceipt => {
    const existing = signal === "SIGTERM" ? record.term : record.kill;
    // A physically attempted delivery owns this phase forever. Refusals are
    // retained for diagnostics but may be retried by a later bounded owner;
    // signalOwned revalidates the exact epoch on every attempt.
    if (existing?.attempted === true) return existing;
    const inProgressReason = signal === "SIGTERM"
      ? record.termInProgressReason
      : record.killInProgressReason;
    if (inProgressReason !== undefined) {
      return rejectedSignalReceipt(
        signal,
        inProgressReason,
        "signal-request-in-progress",
      );
    }
    if (record.exitEvent !== undefined || record.authorityReleased) {
      return rejectedSignalReceipt(signal, reason, "process-already-exited");
    }
    if (signal === "SIGTERM") record.termInProgressReason = reason;
    else record.killInProgressReason = reason;
    let receipt: AppProcessSignalReceipt;
    try {
      const result =
        signal === "SIGTERM" &&
          record.mode === "group" &&
          record.gracefulSignalScope === "leader"
          ? signalOwnedGroupLeader(record.owned, signal)
          : signalOwned(record.owned, signal);
      receipt = withSignalReceipt(signal, reason, result);
    } catch {
      receipt = rejectedSignalReceipt(signal, reason, "signal-dispatch-failed");
    } finally {
      if (signal === "SIGTERM") record.termInProgressReason = undefined;
      else record.killInProgressReason = undefined;
    }
    if (signal === "SIGTERM") record.term = receipt;
    else record.kill = receipt;
    return receipt;
  };

  const signalLease = (
    lease: AppProcessLease | AppTerminalLease,
    signal: AppProcessSignal,
    reason: string,
  ): AppProcessSignalReceipt => {
    const record = leases.get(lease as AppProcessLease) ??
      terminalLeases.get(lease as AppTerminalLease);
    if (record === undefined) {
      return rejectedSignalReceipt(signal, reason, "lease-not-registered");
    }
    const existing = signal === "SIGTERM" ? record.term : record.kill;
    if (existing?.attempted === true) return existing;
    if (record.closeEvent !== undefined) {
      return existing ??
        rejectedSignalReceipt(signal, reason, "lease-not-registered");
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
    spawnTerminal,
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
