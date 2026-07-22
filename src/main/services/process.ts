import { spawn, type ChildProcess } from "node:child_process";
import {
  admitChildProcess,
  releaseOwned,
  signalOwned,
  type OwnedProcess,
  type SignalOwnedResult,
} from "../vellum/process-signal";

export interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export const SERVICE_CHILD_PLANE_QUIESCING_ERROR =
  "service process plane is shutting down";

const DEFAULT_PROCESS_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const SERVICE_CHILD_TERM_GRACE_MS = 1_000;
const SERVICE_CHILD_CLOSE_DRAIN_MS = 250;

type ServiceChildSignalAttempt = {
  readonly signal: "SIGTERM" | "SIGKILL";
  readonly result: SignalOwnedResult;
};

interface ServiceChildRecord {
  readonly generation: number;
  readonly source: string;
  readonly owned: OwnedProcess;
  closed: boolean;
  exited: boolean;
  quiesceHandlerDelivered: boolean;
  onQuiesce: (() => void) | undefined;
  terminationFlight: Promise<void> | undefined;
  finishTermination: (() => void) | undefined;
  killTimer: ReturnType<typeof setTimeout> | undefined;
  termAttempt: ServiceChildSignalAttempt | undefined;
  killAttempt: ServiceChildSignalAttempt | undefined;
}

export interface ServiceChildLease {
  readonly generation: number;
  readonly requestTermination: () => Promise<void>;
  readonly onQuiesce: (handler: () => void) => void;
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
let nextServiceChildGeneration = 1;
let serviceChildrenQuiescing = false;
let serviceChildQuiesceFlight: Promise<ServiceChildQuiesceResult> | undefined;

export const assertServiceChildSpawnAllowed = (): void => {
  if (serviceChildrenQuiescing) {
    throw new Error(SERVICE_CHILD_PLANE_QUIESCING_ERROR);
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
  releaseOwned(record.owned);
  serviceChildren.delete(record);
  notifyRegistryEmpty();
};

const signalServiceChild = (
  record: ServiceChildRecord,
  signal: "SIGTERM" | "SIGKILL",
): ServiceChildSignalAttempt => ({
  signal,
  result: signalOwned(record.owned, signal),
});

const requestServiceChildTermination = (
  record: ServiceChildRecord,
): Promise<void> => {
  if (record.closed || record.exited) return Promise.resolve();
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
  record.killTimer.unref?.();
  record.termAttempt = signalServiceChild(record, "SIGTERM");
  return flight;
};

/** @internal Capability lease used by service helpers after an owned spawn. */
export const registerServiceChild = (input: {
  readonly source: string;
  readonly child: ChildProcess;
}): ServiceChildLease => {
  assertServiceChildSpawnAllowed();
  const record: ServiceChildRecord = {
    generation: nextServiceChildGeneration++,
    source: input.source,
    owned: admitChildProcess({ source: input.source, child: input.child }),
    closed: false,
    exited: false,
    quiesceHandlerDelivered: false,
    onQuiesce: undefined,
    terminationFlight: undefined,
    finishTermination: undefined,
    killTimer: undefined,
    termAttempt: undefined,
    killAttempt: undefined,
  };
  serviceChildren.add(record);
  input.child.once("exit", () => observeServiceChildExit(record));
  input.child.once("close", () => observeServiceChildClose(record));
  // A ChildProcess error is not terminal, but it must always have a sink even
  // during the narrow interval before an operation installs diagnostics.
  input.child.on("error", () => undefined);

  return {
    generation: record.generation,
    requestTermination: () => requestServiceChildTermination(record),
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
    waiter.timer.unref?.();
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
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // runProcess owns this child for exactly one command invocation. The
    // capability contains only the ChildProcess handle: this helper never
    // acquires process-group authority and cannot signal an ambient pid.
    const lease = registerServiceChild({
      source: `services.run-process:operation:${command}`,
      child,
    });

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

      child.stdout?.off("data", onStdoutData);
      child.stdout?.off("error", onStdoutError);
      child.stdout?.on("error", ignoreClosedPipeError);
      child.stderr?.off("data", onStderrData);
      child.stderr?.off("error", onStderrError);
      child.stderr?.on("error", ignoreClosedPipeError);

      try {
        child.stdout?.destroy();
      } catch {
        // The operation is already settled; local endpoint cleanup is best effort.
      }
      try {
        child.stderr?.destroy();
      } catch {
        // The operation is already settled; local endpoint cleanup is best effort.
      }
    };

    const failOperation = (error: Error): void => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        stopOutput();
        reject(error);
      }
      void lease.requestTermination();
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

    child.stdout?.on("data", onStdoutData);
    child.stdout?.on("error", onStdoutError);
    child.stderr?.on("data", onStderrData);
    child.stderr?.on("error", onStderrError);

    lease.onQuiesce(() => {
      failOperation(new Error(SERVICE_CHILD_PLANE_QUIESCING_ERROR));
    });

    child.on("error", (error) => {
      // ChildProcess "error" is not proof of process death (kill/send and
      // stream failures can emit it while the child is still alive). Reject
      // promptly, but retain exact-child authority through bounded teardown.
      failOperation(error);
    });

    child.on("close", (code) => {
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
