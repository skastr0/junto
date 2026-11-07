/**
 * Per-phase quit timing. Observation only: it never gates, bounds, or reorders
 * the quit sequence. One `[quit]` line per phase, each carrying the elapsed
 * time since the first quit event and the phase's own duration.
 */
export interface QuitPhaseLog {
  /** Record a point event (signal received, before-quit, will-quit). */
  readonly mark: (event: string) => void;
  /** Close a sequential phase that ran since the previous logged event. */
  readonly lap: (phase: string) => void;
  /** Time an awaited phase; logs on success and failure alike. */
  readonly time: <A>(phase: string, work: () => Promise<A>) => Promise<A>;
}

export const createQuitPhaseLog = (
  write: (line: string) => void = (line) => console.log(line),
  now: () => number = () => performance.now(),
): QuitPhaseLog => {
  let origin: number | undefined;
  let previous: number | undefined;
  const elapsed = (at: number): number => {
    origin ??= at;
    return Math.round(at - origin);
  };
  const emit = (line: string): void => {
    try {
      write(line);
    } catch {
      // Logging must never change quit behavior.
    }
  };

  return {
    mark: (event) => {
      const at = now();
      previous = at;
      emit(`[quit] +${elapsed(at)}ms ${event}`);
    },
    lap: (phase) => {
      const at = now();
      const since = previous ?? at;
      previous = at;
      emit(`[quit] +${elapsed(since)}ms ${phase} done in ${Math.round(at - since)}ms`);
    },
    time: async (phase, work) => {
      const start = now();
      const offset = elapsed(start);
      let outcome = "failed";
      try {
        const value = await work();
        outcome = "done";
        return value;
      } finally {
        previous = now();
        emit(`[quit] +${offset}ms ${phase} ${outcome} in ${Math.round(previous - start)}ms`);
      }
    },
  };
};
