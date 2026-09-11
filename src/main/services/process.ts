import {
  appProcessPlane,
  type AppChildIo,
  type AppProcessLease,
  type AppProcessSignalReceipt,
} from "../vellum-command/app-process-plane";

export interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export const SERVICE_CHILD_PLANE_QUIESCING_ERROR =
  "service process plane is shutting down";
export const SERVICE_CHILD_TEARDOWN_PENDING_ERROR =
  "service process teardown is still pending";

const DEFAULT_PROCESS_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const SERVICE_CHILD_TERM_GRACE_MS = 1_000;
const SERVICE_CHILD_CLOSE_DRAIN_MS = 250;

type ServiceChildSignalAttempt = {
  readonly signal: "SIGTERM" | "SIGKILL";
  readonly result: AppProcessSignalReceipt;
};

interface ServiceChildRecord {
  readonly generation: number;
  readonly source: string;
  readonly process: AppProcessLease;
  closed: boolean;
  exited: boolean;
  terminationRequested: boolean;
  quiesceHandlerDelivered: boolean;
  onQuiesce: (() => void) | undefined;
  terminationFlight: Promise<void> | undefined;
  finishTermination: (() => void) | undefined;
  killTimer: ReturnType<typeof setTimeout> | undefined;
  termAttempt: ServiceChildSignalAttempt | undefined;
  killAttempt: ServiceChildSignalAttempt | undefined;
}

export type ServiceChildIo = Omit<AppChildIo, "pidForDiagnostics">;

export interface ServiceChildLease {
  readonly generation: number;
  readonly io: ServiceChildIo;
  readonly requestTermination: () => Promise<void>;
  readonly terminateAndWaitForClose: () => Promise<boolean>;
  readonly onQuiesce: (handler: () => void) => void;
}

export interface ServiceChildSpawnSpec {
  readonly source: string;
  readonly purpose?: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
}

export interface ServiceChildShutdownStraggler {
  readonly generation: number;
  readonly source: string;
  readonly exited: boolean;
  readonly refusals: readonly {
    readonly signal: "SIGTERM" | "SIGKILL";
    readonly reason: string;
  }[];
}

export type ServiceChildQuiesceResult =
  | { readonly clean: true; readonly stragglers: readonly [] }
  | {
      readonly clean: false;
      readonly stragglers: readonly ServiceChildShutdownStraggler[];
    };

type RegistryEmptyWaiter = {
  readonly resolve: (clean: boolean) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

const serviceChildren = new Set<ServiceChildRecord>();
const registryEmptyWaiters = new Set<RegistryEmptyWaiter>();
let serviceChildrenQuiescing = false;
let serviceChildQuiesceFlight: Promise<ServiceChildQuiesceResult> | undefined;

export const assertServiceChildSpawnAllowed = (): void => {
  if (serviceChildrenQuiescing || appProcessPlane.isQuiescing()) {
    throw new Error(SERVICE_CHILD_PLANE_QUIESCING_ERROR);
  }
};

const assertServiceChildSourceSpawnAllowed = (source: string): void => {
  assertServiceChildSpawnAllowed();
  if (
    [...serviceChildren].some(
      (record) =>
        record.source === source &&
        record.terminationRequested &&
        !record.closed,
    )
  ) {
    throw new Error(SERVICE_CHILD_TEARDOWN_PENDING_ERROR);
  }
};

const finishTerminationPhase = (record: ServiceChildRecord): void => {
  if (record.killTimer !== undefined) {
    clearTimeout(record.killTimer);
    record.killTimer = undefined;
  }
  const finish = record.finishTermination;
  record.finishTermination = undefined;
  finish?.();
};

const notifyRegistryEmpty = (): void => {
  if (serviceChildren.size !== 0) return;
  for (const waiter of registryEmptyWaiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(true);
  }
  registryEmptyWaiters.clear();
};

const observeServiceChildExit = (record: ServiceChildRecord): void => {
  if (record.closed || record.exited) return;
  record.exited = true;
  // The leader is terminal. Do not issue a later exact-child signal, but keep
  // the registry entry until close proves all owned stdio endpoints drained.
  finishTerminationPhase(record);
};

const observeServiceChildClose = (record: ServiceChildRecord): void => {
  if (record.closed) return;
  record.closed = true;
  finishTerminationPhase(record);
  record.onQuiesce = undefined;
  serviceChildren.delete(record);
  notifyRegistryEmpty();
};

const signalServiceChild = (
  record: ServiceChildRecord,
  signal: "SIGTERM" | "SIGKILL",
): ServiceChildSignalAttempt => ({
  signal,
  result: signal === "SIGTERM"
    ? appProcessPlane.terminate(record.process, "service-operation-termination")
    : appProcessPlane.forceTerminate(record.process, "service-operation-termination"),
});

const requestServiceChildTermination = (
  record: ServiceChildRecord,
): Promise<void> => {
  if (record.closed) return Promise.resolve();
  record.terminationRequested = true;
  if (record.exited) return Promise.resolve();
  if (record.terminationFlight !== undefined) return record.terminationFlight;

  let finish!: () => void;
  const flight = new Promise<void>((resolve) => {
    finish = resolve;
  });
  // Publish the generation flight before invoking child.kill(), whose wrapper
  // may synchronously emit an error and re-enter requestTermination().
  record.terminationFlight = flight;
  record.finishTermination = finish;
  record.killTimer = setTimeout(() => {
    record.killTimer = undefined;
    if (!record.closed && !record.exited) {
      record.killAttempt = signalServiceChild(record, "SIGKILL");
    }
    finishTerminationPhase(record);
  }, SERVICE_CHILD_TERM_GRACE_MS);
  record.termAttempt = signalServiceChild(record, "SIGTERM");
  return flight;
};

const waitForServiceChildToClose = (
  record: ServiceChildRecord,
  timeoutMs: number,
): Promise<boolean> => {
  if (record.closed) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (clean: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(clean);
    };
    // Deliberately referenced: a success or quit receipt may not outrun the
    // terminal close witness it claims to have observed.
    const timer = setTimeout(() => finish(false), timeoutMs);
    void record.process.io.closed.then(
      () => finish(true),
      () => finish(false),
    );
  });
};

const terminateAndWaitForServiceChildClose = async (
  record: ServiceChildRecord,
): Promise<boolean> => {
  await requestServiceChildTermination(record);
  return waitForServiceChildToClose(record, SERVICE_CHILD_CLOSE_DRAIN_MS);
};

/**
 * Spawn an app-owned service operation through the central process plane.
 *
 * The returned facade contains streams and domain cancellation only. It never
 * exposes a ChildProcess, pid signal authority, or a low-level ownership mint.
 */
export const spawnServiceChild = (
  input: ServiceChildSpawnSpec,
): ServiceChildLease => {
  assertServiceChildSourceSpawnAllowed(input.source);
  const process = appProcessPlane.spawnChild({
    ...input,
    purpose: input.purpose ?? "service operation",
  });
  const record: ServiceChildRecord = {
    generation: process.generation,
    source: input.source,
    process,
    closed: false,
    exited: false,
    terminationRequested: false,
    quiesceHandlerDelivered: false,
    onQuiesce: undefined,
    terminationFlight: undefined,
    finishTermination: undefined,
    killTimer: undefined,
    termAttempt: undefined,
    killAttempt: undefined,
  };
  serviceChildren.add(record);
  process.io.onExit(() => observeServiceChildExit(record));
  process.io.onClose(() => observeServiceChildClose(record));

  const io: ServiceChildIo = Object.freeze({
    stdin: process.io.stdin,
    stdout: process.io.stdout,
    stderr: process.io.stderr,
    exited: process.io.exited,
    closed: process.io.closed,
    onExit: process.io.onExit,
    onClose: process.io.onClose,
    onError: process.io.onError,
  });

  return {
    generation: record.generation,
    io,
    requestTermination: () => requestServiceChildTermination(record),
    terminateAndWaitForClose: () =>
      terminateAndWaitForServiceChildClose(record),
    onQuiesce: (handler) => {
      if (record.closed) return;
      record.onQuiesce = handler;
      if (!serviceChildrenQuiescing || record.quiesceHandlerDelivered) return;
      record.quiesceHandlerDelivered = true;
      record.onQuiesce = undefined;
      try {
        handler();
      } catch {
        // Registry termination remains authoritative if operation cleanup errs.
      }
      void requestServiceChildTermination(record);
    },
  };
};

const waitForServiceChildrenToClose = (timeoutMs: number): Promise<boolean> => {
  if (serviceChildren.size === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const waiter: RegistryEmptyWaiter = {
      resolve,
      timer: setTimeout(() => {
        registryEmptyWaiters.delete(waiter);
        resolve(false);
      }, timeoutMs),
    };
    registryEmptyWaiters.add(waiter);
  });
};

const refusalFor = (
  attempt: ServiceChildSignalAttempt | undefined,
): ServiceChildShutdownStraggler["refusals"][number] | undefined => {
  if (attempt === undefined || attempt.result.attempted) return undefined;
  const reason = attempt.result.decision.ok
    ? "signal-not-attempted"
    : attempt.result.decision.reason;
  return { signal: attempt.signal, reason };
};

const summarizeServiceChildStraggler = (
  record: ServiceChildRecord,
): ServiceChildShutdownStraggler => ({
  generation: record.generation,
  source: record.source,
  exited: record.exited,
  refusals: [refusalFor(record.termAttempt), refusalFor(record.killAttempt)].filter(
    (value): value is NonNullable<typeof value> => value !== undefined,
  ),
});

export const quiesceServiceChildrenOnQuit = (): Promise<ServiceChildQuiesceResult> => {
  if (serviceChildQuiesceFlight !== undefined) return serviceChildQuiesceFlight;
  // Admission closes synchronously; physical work starts after the coalesced
  // promise is published so child callbacks may safely re-enter this API.
  serviceChildrenQuiescing = true;
  const flight: Promise<ServiceChildQuiesceResult> = Promise.resolve().then(async () => {
    const records = [...serviceChildren];
    for (const record of records) {
      const handler = record.onQuiesce;
      if (!record.quiesceHandlerDelivered && handler !== undefined) {
        record.quiesceHandlerDelivered = true;
        record.onQuiesce = undefined;
        try {
          handler();
        } catch {
          // The registry still owns and terminates the child generation.
        }
      }
    }
    await Promise.all(records.map(requestServiceChildTermination));
    if (await waitForServiceChildrenToClose(SERVICE_CHILD_CLOSE_DRAIN_MS)) {
      return { clean: true, stragglers: [] };
    }
    return {
      clean: false,
      stragglers: [...serviceChildren].map(summarizeServiceChildStraggler),
    };
  });
  serviceChildQuiesceFlight = flight;
  // Coalesce only active drain attempts. Admission remains monotonically
  // closed, while a later retry can observe stragglers that have since closed.
  void flight.then(
    () => {
      if (serviceChildQuiesceFlight === flight) serviceChildQuiesceFlight = undefined;
    },
    () => {
      if (serviceChildQuiesceFlight === flight) serviceChildQuiesceFlight = undefined;
    },
  );
  return flight;
};

export const runProcess = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  } = {},
): Promise<ProcessResult> => {
  try {
    assertServiceChildSpawnAllowed();
  } catch (error) {
    return Promise.reject(error);
  }
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_PROCESS_OUTPUT_LIMIT_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    return Promise.reject(new Error("maxOutputBytes must be a positive safe integer"));
  }

  return new Promise((resolve, reject) => {
    const lease = spawnServiceChild({
      source: `services.run-process:operation:${command}`,
      purpose: `run ${command}`,
      command,
      args,
      cwd: options.cwd,
      env: process.env,
    });
    const {
      stdin,
      stdout: stdoutStream,
      stderr: stderrStream,
    } = lease.io;

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let outputStopped = false;

    const ignoreClosedPipeError = (): void => {
      // A destroyed local pipe can still report its final asynchronous error.
    };

    const onStdoutData = (chunk: Buffer): void => {
      if (settled || outputStopped) return;
      const text = chunk.toString("utf8");
      const nextBytes = stdoutBytes + Buffer.byteLength(text);
      if (nextBytes > maxOutputBytes) {
        failOperation(
          new Error(`${command} stdout exceeded ${maxOutputBytes} bytes`),
        );
        return;
      }
      stdoutBytes = nextBytes;
      stdout += text;
    };

    const onStderrData = (chunk: Buffer): void => {
      if (settled || outputStopped) return;
      const text = chunk.toString("utf8");
      const nextBytes = stderrBytes + Buffer.byteLength(text);
      if (nextBytes > maxOutputBytes) {
        failOperation(
          new Error(`${command} stderr exceeded ${maxOutputBytes} bytes`),
        );
        return;
      }
      stderrBytes = nextBytes;
      stderr += text;
    };

    const stopOutput = (): void => {
      if (outputStopped) return;
      outputStopped = true;

      stdoutStream.off("data", onStdoutData);
      stdoutStream.off("error", onStdoutError);
      stdoutStream.on("error", ignoreClosedPipeError);
      stderrStream.off("data", onStderrData);
      stderrStream.off("error", onStderrError);
      stderrStream.on("error", ignoreClosedPipeError);

      try {
        stdoutStream.destroy();
      } catch {
        // The operation is already settled; local endpoint cleanup is best effort.
      }
      try {
        stderrStream.destroy();
      } catch {
        // The operation is already settled; local endpoint cleanup is best effort.
      }
    };

    const failOperation = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stopOutput();
      // Preserve the primary operation diagnostic, but do not return control
      // to a retrying caller until bounded teardown has produced its receipt.
      void lease.terminateAndWaitForClose().then(
        () => reject(error),
        () => reject(error),
      );
    };

    function onStdoutError(error: Error): void {
      failOperation(new Error(`${command} stdout stream failed: ${error.message}`));
    }

    function onStderrError(error: Error): void {
      failOperation(new Error(`${command} stderr stream failed: ${error.message}`));
    }

    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (settled) return;
            failOperation(new Error(`${command} timed out after ${options.timeoutMs}ms`));
          }, options.timeoutMs);

    stdoutStream.on("data", onStdoutData);
    stdoutStream.on("error", onStdoutError);
    stderrStream.on("data", onStderrData);
    stderrStream.on("error", onStderrError);

    lease.onQuiesce(() => {
      failOperation(new Error(SERVICE_CHILD_PLANE_QUIESCING_ERROR));
    });

    lease.io.onError((error) => {
      // ChildProcess "error" is not proof of process death (kill/send and
      // stream failures can emit it while the child is still alive). Reject
      // promptly, but retain exact-child authority through bounded teardown.
      failOperation(error);
    });

    // Match the former `stdin: "ignore"` contract: service commands receive
    // EOF and cannot remain alive waiting on an unused app-owned input pipe.
    // The central process plane keeps child errors contained; the unused pipe
    // needs its own sink because an asynchronous EPIPE is not a child event.
    stdin.on("error", ignoreClosedPipeError);
    try {
      stdin.end();
    } catch (error) {
      failOperation(
        error instanceof Error ? error : new Error(String(error)),
      );
    }

    lease.io.onClose(({ code }) => {
      if (settled) {
        stopOutput();
        return;
      }
      settled = true;
      if (timer) clearTimeout(timer);
      stopOutput();
      resolve({ code, stdout, stderr });
    });
  });
};
