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
  /** Reject to cancel this attempt and allow a later signal to retry. */
  readonly cleanup: (signal: ProcessTerminationSignal) => void | Promise<void>;
  readonly processTarget?: SignalTerminationProcess;
  readonly exitGraceMs?: number;
  /**
   * `app.exit()` bypasses Electron's quit events. The fallback may therefore
   * fire only after the caller's durability/teardown boundary is complete.
   * Defaults to true for callers without a separate boundary.
   */
  readonly allowForceExit?: () => boolean;
}

export interface ProcessSignalTermination {
  readonly dispose: () => void;
  /** Revoke the current attempt without uninstalling signal listeners. */
  readonly cancel: () => void;
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
  let attemptGeneration = 0;
  let activeAttempt: number | undefined;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;

  const clearExitTimer = (): void => {
    if (exitTimer === undefined) return;
    clearTimeout(exitTimer);
    exitTimer = undefined;
  };

  const cancelActiveAttempt = (): void => {
    attemptGeneration += 1;
    activeAttempt = undefined;
    clearExitTimer();
  };

  const forceExitWhenSafe = (generation: number): void => {
    exitTimer = undefined;
    if (disposed || activeAttempt !== generation) return;
    let allowed = false;
    try {
      allowed = options.allowForceExit?.() ?? true;
    } catch {
      // A broken safety predicate can never authorize a bypass exit.
    }
    if (allowed) {
      options.app.exit(0);
      return;
    }
    // Keep the fallback live, but never let its time budget outrank the
    // caller's durability boundary. Once that boundary completes, the next
    // bounded tick can terminate a native loop that ignored app.quit().
    exitTimer = setTimeout(() => forceExitWhenSafe(generation), exitGraceMs);
  };

  const requestTermination = (signal: ProcessTerminationSignal): void => {
    if (disposed || activeAttempt !== undefined) return;
    const generation = ++attemptGeneration;
    activeAttempt = generation;

    void Promise.resolve()
      .then(() => options.cleanup(signal))
      .then(
        () => {
          if (disposed || activeAttempt !== generation) return;
          exitTimer = setTimeout(() => forceExitWhenSafe(generation), exitGraceMs);
          // This is the mandatory bound on an Electron native loop that ignores
          // app.quit(). Keep it referenced after successful cleanup removes the
          // final adapter/Chromium Node handle.
          try {
            options.app.quit();
          } catch {
            // The referenced fallback remains responsible for exit. Never
            // bypass a durability gate because app.quit threw.
          }
        },
        () => {
          if (disposed || activeAttempt !== generation) return;
          clearExitTimer();
          activeAttempt = undefined;
        },
      );
  };

  const onSigterm = (): void => requestTermination("SIGTERM");
  const onSigint = (): void => requestTermination("SIGINT");
  processTarget.on("SIGTERM", onSigterm);
  processTarget.on("SIGINT", onSigint);

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelActiveAttempt();
      processTarget.off("SIGTERM", onSigterm);
      processTarget.off("SIGINT", onSigint);
    },
    cancel: () => {
      if (disposed) return;
      cancelActiveAttempt();
    },
    requested: () => activeAttempt !== undefined,
  };
};
