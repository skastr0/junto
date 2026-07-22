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

export type SignalQuitPhase =
  | "idle"
  | "preparing"
  | "terminal-clean"
  | "renderer-gate-quiesced"
  | "canvas-durable"
  | "renderer-quiesced"
  | "force-authorized"
  | "runtime-detached";

export type SignalQuitFailureDisposition = "recover" | "retry" | "finish" | "stale";

export interface SignalQuitState {
  readonly begin: () => number;
  readonly markTerminalClean: (generation: number) => void;
  /** Record a failed handshake that nevertheless closed renderer admission. */
  readonly markRendererGateQuiesced: (generation: number) => void;
  readonly markCanvasDurable: (generation: number) => void;
  readonly markRendererQuiesced: (generation: number) => void;
  readonly authorizeForceExit: (generation: number) => void;
  readonly markRuntimeDetached: (generation: number) => void;
  readonly fail: (generation: number) => SignalQuitFailureDisposition;
  readonly isCurrent: (generation: number) => boolean;
  readonly rendererQuiesced: () => boolean;
  readonly forceExitAllowed: () => boolean;
  readonly reusableDurabilityGeneration: () => number | undefined;
  readonly snapshot: () => Readonly<{
    generation: number;
    phase: SignalQuitPhase;
  }>;
}

export interface QuitPreparationArbiter {
  /** Returns an epoch, or refuses while signal durability is still precommit. */
  readonly beginNormal: () => number | undefined;
  /** Atomically blocks new normal preparation and invalidates old continuations. */
  readonly claimSignal: () => void;
  readonly commitSignal: () => void;
  readonly recoverSignal: () => void;
  readonly signalPrecommit: () => boolean;
  readonly normalMayDetach: (generation: number) => boolean;
}

/** Serializes normal Electron quit continuations against signal finality. */
export const createQuitPreparationArbiter = (): QuitPreparationArbiter => {
  let normalGeneration = 0;
  let signalPhase: "idle" | "precommit" | "committed" = "idle";

  return {
    beginNormal: () => {
      if (signalPhase === "precommit") return undefined;
      normalGeneration += 1;
      return normalGeneration;
    },
    claimSignal: () => {
      if (signalPhase !== "idle") {
        throw new Error(`signal already owns quit in phase ${signalPhase}`);
      }
      signalPhase = "precommit";
      // Promise continuations retain their epoch. Bumping here makes every
      // normal flush/terminal continuation fail closed before runtime detach.
      normalGeneration += 1;
    },
    commitSignal: () => {
      if (signalPhase !== "precommit") {
        throw new Error(`cannot commit signal quit from phase ${signalPhase}`);
      }
      signalPhase = "committed";
    },
    recoverSignal: () => {
      if (signalPhase !== "precommit") {
        throw new Error(`cannot recover signal quit from phase ${signalPhase}`);
      }
      signalPhase = "idle";
    },
    signalPrecommit: () => signalPhase === "precommit",
    normalMayDetach: (generation) =>
      signalPhase !== "precommit" && generation === normalGeneration,
  };
};

/**
 * Generation-scoped commit boundary for signal-driven quit.
 *
 * Before the renderer is synchronously quiesced, a failed attempt may restore
 * the UI and retry. Once quiesced, the final canvas acknowledgement cannot be
 * invalidated by new authoring, so recovery would create a half-torn runtime;
 * failures instead retain force-exit authority and finish the bounded exit.
 */
export const createSignalQuitState = (): SignalQuitState => {
  let generation = 0;
  let phase: SignalQuitPhase = "idle";
  let rendererGateQuiesced = false;

  const advance = (
    attemptedGeneration: number,
    expected: SignalQuitPhase,
    next: SignalQuitPhase,
  ): void => {
    if (attemptedGeneration !== generation || phase !== expected) {
      throw new Error(
        `invalid signal quit transition ${phase} -> ${next} for generation ${attemptedGeneration}`,
      );
    }
    phase = next;
  };

  const rendererQuiesced = (): boolean => rendererGateQuiesced;

  const forceExitAllowed = (): boolean =>
    phase === "force-authorized" || phase === "runtime-detached";

  return {
    begin: () => {
      if (phase !== "idle") {
        throw new Error(`signal quit attempt already active in phase ${phase}`);
      }
      generation += 1;
      phase = "preparing";
      return generation;
    },
    markTerminalClean: (attemptedGeneration) =>
      advance(attemptedGeneration, "preparing", "terminal-clean"),
    markRendererGateQuiesced: (attemptedGeneration) => {
      advance(attemptedGeneration, "terminal-clean", "renderer-gate-quiesced");
      rendererGateQuiesced = true;
    },
    markCanvasDurable: (attemptedGeneration) => {
      advance(attemptedGeneration, "terminal-clean", "canvas-durable");
      // A successful signal handshake means the renderer closed mutation
      // admission and drained every admitted write before acknowledging.
      rendererGateQuiesced = true;
    },
    markRendererQuiesced: (attemptedGeneration) =>
      advance(attemptedGeneration, "canvas-durable", "renderer-quiesced"),
    authorizeForceExit: (attemptedGeneration) =>
      advance(attemptedGeneration, "renderer-quiesced", "force-authorized"),
    markRuntimeDetached: (attemptedGeneration) =>
      advance(attemptedGeneration, "force-authorized", "runtime-detached"),
    fail: (attemptedGeneration) => {
      if (attemptedGeneration !== generation || phase === "idle") return "stale";
      if (
        phase === "canvas-durable" ||
        phase === "renderer-quiesced" ||
        phase === "force-authorized" ||
        phase === "runtime-detached"
      ) {
        // Quiescence is the irreversible boundary. Promote an interruption
        // between renderer destruction and explicit authorization so cleanup
        // can resolve and arm the same bounded fallback.
        if (phase === "canvas-durable" || phase === "renderer-quiesced") {
          phase = "force-authorized";
        }
        return "finish";
      }
      if (rendererGateQuiesced) {
        // Admission closed but the save pump did not acknowledge durability.
        // Keep the gate monotonic, permit a fresh signal generation to retry
        // the same drain, and never recreate an authoring surface.
        phase = "idle";
        return "retry";
      }
      phase = "idle";
      return "recover";
    },
    isCurrent: (attemptedGeneration) =>
      attemptedGeneration === generation && phase !== "idle",
    rendererQuiesced,
    forceExitAllowed,
    reusableDurabilityGeneration: () => forceExitAllowed() ? generation : undefined,
    snapshot: () => ({ generation, phase }),
  };
};

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
