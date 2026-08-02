import { Schema } from "effect";

// Seat occupancy spectrum — LIVE, DERIVED, never stored on the canvas.
//
// Pure function of process-bind occupancy + optional harness activity +
// heartbeat + operator flags. Missing optional inputs invent NOTHING: no
// phantom work, no phantom stall, no phantom "gone".
//
// Architecture: docs/architecture-factory-physics.md §4 (seats vs occupants).
// Related but separate: region-rollup MemberSeverity (operational tier).
//
// ---------------------------------------------------------------------------
// Vacancy (!hasOccupant)
// ---------------------------------------------------------------------------
//   lastSeenAtMs defined  → gone   former occupant exited; vacant until rebind
//   lastSeenAtMs absent   → empty  seat never occupied / re-baselined cold
//
// ---------------------------------------------------------------------------
// Occupied (first match wins)
// ---------------------------------------------------------------------------
//   1. flags.parked                          → parked
//      Intentional hold owns the seat story; suppresses other live signals.
//   2. harness === "blocked"                 → activity_blocked
//      Bound but activity plane says blocked (criteria / deps / harness).
//   3. flags.attention | harness "attention" → attention
//      Needs operator input (permission, review, focus).
//   4. lastSeen stale (> stallAfterMs)       → stalled
//      Expected progress / heartbeat missing. Requires lastSeenAtMs; absent
//      lastSeen never invents stall. Default stallAfterMs = 24h.
//   5. harness === "working"                 → working
//      Active task / session in flight.
//   6. otherwise                             → idle
//      Bound; no elevating harness/flags/stall signal.
//
// Harness "idle" | "unknown" | undefined never elevates above idle.
//
// Later main plug (optional, not required for this module): process-bind
// registry → hasOccupant + lastSeenAtMs; WorkSurfaceActivity / ACP / herdr →
// activity.harness; canvas ether.flags → flags.parked | flags.attention.
// See src/main/vellum/region-rollup.ts for an existing live-activity gatherer.

/** Default heartbeat gap before a bound seat is considered stalled (24h). */
export const DEFAULT_STALL_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Live occupancy spectrum for a seat.
 * Never authorial; never persisted as document truth.
 */
export const OccupancySpectrum = Schema.Literals(["empty", "idle",
"working",
"attention",
"activity_blocked",
"stalled",
"parked",
"gone",]);
export type OccupancySpectrum = typeof OccupancySpectrum.Type;

/**
 * Optional harness activity vocabulary (mirrors TerminalHarnessState).
 * Kept local so occupancy stays free of terminal/runtime imports.
 */
export const OccupancyHarnessState = Schema.Literals(["idle", "working",
"blocked",
"attention",
"unknown",]);
export type OccupancyHarnessState = typeof OccupancyHarnessState.Type;

export const OccupancyActivity = Schema.Struct({
  harness: Schema.optionalKey(OccupancyHarnessState),
});
export type OccupancyActivity = typeof OccupancyActivity.Type;

export const OccupancyFlags = Schema.Struct({
  parked: Schema.optionalKey(Schema.Boolean),
  attention: Schema.optionalKey(Schema.Boolean),
});
export type OccupancyFlags = typeof OccupancyFlags.Type;

export interface DeriveOccupancyInput {
  /** True when a live process is bound to the seat (process-bind). */
  readonly hasOccupant: boolean;
  /** Optional harness activity. Absent invents no work/block/attention. */
  readonly activity?: OccupancyActivity;
  /** Last heartbeat / progress observation (epoch ms). Absent invents no stall/gone. */
  readonly lastSeenAtMs?: number;
  /** Clock for stall comparison (epoch ms). Caller supplies; keeps this pure. */
  readonly nowMs: number;
  /** Stall threshold. Defaults to DEFAULT_STALL_AFTER_MS (24h). */
  readonly stallAfterMs?: number;
  /** Operator / document flags that feed attention and park (not authority). */
  readonly flags?: OccupancyFlags;
}

/**
 * Derive the occupancy spectrum for one seat from live inputs.
 * Pure: no I/O, no document mutation, no global clock.
 */
export const deriveOccupancy = (input: DeriveOccupancyInput): OccupancySpectrum => {
  const {
    hasOccupant,
    activity,
    lastSeenAtMs,
    nowMs,
    stallAfterMs = DEFAULT_STALL_AFTER_MS,
    flags,
  } = input;

  if (!hasOccupant) {
    // Vacancy: lastSeen is the only signal that a former occupant existed.
    return lastSeenAtMs !== undefined ? "gone" : "empty";
  }

  // 1. Parked — intentional hold.
  if (flags?.parked === true) return "parked";

  const harness = activity?.harness;

  // 2. Activity blocked.
  if (harness === "blocked") return "activity_blocked";

  // 3. Attention (flag or harness).
  if (flags?.attention === true || harness === "attention") return "attention";

  // 4. Stalled — heartbeat gap (only when lastSeen is known).
  if (
    lastSeenAtMs !== undefined &&
    nowMs - lastSeenAtMs > stallAfterMs
  ) {
    return "stalled";
  }

  // 5. Working.
  if (harness === "working") return "working";

  // 6. Idle (bound, quiet).
  return "idle";
};
