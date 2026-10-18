/**
 * Whether a seat's settings are fixed and what its next turn does
 * (modelSeatLaunchState), as it crosses the seats channel from the machine that runs the seat to the
 * machine that edits its canvas: on each state the seat's machine forwards,
 * and on Get's Vacant for a seat with no occupant. With it goes the seat's
 * cache window as that machine's offboard clock and rules read it, which the
 * receiver's offboard row and card for the seat show; it never drives a cut
 * there.
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
import { seatCacheWindow } from "@shared/seat-next-launch";
import { CACHE_MODES, OFFBOARD_MINUTES_MAX, OFFBOARD_MINUTES_MIN } from "@shared/seat-offboard";
import type { SeatOffboardFacts } from "../seat-sessions/operator-offboard";

/** What a seat on its own machine answers about its settings and its next turn. */
export type SeatLaunchState = Awaited<ReturnType<JuntoApi["modelSeatLaunchState"]>>;

/** The launch state as the machine that edits the seat's canvas holds it, with the seat's cache window. */
export type RemoteSeatLaunch = SeatLaunchState & { readonly offboard?: SeatOffboardFacts };

/** The longest a still session stays warm: the cache window's own bound. */
export const FRESH_IN_MAX_MS = OFFBOARD_MINUTES_MAX * 60_000;

/** The longest ago a seat's last activity is told: anything older reads the same on a card. */
export const ACTIVITY_AGO_MAX_MS = 7 * 24 * 60 * 60_000;

/** The most work time told for one session: anything longer reads the same on a card. */
export const SESSION_WORK_MAX_MS = 7 * 24 * 60 * 60_000;

/** The largest transcript told, in tokens: far past any harness's context. */
export const SESSION_TOKENS_MAX = 100_000_000;

/** A whole number from `min` to `max`. */
const BoundedInt = (min: number, max: number) =>
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: min, maximum: max })));

/** A duration from 0 to `max`, whole milliseconds. */
export const BoundedMs = (max: number) => BoundedInt(0, max);

/** `ms` clamped into 0 to `max`, whole. */
export const clampMs = (ms: number, max: number): number =>
  Number.isFinite(ms) ? Math.min(max, Math.max(0, Math.round(ms))) : 0;

export const SeatsLaunchState = Schema.Struct({
  /** The seat picks up where it was, so the settings it started with hold. */
  settingsFixed: Schema.Boolean,
  nextTurn: Schema.optionalKey(Schema.Struct({
    fresh: Schema.Boolean,
    /** While the turn continues: how long until the session goes cold if nothing moves. */
    freshInMs: Schema.optionalKey(BoundedMs(FRESH_IN_MAX_MS)),
  })),
  /** The seat's cache window, as its machine's offboard clock and rules read it. */
  offboard: Schema.optionalKey(Schema.Struct({
    /** How long the seat has been at rest. Absent while it is not. */
    stillForMs: Schema.optionalKey(BoundedMs(ACTIVITY_AGO_MAX_MS)),
    windowMinutes: BoundedInt(OFFBOARD_MINUTES_MIN, OFFBOARD_MINUTES_MAX),
    /** That machine's cache mode: for the card's warning only. */
    cacheMode: Schema.optionalKey(Schema.Literals(CACHE_MODES)),
    workMs: BoundedMs(SESSION_WORK_MAX_MS),
    tokens: Schema.optionalKey(BoundedInt(0, SESSION_TOKENS_MAX)),
    worth: Schema.Boolean,
  })),
});
export type SeatsLaunchState = typeof SeatsLaunchState.Type;

export const decodeSeatsLaunch = Schema.decodeUnknownSync(SeatsLaunchState, { onExcessProperty: "error" });

/** `value` clamped into `min` to `max`, whole. */
const clampInt = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : min;

/** The launch state as it crosses, measured at `now` on the seat's machine. */
export const toSeatsLaunch = (launch: SeatLaunchState, now: number, offboard?: SeatOffboardFacts): SeatsLaunchState => {
  const turn = launch.nextTurn;
  return {
    settingsFixed: launch.settingsFixed,
    ...(turn === undefined
      ? {}
      : {
          nextTurn: {
            fresh: turn.fresh,
            ...(turn.freshAt === undefined ? {} : { freshInMs: clampMs(turn.freshAt - now, FRESH_IN_MAX_MS) }),
          },
        }),
    ...(offboard === undefined
      ? {}
      : {
          offboard: {
            ...(offboard.stillSince === undefined ? {} : { stillForMs: clampMs(now - offboard.stillSince, ACTIVITY_AGO_MAX_MS) }),
            windowMinutes: clampInt(offboard.windowMinutes, OFFBOARD_MINUTES_MIN, OFFBOARD_MINUTES_MAX),
            ...(offboard.cacheMode === undefined ? {} : { cacheMode: offboard.cacheMode }),
            workMs: clampMs(offboard.workMs, SESSION_WORK_MAX_MS),
            ...(offboard.tokens === undefined ? {} : { tokens: clampInt(offboard.tokens, 0, SESSION_TOKENS_MAX) }),
            worth: offboard.worth,
          },
        }),
  };
};

/** The launch state as the receiving machine holds it, on its own clock at `now`. */
export const fromSeatsLaunch = (wire: SeatsLaunchState, now: number): RemoteSeatLaunch => {
  const turn = wire.nextTurn;
  const offboard = wire.offboard;
  return {
    settingsFixed: wire.settingsFixed,
    ...(turn === undefined
      ? {}
      : {
          nextTurn: {
            fresh: turn.fresh,
            ...(turn.freshInMs === undefined ? {} : { freshAt: now + turn.freshInMs }),
          },
        }),
    ...(offboard === undefined
      ? {}
      : {
          offboard: {
            ...(offboard.stillForMs === undefined ? {} : { stillSince: now - offboard.stillForMs }),
            windowMinutes: offboard.windowMinutes,
            ...(offboard.cacheMode === undefined ? {} : { cacheMode: offboard.cacheMode }),
            workMs: offboard.workMs,
            ...(offboard.tokens === undefined ? {} : { tokens: offboard.tokens }),
            worth: offboard.worth,
          },
        }),
  };
};

/**
 * What the card is told: the launch state, and the seat against its cache
 * window, built here at `now` from what the seat's machine said of it. The
 * window itself never crosses: the seat's machine sends the facts, and this
 * clock reads them.
 */
export const cardSeatLaunch = (launch: RemoteSeatLaunch, now: number): SeatLaunchState => {
  const cacheWindow = launch.offboard && seatCacheWindow(launch.nextTurn, launch.offboard, now);
  return {
    settingsFixed: launch.settingsFixed,
    ...(launch.nextTurn === undefined ? {} : { nextTurn: launch.nextTurn }),
    ...(cacheWindow === undefined ? {} : { cacheWindow }),
  };
};
