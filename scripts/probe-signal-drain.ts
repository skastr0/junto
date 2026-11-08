/**
 * Turn an external runner signal into one orderly, capability-owned probe
 * drain.  Probe children may create their own process groups; allowing the
 * runner to take Node's default signal exit would orphan those descendants.
 */

export type ProbeShutdownSignal = "SIGHUP" | "SIGINT" | "SIGTERM";

export interface ProbeSignalSource {
  readonly on: (
    signal: ProbeShutdownSignal,
    listener: () => void,
  ) => unknown;
  readonly off: (
    signal: ProbeShutdownSignal,
    listener: () => void,
  ) => unknown;
}

export interface ProbeSignalDrainOptions {
  readonly finalize: (reason: string) => Promise<boolean>;
  readonly beforeDrain?: (signal: ProbeShutdownSignal) => void;
  readonly onFailure?: (
    signal: ProbeShutdownSignal,
    error: unknown,
  ) => void;
  readonly source?: ProbeSignalSource;
}

export interface ProbeSignalDrain {
  readonly request: (signal: ProbeShutdownSignal) => Promise<boolean>;
  readonly active: () => Promise<boolean> | undefined;
  readonly uninstall: () => void;
}

const SIGNALS: ReadonlyArray<ProbeShutdownSignal> = [
  "SIGHUP",
  "SIGINT",
  "SIGTERM",
];

export const installProbeSignalDrain = (
  options: ProbeSignalDrainOptions,
): ProbeSignalDrain => {
  const source = options.source ?? process;
  let flight: Promise<boolean> | undefined;
  let uninstalled = false;

  const request = (signal: ProbeShutdownSignal): Promise<boolean> => {
    if (flight !== undefined) return flight;
    options.beforeDrain?.(signal);
    const current = options.finalize(`probe-runner-${signal.toLowerCase()}`).catch(
      (error: unknown) => {
        options.onFailure?.(signal, error);
        return false;
      },
    );
    // Publish the one flight before any awaited finalizer callback can re-enter.
    flight = current;
    return current;
  };

  const listeners = new Map<ProbeShutdownSignal, () => void>();
  for (const signal of SIGNALS) {
    const listener = (): void => {
      void request(signal);
    };
    listeners.set(signal, listener);
    source.on(signal, listener);
  }

  return Object.freeze({
    request,
    active: () => flight,
    uninstall: () => {
      if (uninstalled) return;
      uninstalled = true;
      for (const [signal, listener] of listeners) {
        source.off(signal, listener);
      }
      listeners.clear();
    },
  });
};
