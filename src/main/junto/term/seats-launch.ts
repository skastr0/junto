/**
 * What a seat's next start and next turn do (modelSeatLaunchState), as it
 * crosses the seats channel from the machine that runs the seat to the
 * machine that edits its canvas: on each state the seat's machine forwards,
 * and on Get's Vacant for a seat with no occupant.
 *
 * Advisory: the receiving machine shows it and never sends it back. A start's
 * resume is decided on the seat's machine.
 *
 * Times cross as durations, measured when the seat's machine sends and read
 * against the receiver's own clock on arrival, so a skewed clock never
 * changes what a card says. Each duration has a named bound: the sender
 * clamps to it and the closed schema refuses anything over it.
 */
import { Schema } from "effect";
import type { JuntoApi } from "@shared/ipc";
import { SEAT_NEXT_LAUNCHES } from "@shared/seat-next-launch";
import { OFFBOARD_MINUTES_MAX } from "@shared/seat-offboard";

/** What a seat on its own machine answers about its next start and turn. */
export type SeatLaunchState = Awaited<ReturnType<JuntoApi["modelSeatLaunchState"]>>;

/** The longest a still session stays warm: the cache window's own bound. */
export const FRESH_IN_MAX_MS = OFFBOARD_MINUTES_MAX * 60_000;

/** The longest ago a seat's last activity is told: anything older reads the same on a card. */
export const ACTIVITY_AGO_MAX_MS = 7 * 24 * 60 * 60_000;

/** A duration from 0 to `max`, whole milliseconds. */
export const BoundedMs = (max: number) =>
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: max })));

/** `ms` clamped into 0 to `max`, whole. */
export const clampMs = (ms: number, max: number): number =>
  Number.isFinite(ms) ? Math.min(max, Math.max(0, Math.round(ms))) : 0;

export const SeatsLaunchState = Schema.Struct({
  hasSession: Schema.Boolean,
  next: Schema.Literals(SEAT_NEXT_LAUNCHES),
  nextTurn: Schema.optionalKey(Schema.Struct({
    fresh: Schema.Boolean,
    /** While the turn continues: how long until the session goes cold if nothing moves. */
    freshInMs: Schema.optionalKey(BoundedMs(FRESH_IN_MAX_MS)),
  })),
});
export type SeatsLaunchState = typeof SeatsLaunchState.Type;

export const decodeSeatsLaunch = Schema.decodeUnknownSync(SeatsLaunchState, { onExcessProperty: "error" });

/** The launch state as it crosses, measured at `now` on the seat's machine. */
export const toSeatsLaunch = (launch: SeatLaunchState, now: number): SeatsLaunchState => {
  const turn = launch.nextTurn;
  return {
    hasSession: launch.hasSession,
    next: launch.next,
    ...(turn === undefined
      ? {}
      : {
          nextTurn: {
            fresh: turn.fresh,
            ...(turn.freshAt === undefined ? {} : { freshInMs: clampMs(turn.freshAt - now, FRESH_IN_MAX_MS) }),
          },
        }),
  };
};

/** The launch state as the receiving machine holds it, on its own clock at `now`. */
export const fromSeatsLaunch = (wire: SeatsLaunchState, now: number): SeatLaunchState => {
  const turn = wire.nextTurn;
  return {
    hasSession: wire.hasSession,
    next: wire.next,
    ...(turn === undefined
      ? {}
      : {
          nextTurn: {
            fresh: turn.fresh,
            ...(turn.freshInMs === undefined ? {} : { freshAt: now + turn.freshInMs }),
          },
        }),
  };
};
