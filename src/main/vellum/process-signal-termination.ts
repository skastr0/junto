export const PROCESS_SIGNAL_EXIT_GRACE_MS = 5_000;

export type ProcessTerminationSignal = "SIGINT" | "SIGTERM";

export interface SignalTerminationApp {
  readonly quit: () => void;
  readonly exit: (exitCode?: number) => void;
}

export interface SignalTerminationProcess {
  readonly on: (signal: ProcessTerminationSignal, listener: () => void) => unknown;
  readonly off: (signal: ProcessTerminationSignal, listener: () => void) => unknown;
}

export interface ProcessSignalTerminationOptions {
  readonly app: SignalTerminationApp;
  readonly cleanup: (signal: ProcessTerminationSignal) => void;
  readonly processTarget?: SignalTerminationProcess;
  readonly exitGraceMs?: number;
}

export interface ProcessSignalTermination {
  readonly dispose: () => void;
  readonly requested: () => boolean;
}

const validatedExitGraceMs = (value: number | undefined): number => {
  if (value === undefined) return PROCESS_SIGNAL_EXIT_GRACE_MS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > PROCESS_SIGNAL_EXIT_GRACE_MS) {
    throw new RangeError("process signal exit grace must be a bounded positive integer");
  }
  return value;
};

/**
 * Converts Node process signals into an Electron quit request. Installing a
 * signal listener suppresses Node's default signal exit, so the bounded
 * `app.exit` fallback is part of the termination contract rather than an
 * optional cleanup aid.
 */
export const installProcessSignalTermination = (
  options: ProcessSignalTerminationOptions,
): ProcessSignalTermination => {
  const processTarget = options.processTarget ?? process;
  const exitGraceMs = validatedExitGraceMs(options.exitGraceMs);
  let disposed = false;
  let terminationRequested = false;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;

  const clearExitTimer = (): void => {
    if (exitTimer === undefined) return;
    clearTimeout(exitTimer);
    exitTimer = undefined;
  };

  const requestTermination = (signal: ProcessTerminationSignal): void => {
    if (disposed || terminationRequested) return;
    terminationRequested = true;

    try {
      options.cleanup(signal);
    } finally {
      exitTimer = setTimeout(() => {
        exitTimer = undefined;
        options.app.exit(0);
      }, exitGraceMs);
      exitTimer.unref?.();

      try {
        options.app.quit();
      } catch {
        clearExitTimer();
        options.app.exit(0);
      }
    }
  };

  const onSigterm = (): void => requestTermination("SIGTERM");
  const onSigint = (): void => requestTermination("SIGINT");
  processTarget.on("SIGTERM", onSigterm);
  processTarget.on("SIGINT", onSigint);

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearExitTimer();
      processTarget.off("SIGTERM", onSigterm);
      processTarget.off("SIGINT", onSigint);
    },
    requested: () => terminationRequested,
  };
};
