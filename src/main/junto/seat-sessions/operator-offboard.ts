/**
 * Operator offboard, the main-process side: the one operation behind the
 * seat's two buttons, the overseer command and the two automatic rules.
 *
 *   ask   send the seat's agent the offboard prompt, as ordinary mail.
 *   now   end the session without the agent: no turn, no notes, no tokens.
 *         Only for a seat that is idle, offline or resting; anything else is
 *         refused with a reason. Never queued, and it never cuts a turn.
 *
 * This module decides WHETHER a seat may be closed and reports what
 * happened, one row per seat. It does not close anything itself: the close
 * is the offboard closer's (`closeNow`), the same path an agent's own
 * offboard takes from the point its notes are saved.
 *
 * It also keeps the motionless clock: when each seat last moved, in real
 * time and saved to disk. A seat still for ninety minutes when Junto closed
 * for eight hours has been still for nine and a half when it opens: the
 * cache it would wake into is just as cold. What keeps that from becoming a
 * wave of closes at start is pace, not a stopped clock: the rules wait a few
 * minutes after the app opens, then act on one seat per pass.
 *
 * Everything it touches comes in through ports, so it runs the same against
 * the app and a test.
 */
import {
  OFFBOARD_REFUSAL_REASON,
  offboardRulesFor,
  summarizeOffboardRun,
  wholeMinutesBetween,
  type OffboardBy,
  type OffboardRefusalCode,
  type OffboardRules,
  type SeatOffboardRunInput,
  type SeatOffboardRunResult,
  type SeatOffboardRunRow,
  type SeatOffboardStatus,
} from "@shared/seat-offboard";
import { SEAT_OFFBOARD_MAX_SEATS } from "@shared/seat-offboard";
import type { OffboardMode, SeatAddress } from "@shared/seat-sessions";

/** A seat as the operation needs it, read off its canvas and the terminal plane. */
export type OffboardSeat = SeatAddress & {
  readonly title?: string;
  readonly bindingId: string;
  readonly harness: string;
  /** This installation runs the seat. */
  readonly local: boolean;
  /** The session the seat names now, if it has one. */
  readonly sessionId?: string;
  /** A process is up for the seat. False: offline or resting. */
  readonly running: boolean;
  /**
   * What the seat's screen says, for a running seat. `idle` only when the
   * idle is confirmed (the same test that allows typing into a seat).
   */
  readonly state?: "idle" | "working" | "attention" | "unknown";
  /** The seat's canvas is paused. */
  readonly paused?: boolean;
};

export type OperatorOffboardPorts = {
  readonly locate: (seat: SeatAddress) => Promise<OffboardSeat | undefined>;
  /** Every agent seat this installation runs, for the automatic rules. */
  readonly seats: () => Promise<ReadonlyArray<OffboardSeat>>;
  /** An offboard is already under way for this seat. */
  readonly isClosing: (seat: SeatAddress) => boolean;
  /**
   * End the session through the closer and leave the seat resting. The
   * closer reports progress; this answers whether the close went through.
   */
  readonly closeNow: (
    seat: OffboardSeat,
    by: OffboardBy,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
  /** Send the offboard prompt for this mode, on the ordinary mail path. */
  readonly ask: (
    seat: OffboardSeat,
    mode: OffboardMode,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
  /** Record who ended this session without notes. */
  readonly markEnded: (seat: OffboardSeat, sessionId: string, by: OffboardBy, at: number) => void;
  /** The harness has something on disk for this session: it was really used. */
  readonly sessionHasHistory: (seat: OffboardSeat) => boolean;
  readonly rules: () => OffboardRules;
  /** Save the clock (called once per tick). */
  readonly saveClock?: (record: SeatMotionRecord) => void;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
};

/** What the clock keeps on disk, so it carries on across a restart. */
export type SeatMotionRecord = {
  readonly savedAt: number;
  readonly seats: Readonly<
    Record<
      string,
      {
        /** When the seat last moved (epoch ms). */
        readonly movedAt: number;
        readonly offboarded?: boolean;
        readonly nudged?: boolean;
      }
    >
  >;
};

type MotionEntry = { movedAt: number; offboarded: boolean; nudged: boolean };

/**
 * When each seat last moved: produced output, left idle, was typed into, or
 * had mail written to it.
 *
 * Real time, and durable: the clock is saved and restored, and time while
 * Junto was closed counts like any other. A session that sat still through
 * the night is exactly as cold as one that sat still with the app open.
 *
 * A seat the clock has never seen has been still since the clock first
 * started in this run.
 */
export class SeatMotionClock {
  private readonly entries = new Map<string, MotionEntry>();
  /** When this run's clock started: the moment the app opened. */
  readonly startedAt: number;

  constructor(
    private readonly now: () => number = () => Date.now(),
    restored?: SeatMotionRecord,
  ) {
    this.startedAt = this.now();
    for (const [bindingId, seat] of Object.entries(restored?.seats ?? {})) {
      // A time in the future (a changed system clock) is no evidence at all.
      if (!Number.isFinite(seat.movedAt) || seat.movedAt > this.startedAt) continue;
      this.entries.set(bindingId, {
        movedAt: seat.movedAt,
        offboarded: seat.offboarded === true,
        nudged: seat.nudged === true,
      });
    }
  }

  private entry(bindingId: string): MotionEntry {
    let entry = this.entries.get(bindingId);
    if (entry === undefined) {
      entry = { movedAt: this.startedAt, offboarded: false, nudged: false };
      this.entries.set(bindingId, entry);
    }
    return entry;
  }

  /** The seat moved. A new stretch of stillness starts here. */
  note(bindingId: string): void {
    this.entries.set(bindingId, { movedAt: this.now(), offboarded: false, nudged: false });
  }

  /** When the seat last moved. */
  stillSince(bindingId: string): number {
    return this.entries.get(bindingId)?.movedAt ?? this.startedAt;
  }

  markOffboarded(bindingId: string): void {
    this.entry(bindingId).offboarded = true;
  }

  /** Closed from outside, and still since: its session is already fresh. */
  isFresh(bindingId: string): boolean {
    return this.entries.get(bindingId)?.offboarded === true;
  }

  markNudged(bindingId: string): void {
    this.entry(bindingId).nudged = true;
  }

  wasNudged(bindingId: string): boolean {
    return this.entries.get(bindingId)?.nudged === true;
  }

  forget(bindingId: string): void {
    this.entries.delete(bindingId);
  }

  /** The clock as it is saved. Call it on every pass. */
  record(): SeatMotionRecord {
    const seats: Record<string, SeatMotionRecord["seats"][string]> = {};
    for (const [bindingId, entry] of this.entries) {
      seats[bindingId] = {
        movedAt: entry.movedAt,
        ...(entry.offboarded ? { offboarded: true } : {}),
        ...(entry.nudged ? { nudged: true } : {}),
      };
    }
    return { savedAt: this.now(), seats };
  }
}

/** Read a saved clock; anything unreadable is no clock at all. */
export const parseSeatMotionRecord = (text: string): SeatMotionRecord | undefined => {
  try {
    const parsed = JSON.parse(text) as { savedAt?: unknown; seats?: unknown };
    if (typeof parsed.savedAt !== "number" || !Number.isFinite(parsed.savedAt)) return undefined;
    if (typeof parsed.seats !== "object" || parsed.seats === null || Array.isArray(parsed.seats)) return undefined;
    const seats: Record<string, SeatMotionRecord["seats"][string]> = {};
    for (const [bindingId, value] of Object.entries(parsed.seats as Record<string, unknown>)) {
      const seat = value as { movedAt?: unknown; offboarded?: unknown; nudged?: unknown };
      if (typeof seat?.movedAt !== "number" || !Number.isFinite(seat.movedAt)) continue;
      seats[bindingId] = {
        movedAt: seat.movedAt,
        ...(seat.offboarded === true ? { offboarded: true } : {}),
        ...(seat.nudged === true ? { nudged: true } : {}),
      };
    }
    return { savedAt: parsed.savedAt, seats };
  } catch {
    return undefined;
  }
};

const refusal = (
  code: OffboardRefusalCode,
  reason: string = OFFBOARD_REFUSAL_REASON[code],
): { readonly allowed: false; readonly code: OffboardRefusalCode; readonly reason: string } => ({
  allowed: false,
  code,
  reason,
});

const UNCONFIRMED_IDLE =
  "Junto cannot tell that this seat is idle. Offboard now only closes a seat that is idle, offline or resting.";

export const makeOperatorOffboard = (ports: OperatorOffboardPorts, clock: SeatMotionClock) => {
  const now = (): number => ports.now?.() ?? Date.now();

  /** May this seat's session be ended without its agent, right now? */
  const mayCloseNow = (
    seat: OffboardSeat | undefined,
    address: SeatAddress,
  ): SeatOffboardStatus["now"] => {
    if (seat === undefined) return refusal("not-a-seat");
    if (!seat.local) return refusal("not-local");
    if (ports.isClosing(address)) return refusal("closing");
    // Offline or resting: there is no turn to cut.
    if (!seat.running) return { allowed: true };
    switch (seat.state) {
      case "idle":
        return { allowed: true };
      case "working":
        return refusal("working");
      case "attention":
        return refusal("attention");
      default:
        // Starting, or a screen Junto cannot read: never assume idle.
        return refusal("working", UNCONFIRMED_IDLE);
    }
  };

  /** Still, and for how long: a running seat only counts while it is idle. */
  const stillness = (
    seat: OffboardSeat,
    at: number,
  ): { readonly since?: number; readonly minutes: number | null; readonly pastWindow: boolean } => {
    const motionless = !seat.running || seat.state === "idle";
    if (!motionless) return { minutes: null, pastWindow: false };
    const since = clock.stillSince(seat.bindingId);
    const minutes = wholeMinutesBetween(since, at);
    const window = offboardRulesFor(ports.rules(), seat.harness).cacheWindowMinutes;
    return { since, minutes, pastWindow: minutes >= window };
  };

  const status = async (
    canvasName: string,
    seatIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<SeatOffboardStatus>> => {
    const at = now();
    return Promise.all(
      seatIds.slice(0, SEAT_OFFBOARD_MAX_SEATS).map(async (seatId): Promise<SeatOffboardStatus> => {
        const address = { canvasName, seatId };
        const seat = await ports.locate(address).catch(() => undefined);
        const allowed = mayCloseNow(seat, address);
        const still = seat ? stillness(seat, at) : { minutes: null, pastWindow: false };
        return {
          seatId,
          now: allowed,
          ...(still.since !== undefined ? { motionlessSince: still.since } : {}),
          idleMinutes: still.minutes,
          pastWindow: still.pastWindow,
          preferred: still.pastWindow ? "now" : "ask",
        };
      }),
    );
  };

  const closeOne = async (
    address: SeatAddress,
    by: OffboardBy,
  ): Promise<SeatOffboardRunRow> => {
    const seat = await ports.locate(address).catch(() => undefined);
    const title = seat?.title ? { title: seat.title } : {};
    const allowed = mayCloseNow(seat, address);
    const at = now();
    const pastWindow = seat ? stillness(seat, at).pastWindow : false;
    if (!allowed.allowed || seat === undefined) {
      const refused = allowed.allowed ? refusal("not-a-seat") : allowed;
      return { seatId: address.seatId, ...title, ok: false, code: refused.code, reason: refused.reason, pastWindow };
    }
    const ended = seat.sessionId;
    const closed = await ports
      .closeNow(seat, by)
      .catch((error: unknown) => ({ ok: false as const, message: String(error) }));
    if (!closed.ok) {
      // No retry: it shows on the seat (the closer reported it) and stops.
      ports.log?.(`offboard now (${by}) failed for ${address.seatId}: ${closed.message}`);
      return {
        seatId: address.seatId,
        ...title,
        ok: false,
        code: "failed",
        reason: closed.message || OFFBOARD_REFUSAL_REASON.failed,
        pastWindow,
      };
    }
    if (ended) {
      try {
        ports.markEnded(seat, ended, by, at);
      } catch {
        // The session is closed either way; only the "who" is lost.
        ports.log?.(`could not record who ended ${ended} for ${address.seatId}`);
      }
    }
    clock.markOffboarded(seat.bindingId);
    return { seatId: address.seatId, ...title, ok: true, action: "now", outcome: "closed", pastWindow };
  };

  const askOne = async (address: SeatAddress, mode: OffboardMode): Promise<SeatOffboardRunRow> => {
    const seat = await ports.locate(address).catch(() => undefined);
    if (seat === undefined) {
      return { seatId: address.seatId, ok: false, code: "not-a-seat", reason: OFFBOARD_REFUSAL_REASON["not-a-seat"] };
    }
    const title = seat.title ? { title: seat.title } : {};
    const pastWindow = stillness(seat, now()).pastWindow;
    if (!seat.local) {
      return { seatId: address.seatId, ...title, ok: false, code: "not-local", reason: OFFBOARD_REFUSAL_REASON["not-local"], pastWindow };
    }
    const sent = await ports
      .ask(seat, mode)
      .catch((error: unknown) => ({ ok: false as const, message: String(error) }));
    if (!sent.ok) {
      return {
        seatId: address.seatId,
        ...title,
        ok: false,
        code: "undelivered",
        reason: sent.message || OFFBOARD_REFUSAL_REASON.undelivered,
        pastWindow,
      };
    }
    return { seatId: address.seatId, ...title, ok: true, action: "ask", outcome: "asked", pastWindow };
  };

  /**
   * Ask, or offboard now, each seat named. One row per seat, in the order
   * given; a seat that cannot be found or may not be closed is a refused
   * row, never a throw. Seats are independent: one that fails delays no other.
   */
  const run = async (input: SeatOffboardRunInput, by: OffboardBy): Promise<SeatOffboardRunResult> => {
    const seatIds = [...new Set(input.seatIds)].slice(0, SEAT_OFFBOARD_MAX_SEATS);
    const rows = await Promise.all(
      seatIds.map((seatId) => {
        const address = { canvasName: input.canvasName, seatId };
        return input.action === "now" ? closeOne(address, by) : askOne(address, input.mode ?? "continue");
      }),
    );
    return summarizeOffboardRun(rows);
  };

  /**
   * One pass of the two automatic rules over every seat this installation
   * runs. Auto offboard: a seat still for its interval, that may be closed
   * now, whose session was really used. Idle nudge: a running, idle seat
   * still for its (shorter) interval is asked once per stretch.
   *
   * Paced so it never reads as a batch: nothing for the first minutes after
   * the app opens, then one seat per pass, the one that has sat still
   * longest first. After a night closed, the overdue seats are cut one a
   * minute, not all at the moment Junto opens.
   */
  const tick = async (): Promise<SeatOffboardRunResult> => {
    const rules = ports.rules();
    const at = now();
    const rows: SeatOffboardRunRow[] = [];
    const save = (): void => {
      try {
        ports.saveClock?.(clock.record());
      } catch {
        ports.log?.("the offboard clock could not be saved");
      }
    };
    if (at - clock.startedAt < OFFBOARD_START_GRACE_MS) {
      save();
      return summarizeOffboardRun(rows);
    }
    const seats = await ports.seats().catch(() => [] as ReadonlyArray<OffboardSeat>);
    type Due = { readonly seat: OffboardSeat; readonly address: SeatAddress; readonly minutes: number; readonly action: "now" | "ask" };
    const due: Due[] = [];
    for (const seat of seats) {
      if (!seat.local) continue;
      const set = offboardRulesFor(rules, seat.harness);
      const minutes = stillness(seat, at).minutes;
      // Running and not idle: not still at all.
      if (minutes === null) continue;
      const address = { canvasName: seat.canvasName, seatId: seat.seatId };
      if (
        set.auto.enabled &&
        minutes >= set.auto.minutes &&
        !clock.isFresh(seat.bindingId) &&
        seat.sessionId !== undefined &&
        mayCloseNow(seat, address).allowed &&
        ports.sessionHasHistory(seat)
      ) {
        due.push({ seat, address, minutes, action: "now" });
        continue;
      }
      if (
        set.nudge.enabled &&
        seat.running &&
        seat.state === "idle" &&
        seat.paused !== true &&
        minutes >= set.nudge.minutes &&
        // Past the auto offboard interval a turn is the expensive choice:
        // that seat is waiting its place in line to be closed, not asked.
        !(set.auto.enabled && minutes >= set.auto.minutes) &&
        !clock.wasNudged(seat.bindingId) &&
        !clock.isFresh(seat.bindingId) &&
        !ports.isClosing(address)
      ) {
        due.push({ seat, address, minutes, action: "ask" });
      }
    }
    // Longest still first; one per pass.
    due.sort((left, right) => right.minutes - left.minutes);
    for (const { seat, address, action } of due.slice(0, OFFBOARD_ACTIONS_PER_PASS)) {
      if (action === "now") {
        rows.push(await closeOne(address, "automatic"));
        continue;
      }
      const row = await askOne(address, "continue");
      // Marked whatever the outcome: no retry within a stretch.
      clock.markNudged(seat.bindingId);
      if (!row.ok) ports.log?.(`idle nudge could not ask ${seat.seatId}: ${row.reason}`);
      rows.push(row);
    }
    save();
    return summarizeOffboardRun(rows);
  };

  return { run, status, tick, clock };
};

export type OperatorOffboard = ReturnType<typeof makeOperatorOffboard>;

/** How often the automatic rules look. Rule intervals are whole minutes. */
export const OFFBOARD_TICK_MS = 60_000;

/** After the app opens, the automatic rules wait this long before acting. */
export const OFFBOARD_START_GRACE_MS = 5 * 60_000;

/** Seats the automatic rules act on in one pass. */
export const OFFBOARD_ACTIONS_PER_PASS = 1;

// ── The process instance ───────────────────────────────────────────────────

let current: OperatorOffboard | undefined;

/** Install the app's operation (composition), or a fake (tests); undefined clears it. */
export const setOperatorOffboard = (next: OperatorOffboard | undefined): void => {
  current = next;
};

const NOT_READY = "Junto is still starting. Try again in a moment.";

/** The one entry point for the buttons, the overseer and the rules. */
export const runSeatOffboard = (
  input: SeatOffboardRunInput,
  by: OffboardBy,
): Promise<SeatOffboardRunResult> =>
  current
    ? current.run(input, by)
    : Promise.resolve(
        summarizeOffboardRun(
          input.seatIds.map((seatId) => ({ seatId, ok: false as const, code: "failed" as const, reason: NOT_READY })),
        ),
      );

export const seatOffboardStatus = (
  canvasName: string,
  seatIds: ReadonlyArray<string>,
): Promise<ReadonlyArray<SeatOffboardStatus>> =>
  current
    ? current.status(canvasName, seatIds)
    : Promise.resolve(
        seatIds.map((seatId) => ({
          seatId,
          now: { allowed: false as const, code: "failed" as const, reason: NOT_READY },
          idleMinutes: null,
          pastWindow: false,
          preferred: "ask" as const,
        })),
      );
