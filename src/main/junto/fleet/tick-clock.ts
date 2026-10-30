/**
 * The host's tick source (0.12 T3, tech-lead on b7041101a): ticks counted
 * from elapsed time, not from timer callbacks. A timer that fires late, an
 * event loop that stalls and a Mac that sleeps all show up as periods that
 * passed, counted when the gap ends, so an authority never wakes still
 * counting itself fresh. Elapsed time is the larger of the monotonic and the
 * wall clock's deltas, never negative: the monotonic clock stops while macOS
 * sleeps, and the wall clock can be set back.
 */
export type TickClock = {
  /** The whole periods that passed since the last reading; the remainder carries to the next. */
  readonly periods: (monotonicMs: number, wallMs: number) => number;
};

export const makeTickClock = (periodMs: number, monotonicMs: number, wallMs: number): TickClock => {
  let lastMonotonic = monotonicMs;
  let lastWall = wallMs;
  let carried = 0;
  return {
    periods: (monotonic, wall) => {
      carried += Math.max(0, monotonic - lastMonotonic, wall - lastWall);
      lastMonotonic = monotonic;
      lastWall = wall;
      const whole = Math.floor(carried / periodMs);
      carried -= whole * periodMs;
      return whole;
    },
  };
};
