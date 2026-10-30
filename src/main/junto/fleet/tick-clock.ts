/**
 * The host's tick source (0.12 T3, tech-lead on b7041101a and dedaf4b3e):
 * ticks counted from elapsed time, not from timer callbacks, so a timer that
 * fires late or an event loop that stalls shows up as periods that passed,
 * counted when the gap ends. Two counts, for the core's two sides:
 *
 * - `lease`: the larger of the monotonic and the wall clock's deltas, never
 *   negative. The monotonic clock stops while macOS sleeps, so an authority
 *   that wakes counts the sleep by the wall and its lease is over; a wall
 *   clock stepped forward only ends a lease early.
 * - `election`: the monotonic delta alone. A follower that over-counted would
 *   stand inside its authority's lease, so a wall step never counts here; a
 *   sleeping follower under-counts and stands later, which is safe.
 */
export type TickCounts = { readonly lease: number; readonly election: number };

export type TickClock = {
  /** The whole periods each side counted since the last reading; the remainders carry to the next. */
  readonly periods: (monotonicMs: number, wallMs: number) => TickCounts;
};

export const makeTickClock = (periodMs: number, monotonicMs: number, wallMs: number): TickClock => {
  let lastMonotonic = monotonicMs;
  let lastWall = wallMs;
  let leaseCarried = 0;
  let electionCarried = 0;
  return {
    periods: (monotonic, wall) => {
      const monotonicDelta = Math.max(0, monotonic - lastMonotonic);
      leaseCarried += Math.max(monotonicDelta, wall - lastWall);
      electionCarried += monotonicDelta;
      lastMonotonic = monotonic;
      lastWall = wall;
      const lease = Math.floor(leaseCarried / periodMs);
      const election = Math.floor(electionCarried / periodMs);
      leaseCarried -= lease * periodMs;
      electionCarried -= election * periodMs;
      return { lease, election };
    },
  };
};
