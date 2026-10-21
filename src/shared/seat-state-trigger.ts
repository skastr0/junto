/**
 * Seat-state triggers: which seat states an automation may fire on, and when.
 *
 * Raw seat states are not stable enough to fire on. Working to idle holds
 * 700 ms for the rings, attention re-publishes every 800 ms, `unknown` opens
 * every generation, and `gone` is published on every generation exit,
 * including a cache cut. This module folds the AgentSeatStateEvent stream
 * into firings an automation runner can act on (07-automations.md, runner
 * rules, owned by pty):
 *
 * - Only a change of settled state fires. Each firing is keyed by seat and
 *   generation (epoch). A new epoch drops the old one's hold, pending gone
 *   and attention episode, and keeps its settled state: a cache cut that
 *   comes back idle never left idle, so it fires nothing. An event with no
 *   epoch never stands for a new generation.
 * - `unknown` neither fires nor resets a hold.
 * - `idle` and `working` fire once they have held for 30 s. Any other known
 *   state cancels the hold; the same state re-published keeps it.
 * - `attention` fires at once, once per episode. An episode ends when the
 *   seat publishes idle, working or gone; its 800 ms re-publish is not a new
 *   episode.
 * - `gone` fires 60 s after it is published, unless the same seat binds a
 *   generation with a new epoch first.
 * - A draining session (`seat-drain.ts`) is not a seat and never fires.
 * - Events of a generation that has been replaced, or that has gone, are
 *   late and ignored.
 *
 * Pure: time comes only from events' `at` and from `Tick`s, so the runner
 * drives it from the kernel tick and asks `nextSeatTriggerDue` when to wake.
 */
import { Option, Schema } from "effect";
import type { AgentSeatStateEvent } from "./agent-seat-state";
import { SeatBecomes } from "./automation";
import { isDrainKey } from "./seat-drain";

/** How long idle or working must hold before it fires. */
export const SEAT_TRIGGER_HOLD_MS = 30_000;
/** How long a gone seat waits for its next generation before gone fires. */
export const SEAT_TRIGGER_GONE_GRACE_MS = 60_000;
/** Replaced epochs remembered per seat, to drop their late events. */
const RETIRED_EPOCHS = 16;

/** A state a seat trigger fires on: every seat state but `unknown`, as an automation's seat watch names it. */
export const SeatTriggerState = SeatBecomes;
export type SeatTriggerState = typeof SeatTriggerState.Type;

/** A seat's binding id, never a drain key. */
export const SeatKey = Schema.String.pipe(
  Schema.check(Schema.makeFilter((key: string) => !isDrainKey(key) || "a draining session is not a seat")),
  Schema.brand("SeatKey"),
);
export type SeatKey = typeof SeatKey.Type;

const decodeSeatKey = Schema.decodeUnknownOption(SeatKey);

/** The seat a binding id names; none for a drain key. */
export const seatKeyOf = (bindingId: string): Option.Option<SeatKey> => decodeSeatKey(bindingId);

/** One firing's identity: seat, epoch, state and when that state began. A runner claims it once. */
export const SeatFiringKey = Schema.String.pipe(Schema.brand("SeatFiringKey"));
export type SeatFiringKey = typeof SeatFiringKey.Type;

export const SeatStateFiring = Schema.Struct({
  key: SeatFiringKey,
  seat: SeatKey,
  epoch: Schema.String,
  becomes: SeatTriggerState,
  /** When the seat entered the state. */
  since: Schema.Number,
  /** When it fired: `since` for attention, after the hold or the grace otherwise. */
  at: Schema.Number,
  /** The reason the event that entered the state gave. */
  reason: Schema.String,
});
export type SeatStateFiring = typeof SeatStateFiring.Type;

export type SeatTriggerInput =
  | { readonly _tag: "Event"; readonly event: AgentSeatStateEvent }
  | { readonly _tag: "Tick"; readonly now: number };

type Pending = { readonly becomes: SeatTriggerState; readonly since: number; readonly reason: string };

type SeatTrack = {
  readonly epoch: string;
  /** The settled state of this epoch; absent until one settles. */
  readonly settled?: SeatTriggerState;
  /** Idle or working waiting out its hold, or gone waiting out its grace. */
  readonly pending?: Pending;
  readonly inAttention: boolean;
  /** Epochs this seat has moved past, newest last. */
  readonly retired: readonly string[];
};

export type SeatTriggers = {
  readonly seats: ReadonlyMap<SeatKey, SeatTrack>;
  /** The latest time seen, from an event or a tick. */
  readonly clock: number;
};

export type SeatTriggerStep = { readonly state: SeatTriggers; readonly firings: readonly SeatStateFiring[] };

export const emptySeatTriggers: SeatTriggers = { seats: new Map(), clock: 0 };

const firingKey = (seat: SeatKey, epoch: string, becomes: SeatTriggerState, since: number): SeatFiringKey =>
  SeatFiringKey.make(`${seat}\u0000${epoch}\u0000${becomes}\u0000${since}`);

const fire = (seat: SeatKey, epoch: string, pending: Pending, at: number): SeatStateFiring => ({
  key: firingKey(seat, epoch, pending.becomes, pending.since),
  seat,
  epoch,
  becomes: pending.becomes,
  since: pending.since,
  at,
  reason: pending.reason,
});

const dueAt = (pending: Pending): number =>
  pending.since + (pending.becomes === "gone" ? SEAT_TRIGGER_GONE_GRACE_MS : SEAT_TRIGGER_HOLD_MS);

/**
 * The state as the runner finds it on start: each seat's latest event is
 * already settled and fires nothing, so a restart never re-fires a seat that
 * was idle all along. The cost: a hold or a gone grace running at the restart
 * settles silently and never fires.
 */
export const seedSeatTriggers = (latest: Iterable<AgentSeatStateEvent>, now: number): SeatTriggers => {
  const seats = new Map<SeatKey, SeatTrack>();
  for (const event of latest) {
    const seat = seatKeyOf(event.bindingId);
    if (Option.isNone(seat)) continue;
    seats.set(seat.value, {
      epoch: event.epoch,
      ...(event.state === "unknown" ? {} : { settled: event.state }),
      inAttention: event.state === "attention",
      retired: [],
    });
  }
  return { seats, clock: now };
};

/** Settle every hold and grace due by `now`, oldest first. */
const settle = (seats: Map<SeatKey, SeatTrack>, now: number): SeatStateFiring[] => {
  const firings: SeatStateFiring[] = [];
  for (const [seat, track] of seats) {
    const pending = track.pending;
    if (pending === undefined || dueAt(pending) > now) continue;
    const { pending: _, ...rest } = track;
    seats.set(seat, { ...rest, settled: pending.becomes });
    if (track.settled !== pending.becomes) firings.push(fire(seat, track.epoch, pending, dueAt(pending)));
  }
  return firings;
};

const retire = (retired: readonly string[], epoch: string): readonly string[] =>
  [...retired.filter((old) => old !== epoch), epoch].slice(-RETIRED_EPOCHS);

/** One event on one seat; the seat's holds due by its time have already settled. */
const observe = (
  track: SeatTrack | undefined,
  seat: SeatKey,
  event: AgentSeatStateEvent,
  at: number,
): { readonly track: SeatTrack | undefined; readonly firing?: SeatStateFiring } => {
  let current: SeatTrack = track ?? { epoch: event.epoch, inAttention: false, retired: [] };
  if (current.retired.includes(event.epoch)) return { track };
  if (event.epoch !== current.epoch) {
    if (event.epoch === "") return { track };
    // A new generation took the seat: a pending gone and hold are dropped, the
    // episode ends, and what the seat had settled into carries over. A seat
    // that went for good carries nothing: its next generation fires on its
    // first real state.
    current = {
      epoch: event.epoch,
      ...(current.settled === undefined || current.settled === "gone" ? {} : { settled: current.settled }),
      inAttention: false,
      retired: retire(current.retired, current.epoch),
    };
  } else if (current.settled === "gone" || current.pending?.becomes === "gone") {
    // This generation has gone; anything more from it is late.
    return { track };
  }
  const entered = (becomes: SeatTriggerState): Pending => ({ becomes, since: at, reason: event.reason });
  const { pending: held, ...rest } = current;
  switch (event.state) {
    case "unknown":
      return { track: current };
    case "attention": {
      if (current.inAttention) return { track: current };
      const firing = fire(seat, current.epoch, entered("attention"), at);
      return { track: { ...rest, settled: "attention", inAttention: true }, firing };
    }
    case "idle":
    case "working": {
      const left = { ...rest, inAttention: false };
      if (held?.becomes === event.state) return { track: { ...left, pending: held } };
      if (current.settled === event.state) return { track: left };
      return { track: { ...left, pending: entered(event.state) } };
    }
    case "gone":
      return { track: { ...rest, inAttention: false, pending: entered("gone") } };
    default: {
      const unreachable: never = event.state;
      return unreachable;
    }
  }
};

const byTime = (a: SeatStateFiring, b: SeatStateFiring): number => a.at - b.at || (a.seat < b.seat ? -1 : a.seat > b.seat ? 1 : 0);

/** Fold one input. Firings come out in the order they happened. */
export const stepSeatTriggers = (state: SeatTriggers, input: SeatTriggerInput): SeatTriggerStep => {
  const seats = new Map(state.seats);
  switch (input._tag) {
    case "Tick": {
      const clock = Math.max(state.clock, input.now);
      return { state: { seats, clock }, firings: settle(seats, clock).sort(byTime) };
    }
    case "Event": {
      const { event } = input;
      // Time never runs backwards: a late event is read at the latest time seen.
      const clock = Math.max(state.clock, event.at);
      const firings = settle(seats, clock);
      const seat = seatKeyOf(event.bindingId);
      if (Option.isSome(seat)) {
        const next = observe(seats.get(seat.value), seat.value, event, clock);
        if (next.track !== undefined) seats.set(seat.value, next.track);
        if (next.firing !== undefined) firings.push(next.firing);
      }
      return { state: { seats, clock }, firings: firings.sort(byTime) };
    }
    default: {
      const unreachable: never = input;
      return unreachable;
    }
  }
};

/** When the next hold or grace comes due, for the runner's next tick; undefined when none waits. */
export const nextSeatTriggerDue = (state: SeatTriggers): number | undefined => {
  let next: number | undefined;
  for (const track of state.seats.values()) {
    if (track.pending === undefined) continue;
    const due = dueAt(track.pending);
    if (next === undefined || due < next) next = due;
  }
  return next;
};
