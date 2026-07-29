import { lstat, mkdtemp, rm } from "node:fs/promises";
import type { Readable } from "node:stream";
import {
  createAppProcessPlane,
  type AppProcessDrainResult,
  type AppProcessLease,
  type AppProcessPlane,
  type AppProcessSignalReceipt,
  type AppProcessSpawnSpec,
} from "../src/main/vellum/app-process-plane";

const DEFAULT_MAX_LOG_BYTES = 128 * 1024;
const DEFAULT_TERM_GRACE_MS = 1_000;
const DEFAULT_KILL_GRACE_MS = 1_500;
const MAX_GRACE_MS = 30_000;
const MAX_DIAGNOSTIC_BYTES = 4 * 1024;

export interface ProbeProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly diagnostics: readonly string[];
}

export interface ProbeProcessClose extends ProbeProcessOutput {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export type ProbeProcessOutputListener = (
  source: "stdout" | "stderr",
  snapshot: ProbeProcessOutput,
  chunk: string,
) => void;

const ProbeProcessHandleTypeId: unique symbol = Symbol(
  "@vellum/ProbeProcessHandle",
);

/** Opaque observation handle. It carries no child, pid, signal, or lease. */
export interface ProbeProcessHandle {
  readonly [ProbeProcessHandleTypeId]: typeof ProbeProcessHandleTypeId;
  readonly generation: number;
  readonly source: string;
  readonly purpose: string;
  readonly closed: Promise<ProbeProcessClose>;
  readonly exited: () => boolean;
  /** Close only this supervisor-owned child's stdin pipe. */
  readonly endInput: () => void;
  readonly output: () => ProbeProcessOutput;
  readonly onOutput: (listener: ProbeProcessOutputListener) => () => void;
}

export interface ProbeProcessStopReceipt {
  readonly closed: boolean;
  readonly close?: ProbeProcessClose;
  readonly term?: AppProcessSignalReceipt;
  readonly kill?: AppProcessSignalReceipt;
}

export interface ProbeProcessActiveReceipt {
  readonly generation: number;
  readonly source: string;
  readonly purpose: string;
  readonly exited: boolean;
  readonly diagnosticCount: number;
}

export interface ProbeProcessDrainFailure {
  readonly clean: false;
  readonly stragglers: readonly [];
  readonly error: string;
}

export interface ProbeProcessDrainReceipt {
  readonly clean: boolean;
  readonly groupDrain: AppProcessDrainResult | ProbeProcessDrainFailure;
  readonly refusedSignals: readonly AppProcessSignalReceipt[];
  readonly active: readonly ProbeProcessActiveReceipt[];
}

export interface ProbeProcessSupervisorOptions {
  readonly maxLogBytes?: number;
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
  /** Tests may inject an isolated fake. Production callers omit this. */
  readonly processPlane?: AppProcessPlane;
}

export interface ProbeProcessSupervisor {
  readonly spawnGroup: (spec: AppProcessSpawnSpec) => ProbeProcessHandle;
  readonly waitForClose: (
    handle: ProbeProcessHandle,
    timeoutMs: number,
    timeoutCode: string,
  ) => Promise<ProbeProcessClose>;
  readonly stop: (
    handle: ProbeProcessHandle,
    reason: string,
  ) => Promise<ProbeProcessStopReceipt>;
  /** Synchronously cuts admissions, then closes and verifies every group. */
  readonly shutdown: (reason: string) => Promise<ProbeProcessDrainReceipt>;
  readonly isQuiescing: () => boolean;
}

const ProbeSandboxTypeId: unique symbol = Symbol("@vellum/ProbeSandbox");

/** A deletion capability bound to one directory created by this module. */
export interface ProbeSandbox {
  readonly [ProbeSandboxTypeId]: typeof ProbeSandboxTypeId;
  readonly root: string;
}

interface ProbeSandboxAuthority {
  readonly root: string;
  readonly device: number;
  readonly inode: number;
  removalFlight: Promise<boolean> | undefined;
  removed: boolean;
}

const sandboxAuthority = new WeakMap<ProbeSandbox, ProbeSandboxAuthority>();

interface BoundedLog {
  append(chunk: unknown): void;
  read(): string;
}

interface ProbeProcessRecord {
  readonly lease: AppProcessLease;
  readonly handle: ProbeProcessHandle;
  readonly stdout: BoundedLog;
  readonly stderr: BoundedLog;
  readonly diagnostics: string[];
  readonly outputListeners: Set<ProbeProcessOutputListener>;
  exited: boolean;
  close: ProbeProcessClose | undefined;
  term: AppProcessSignalReceipt | undefined;
  kill: AppProcessSignalReceipt | undefined;
}

const boundedPositiveInteger = (
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new RangeError(`${label} must be a bounded positive integer`);
  }
  return resolved;
};

const toBuffer = (chunk: unknown): Buffer => {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), "utf8");
};

const makeBoundedLog = (maximumBytes: number): BoundedLog => {
  let bytes = Buffer.alloc(0);
  return {
    append: (chunk) => {
      const incoming = toBuffer(chunk);
      if (incoming.byteLength >= maximumBytes) {
        bytes = Buffer.from(incoming.subarray(incoming.byteLength - maximumBytes));
        return;
      }
      const overflow = bytes.byteLength + incoming.byteLength - maximumBytes;
      bytes = overflow > 0
        ? Buffer.concat([bytes.subarray(overflow), incoming])
        : Buffer.concat([bytes, incoming]);
    },
    read: () => bytes.toString("utf8"),
  };
};

const normalizedError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const boundedDiagnostic = (error: unknown): string => {
  const encoded = Buffer.from(normalizedError(error), "utf8");
  return encoded.byteLength <= MAX_DIAGNOSTIC_BYTES
    ? encoded.toString("utf8")
    : encoded.subarray(encoded.byteLength - MAX_DIAGNOSTIC_BYTES).toString("utf8");
};

const refusedSignal = (
  signal: "SIGTERM" | "SIGKILL",
  reason: string,
  error: unknown,
): AppProcessSignalReceipt => Object.freeze({
  attempted: false,
  decision: Object.freeze({
    ok: false,
    reason: `supervisor-signal-dispatch-failed:${boundedDiagnostic(error)}`,
  }),
  via: "none",
  signal,
  reason,
});

const listen = (
  stream: Readable,
  listener: (chunk: unknown) => void,
): (() => void) => {
  stream.on("data", listener);
  return () => stream.off("data", listener);
};

const frozenOutput = (record: ProbeProcessRecord): ProbeProcessOutput =>
  Object.freeze({
    stdout: record.stdout.read(),
    stderr: record.stderr.read(),
    diagnostics: Object.freeze([...record.diagnostics]),
  });

const frozenActive = (record: ProbeProcessRecord): ProbeProcessActiveReceipt =>
  Object.freeze({
    generation: record.handle.generation,
    source: record.handle.source,
    purpose: record.handle.purpose,
    exited: record.exited,
    diagnosticCount: record.diagnostics.length,
  });

const waitFor = async <Value>(
  promise: Promise<Value>,
  timeoutMs: number,
): Promise<{ readonly timedOut: false; readonly value: Value } | {
  readonly timedOut: true;
}> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ readonly timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const createProbeProcessSupervisor = (
  options: ProbeProcessSupervisorOptions = {},
): ProbeProcessSupervisor => {
  const maxLogBytes = boundedPositiveInteger(
    options.maxLogBytes,
    DEFAULT_MAX_LOG_BYTES,
    4 * 1024 * 1024,
    "probe log bound",
  );
  const termGraceMs = boundedPositiveInteger(
    options.termGraceMs,
    DEFAULT_TERM_GRACE_MS,
    MAX_GRACE_MS,
    "probe TERM grace",
  );
  const killGraceMs = boundedPositiveInteger(
    options.killGraceMs,
    DEFAULT_KILL_GRACE_MS,
    MAX_GRACE_MS,
    "probe KILL grace",
  );
  const processPlane = options.processPlane ?? createAppProcessPlane({
    termGraceMs,
    killGraceMs,
  });
  const authority = new WeakMap<ProbeProcessHandle, ProbeProcessRecord>();
  const active = new Set<ProbeProcessRecord>();
  const signalReceipts: AppProcessSignalReceipt[] = [];
  let shutdownFlight: Promise<ProbeProcessDrainReceipt> | undefined;

  const requireRecord = (handle: ProbeProcessHandle): ProbeProcessRecord => {
    const record = authority.get(handle);
    if (record === undefined) throw new Error("probe process handle is not registered");
    return record;
  };

  const notifyOutput = (
    record: ProbeProcessRecord,
    source: "stdout" | "stderr",
    chunk: unknown,
  ): void => {
    const snapshot = frozenOutput(record);
    for (const listener of [...record.outputListeners]) {
      try {
        listener(source, snapshot, toBuffer(chunk).toString("utf8"));
      } catch {
        // Output observers are diagnostic and cannot perturb process ownership.
      }
    }
  };

  const requestSignal = (
    record: ProbeProcessRecord,
    signal: "SIGTERM" | "SIGKILL",
    reason: string,
  ): AppProcessSignalReceipt => {
    const previous = signal === "SIGTERM" ? record.term : record.kill;
    if (previous !== undefined) return previous;
    let receipt: AppProcessSignalReceipt;
    try {
      receipt = signal === "SIGTERM"
        ? processPlane.terminate(record.lease, reason)
        : processPlane.forceTerminate(record.lease, reason);
    } catch (error) {
      receipt = refusedSignal(signal, reason, error);
    }
    if (signal === "SIGTERM") record.term = receipt;
    else record.kill = receipt;
    signalReceipts.push(receipt);
    return receipt;
  };

  const spawnGroup = (spec: AppProcessSpawnSpec): ProbeProcessHandle => {
    const lease = processPlane.spawnGroup(spec);
    const stdout = makeBoundedLog(maxLogBytes);
    const stderr = makeBoundedLog(maxLogBytes);
    const diagnostics: string[] = [];
    const outputListeners = new Set<ProbeProcessOutputListener>();
    let resolveClose!: (close: ProbeProcessClose) => void;
    const closed = new Promise<ProbeProcessClose>((resolve) => {
      resolveClose = resolve;
    });
    const handleValue: ProbeProcessHandle = {
      [ProbeProcessHandleTypeId]: ProbeProcessHandleTypeId,
      generation: lease.generation,
      source: lease.source,
      purpose: lease.purpose,
      closed,
      exited: () => authority.get(handleValue)?.exited ?? false,
      endInput: () => {
        requireRecord(handleValue).lease.io.stdin.end();
      },
      output: () => {
        const record = requireRecord(handleValue);
        return frozenOutput(record);
      },
      onOutput: (listener) => {
        const record = requireRecord(handleValue);
        if (record.close !== undefined) return () => undefined;
        record.outputListeners.add(listener);
        return () => record.outputListeners.delete(listener);
      },
    };
    const handle = Object.freeze(handleValue);
    const record: ProbeProcessRecord = {
      lease,
      handle,
      stdout,
      stderr,
      diagnostics,
      outputListeners,
      exited: false,
      close: undefined,
      term: undefined,
      kill: undefined,
    };
    authority.set(handle, record);
    active.add(record);

    const removeStdout = listen(lease.io.stdout, (chunk) => {
      stdout.append(chunk);
      notifyOutput(record, "stdout", chunk);
    });
    const removeStderr = listen(lease.io.stderr, (chunk) => {
      stderr.append(chunk);
      notifyOutput(record, "stderr", chunk);
    });
    const removeExit = lease.io.onExit(() => {
      record.exited = true;
    });
    const removeError = lease.io.onError((error) => {
      diagnostics.push(boundedDiagnostic(error));
      if (diagnostics.length > 32) diagnostics.shift();
    });
    void lease.io.closed.then(({ code, signal }) => {
      if (record.close !== undefined) return;
      record.exited = true;
      removeStdout();
      removeStderr();
      removeExit();
      removeError();
      record.outputListeners.clear();
      const output = frozenOutput(record);
      const close = Object.freeze({
        exitCode: code,
        signal,
        ...output,
      });
      record.close = close;
      active.delete(record);
      resolveClose(close);
    });
    return handle;
  };

  const waitForClose = async (
    handle: ProbeProcessHandle,
    timeoutMs: number,
    timeoutCode: string,
  ): Promise<ProbeProcessClose> => {
    const record = requireRecord(handle);
    const boundedTimeout = boundedPositiveInteger(
      timeoutMs,
      timeoutMs,
      15 * 60_000,
      "probe close timeout",
    );
    const settled = await waitFor(record.handle.closed, boundedTimeout);
    if (settled.timedOut) throw new Error(timeoutCode);
    return settled.value;
  };

  const stop = async (
    handle: ProbeProcessHandle,
    reason: string,
  ): Promise<ProbeProcessStopReceipt> => {
    const record = requireRecord(handle);
    if (record.close !== undefined) {
      return Object.freeze({ closed: true, close: record.close });
    }
    const term = requestSignal(record, "SIGTERM", reason);
    const afterTerm = await waitFor(record.handle.closed, termGraceMs);
    if (!afterTerm.timedOut) {
      return Object.freeze({ closed: true, close: afterTerm.value, term });
    }
    const kill = requestSignal(record, "SIGKILL", reason);
    const afterKill = await waitFor(record.handle.closed, killGraceMs);
    return afterKill.timedOut
      ? Object.freeze({ closed: false, term, kill })
      : Object.freeze({
        closed: true,
        close: afterKill.value,
        term,
        kill,
      });
  };

  const shutdown = (reason: string): Promise<ProbeProcessDrainReceipt> => {
    if (shutdownFlight !== undefined) return shutdownFlight;
    let resolveFlight!: (receipt: ProbeProcessDrainReceipt) => void;
    let rejectFlight!: (error: unknown) => void;
    const flight = new Promise<ProbeProcessDrainReceipt>((resolve, reject) => {
      resolveFlight = resolve;
      rejectFlight = reject;
    });
    // Publish before beginShutdown or signal dispatch: either may re-enter.
    shutdownFlight = flight;
    const execute = async (): Promise<ProbeProcessDrainReceipt> => {
      const initial = [...active];
      for (const record of initial) requestSignal(record, "SIGTERM", reason);

      if (active.size > 0) {
        await waitFor(Promise.all([...active].map((record) => record.handle.closed)), termGraceMs);
      }
      for (const record of [...active]) requestSignal(record, "SIGKILL", reason);
      if (active.size > 0) {
        await waitFor(Promise.all([...active].map((record) => record.handle.closed)), killGraceMs);
      }

      let groupDrain: AppProcessDrainResult | ProbeProcessDrainFailure;
      try {
        groupDrain = await processPlane.drainOnQuit();
      } catch (error) {
        groupDrain = Object.freeze({
          clean: false,
          stragglers: [] as const,
          error: normalizedError(error),
        });
      }
      if (groupDrain.clean && active.size > 0) {
        // A clean central registry implies every exact close promise is already
        // resolved; flush those observers before producing the receipt.
        await Promise.all([...active].map((record) => record.handle.closed));
      }
      const refusedSignals = Object.freeze(
        signalReceipts.filter((receipt) => !receipt.attempted),
      );
      const activeReceipt = Object.freeze([...active].map(frozenActive));
      return Object.freeze({
        clean: groupDrain.clean && refusedSignals.length === 0 && activeReceipt.length === 0,
        groupDrain,
        refusedSignals,
        active: activeReceipt,
      });
    };
    try {
      processPlane.beginShutdown();
      void execute().then(resolveFlight, rejectFlight);
    } catch (error) {
      rejectFlight(error);
    }
    return flight;
  };

  return Object.freeze({
    spawnGroup,
    waitForClose,
    stop,
    shutdown,
    isQuiescing: () => processPlane.isQuiescing(),
  });
};

export const retainProbeSandbox = (
  receipt: ProbeProcessDrainReceipt,
): boolean => !receipt.clean || receipt.refusedSignals.length > 0;

export const createProbeSandbox = async (prefix: string): Promise<ProbeSandbox> => {
  const root = await mkdtemp(prefix);
  try {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`probe sandbox mint did not create a directory: ${root}`);
    }
    const value: ProbeSandbox = {
      [ProbeSandboxTypeId]: ProbeSandboxTypeId,
      root,
    };
    const sandbox = Object.freeze(value);
    sandboxAuthority.set(sandbox, {
      root,
      device: metadata.dev,
      inode: metadata.ino,
      removalFlight: undefined,
      removed: false,
    });
    return sandbox;
  } catch (error) {
    // The path came directly from this invocation's mkdtemp, not from a caller.
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
};

export const removeProbeSandboxIfClean = async (options: {
  readonly sandbox: ProbeSandbox;
  readonly receipt: ProbeProcessDrainReceipt;
  readonly label: string;
}): Promise<boolean> => {
  const authority = sandboxAuthority.get(options.sandbox);
  if (authority === undefined) throw new Error("probe sandbox is not registered");
  if (authority.removed) return true;
  if (authority.removalFlight !== undefined) return authority.removalFlight;
  if (retainProbeSandbox(options.receipt)) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: "probe_process_cleanup_unclean",
      sandboxRetained: authority.root,
      processDrain: options.receipt,
    })}\n`);
    return false;
  }
  const removalFlight = (async (): Promise<boolean> => {
    let metadata;
    try {
      metadata = await lstat(authority.root);
    } catch (error) {
      const code = error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      if (code === "ENOENT") {
        authority.removed = true;
        return true;
      }
      throw error;
    }
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.dev !== authority.device ||
      metadata.ino !== authority.inode
    ) {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        error: "probe_sandbox_identity_changed",
        sandboxRetained: authority.root,
        label: options.label,
      })}\n`);
      return false;
    }
    await rm(authority.root, { recursive: true, force: true });
    authority.removed = true;
    return true;
  })();
  authority.removalFlight = removalFlight;
  try {
    return await removalFlight;
  } finally {
    if (!authority.removed) authority.removalFlight = undefined;
  }
};
