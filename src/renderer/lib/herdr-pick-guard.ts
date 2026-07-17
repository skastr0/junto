// Pure pick-coalescing core for the herdr attach wizard's row list — no refs,
// no DOM, unit-testable in isolation (the herdr-browse.ts pure-core precedent).
//
// A wizard row advances the step on POINTERDOWN (press, not release) so a pick
// feels instant. That creates two events to coalesce:
//   1. the trailing `click` of the same mouse press — which, after the list has
//      swapped to the next step, would land on a *different* row and must be
//      dropped;
//   2. a rapid repeat pick of the *same* row (double-tap / double-Enter).
// A keyboard activation (Enter/Space on a focused button) fires `click` with NO
// preceding pointerdown and MUST still run — and must never poison the pointer
// timestamp, or two back-to-back keyboard picks on different rows would drop the
// second.

/** Window (ms) within which a trailing click or same-row repeat pick coalesces. */
export const HERDR_PICK_WINDOW_MS = 700;

export interface HerdrPickGuardState {
  /** Time of the last pointerdown-driven pick (0 = none). Pointer picks only. */
  readonly lastPointerAt: number;
  /** Last picked row key + when, for same-row rapid-repeat coalescing. */
  readonly last: { readonly key: string; readonly at: number } | null;
}

export const initialHerdrPickGuard: HerdrPickGuardState = { lastPointerAt: 0, last: null };

export interface HerdrPickDecision {
  /** Whether the caller should run the row's action. */
  readonly run: boolean;
  readonly state: HerdrPickGuardState;
}

const sameRowRepeat = (state: HerdrPickGuardState, key: string, now: number, windowMs: number): boolean =>
  state.last != null && state.last.key === key && now - state.last.at < windowMs;

/**
 * A pointerdown-driven pick. Records the press time (so its own trailing click
 * is suppressed) and coalesces a rapid repeat pick of the same row.
 */
export const pickFromPointer = (
  state: HerdrPickGuardState,
  key: string,
  now: number,
  windowMs: number = HERDR_PICK_WINDOW_MS,
): HerdrPickDecision => {
  const withPointer = { ...state, lastPointerAt: now };
  if (sameRowRepeat(state, key, now, windowMs)) return { run: false, state: withPointer };
  return { run: true, state: { ...withPointer, last: { key, at: now } } };
};

/**
 * A click-driven pick. The trailing click of a recent mouse press is suppressed;
 * a click with no preceding pointerdown is keyboard-driven and still runs. A
 * keyboard pick never touches `lastPointerAt`, so back-to-back keyboard picks on
 * different rows both fire.
 */
export const pickFromClick = (
  state: HerdrPickGuardState,
  key: string,
  now: number,
  windowMs: number = HERDR_PICK_WINDOW_MS,
): HerdrPickDecision => {
  if (now - state.lastPointerAt < windowMs) return { run: false, state }; // tail of a pointer press
  if (sameRowRepeat(state, key, now, windowMs)) return { run: false, state };
  return { run: true, state: { ...state, last: { key, at: now } } };
};
