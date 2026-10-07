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
 * cache it would wake into is just as cold. Nothing is ever cut on a timer
 * or in a batch: auto offboard acts on one seat, at the moment that seat is
 * about to be woken into a cold session.
 *
 * Everything it touches comes in through ports, so it runs the same against
 * the app and a test.
 */
import {
  OFFBOARD_REFUSAL_REASON,
  offboardRulesFor,
  summarizeOffboardRun,
  sessionWorthCutting,
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
  /**
   * The session's transcript as a token estimate. Undefined when the
   * transcript cannot be located: the session is then judged on work time
   * alone. Absent port: no size is known for any seat.
   */
  readonly sessionSize?: (seat: OffboardSeat) => { readonly tokens: number } | undefined;
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
        /** Time the seat spent working in its current session (ms). */
        readonly workMs?: number;
        /** The session that work belongs to. */
        readonly sessionId?: string;
      }
    >
  >;
};

type MotionEntry = {
  movedAt: number;
  offboarded: boolean;
  nudged: boolean;
  /** Work finished so far in the current session. */
  workMs: number;
  /** Set while the seat is working: when this stretch of work began. */
  workingSince: number | undefined;
  sessionId: string | undefined;
};

/**
 * Two things about each seat, kept together because they are saved together.
 *
 * When it last moved: produced output, left idle, was typed into, or had
 * mail written to it. Real time, and durable: time while Junto was closed
 * counts like any other. A session that sat still through the night is
 * exactly as cold as one that sat still with the app open.
 *
 * How long it has worked in its current session: the time its seat state
 * read working, summed. It starts again from zero whenever the seat gets a
 * fresh session, whoever caused that. This is what tells a session worth
 * cutting from one that is empty or tiny.
 *
 * A seat the clock has never seen has been still since the clock first
 * started in this run, and has done no work.
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
        workMs: Math.max(0, seat.workMs ?? 0),
        // Whatever was working when Junto closed is not working now.
        workingSince: undefined,
        sessionId: seat.sessionId,
      });
    }
  }

  private entry(bindingId: string): MotionEntry {
    let entry = this.entries.get(bindingId);
    if (entry === undefined) {
      entry = {
        movedAt: this.startedAt,
        offboarded: false,
        nudged: false,
        workMs: 0,
        workingSince: undefined,
        sessionId: undefined,
      };
      this.entries.set(bindingId, entry);
    }
    return entry;
  }

  /** The seat moved. A new stretch of stillness starts here. */
  note(bindingId: string): void {
    const entry = this.entry(bindingId);
    entry.movedAt = this.now();
    entry.offboarded = false;
    entry.nudged = false;
  }

  /** When the seat last moved. */
  stillSince(bindingId: string): number {
    return this.entries.get(bindingId)?.movedAt ?? this.startedAt;
  }

  /**
   * The seat's state changed. Time spent in `working` is work; leaving it
   * for anything else (idle, a dialog, gone) ends the stretch.
   */
  noteState(bindingId: string, state: string): void {
    const entry = this.entry(bindingId);
    if (state === "working") {
      entry.workingSince ??= this.now();
      return;
    }
    if (entry.workingSince === undefined) return;
    entry.workMs += Math.max(0, this.now() - entry.workingSince);
    entry.workingSince = undefined;
  }

  /** Time the seat has worked in its current session (ms), a stretch in progress included. */
  workMs(bindingId: string): number {
    const entry = this.entries.get(bindingId);
    if (entry === undefined) return 0;
    return entry.workMs + (entry.workingSince === undefined ? 0 : Math.max(0, this.now() - entry.workingSince));
  }

  /**
   * Tell the clock which session the seat is on. A different session than
   * the one its work was counted for means that work belongs to the past:
   * the count starts again. A session id appearing where none was known is
   * the same session being named (some harnesses announce theirs late).
   */
  syncSession(bindingId: string, sessionId: string | undefined): void {
    const entry = this.entry(bindingId);
    if (entry.sessionId === sessionId) return;
    if (entry.sessionId !== undefined) this.resetWork(entry);
    entry.sessionId = sessionId;
  }

  private resetWork(entry: MotionEntry): void {
    entry.workMs = 0;
    // A turn running right now belongs to the new session from here.
    if (entry.workingSince !== undefined) entry.workingSince = this.now();
  }

  /** The seat's session was ended from outside: what follows is a fresh one. */
  markOffboarded(bindingId: string): void {
    const entry = this.entry(bindingId);
    entry.offboarded = true;
    this.resetWork(entry);
    entry.workingSince = undefined;
    entry.sessionId = undefined;
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
      const workMs = this.workMs(bindingId);
      seats[bindingId] = {
        movedAt: entry.movedAt,
        ...(entry.offboarded ? { offboarded: true } : {}),
        ...(entry.nudged ? { nudged: true } : {}),
        ...(workMs > 0 ? { workMs } : {}),
        ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
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
      const seat = value as {
        movedAt?: unknown;
        offboarded?: unknown;
        nudged?: unknown;
        workMs?: unknown;
        sessionId?: unknown;
      };
      if (typeof seat?.movedAt !== "number" || !Number.isFinite(seat.movedAt)) continue;
      seats[bindingId] = {
        movedAt: seat.movedAt,
        ...(seat.offboarded === true ? { offboarded: true } : {}),
        ...(seat.nudged === true ? { nudged: true } : {}),
        ...(typeof seat.workMs === "number" && Number.isFinite(seat.workMs) && seat.workMs > 0
          ? { workMs: seat.workMs }
          : {}),
        ...(typeof seat.sessionId === "string" && seat.sessionId ? { sessionId: seat.sessionId } : {}),
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

  /**
   * What the session has done, and whether that is enough for the automatic
   * rules. The size is only asked for when work time alone does not settle
   * it, or when `withSize` wants it shown.
   */
  const worthOf = (
    seat: OffboardSeat,
    withSize: boolean,
  ): { readonly workMs: number; readonly tokens?: number; readonly worth: boolean } => {
    clock.syncSession(seat.bindingId, seat.sessionId);
    const workMs = clock.workMs(seat.bindingId);
    const threshold = offboardRulesFor(ports.rules(), seat.harness).worth;
    const byWork = sessionWorthCutting(threshold, { workMs });
    let tokens: number | undefined;
    if (seat.sessionId !== undefined && (withSize || (workMs > 0 && !byWork))) {
      try {
        tokens = ports.sessionSize?.(seat)?.tokens;
      } catch {
        tokens = undefined;
      }
    }
    return {
      workMs,
      ...(tokens !== undefined ? { tokens } : {}),
      worth: byWork || sessionWorthCutting(threshold, { workMs, ...(tokens !== undefined ? { tokens } : {}) }),
    };
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
        const done = seat ? worthOf(seat, true) : { workMs: 0, worth: false };
        return {
          seatId,
          now: allowed,
          ...(still.since !== undefined ? { motionlessSince: still.since } : {}),
          idleMinutes: still.minutes,
          pastWindow: still.pastWindow,
          preferred: still.pastWindow ? "now" : "ask",
          workMinutes: Math.floor(done.workMs / 60_000),
          ...(done.tokens !== undefined ? { sessionTokens: done.tokens } : {}),
          worthCutting: done.worth,
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
   * Auto offboard. A seat is about to be woken: if the session it would wake
   * into has sat still past the interval and is worth cutting, end it first,
   * so the seat wakes into a fresh one.
   *
   * This is the only place a session is ever ended without someone asking.
   * Nothing is cut on a timer and nothing is cut in a batch: a cold session
   * costs nothing while its seat rests, and it is dealt with at the moment
   * it would start to cost, one seat at a time, as each is woken.
   *
   * Only for a seat with no process (offline or resting). Resolves true when
   * the session was cut. Never throws: a wake is never held up by this.
   */
  const beforeWake = async (address: SeatAddress): Promise<boolean> => {
    try {
      const seat = await ports.locate(address);
      if (seat === undefined || !seat.local || seat.running || seat.sessionId === undefined) return false;
      // A paused canvas refuses the wake; a session is not cut for a wake that will not happen.
      if (seat.paused === true) return false;
      const set = offboardRulesFor(ports.rules(), seat.harness);
      if (!set.auto.enabled) return false;
      const minutes = stillness(seat, now()).minutes;
      if (minutes === null || minutes < set.auto.minutes) return false;
      if (clock.isFresh(seat.bindingId)) return false;
      if (!mayCloseNow(seat, address).allowed) return false;
      // Never recycle an empty or tiny session.
      if (!worthOf(seat, false).worth) return false;
      const row = await closeOne(address, "automatic");
      if (!row.ok) ports.log?.(`auto offboard before waking ${address.seatId} did not go through: ${row.reason}`);
      return row.ok;
    } catch (error) {
      ports.log?.(`auto offboard before waking ${address.seatId} failed: ${String(error)}`);
      return false;
    }
  };

  /**
   * The once-a-minute pass: save the clock, and run the idle nudge. The
   * nudge asks a running, idle seat, still for its interval, to offboard and
   * continue: once per stretch, one seat per pass, and only for a session
   * worth cutting. It does nothing for the first minutes after the app opens.
   * No session is ended from here (see `beforeWake`).
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
    const seats = await ports.seats().catch(() => [] as ReadonlyArray<OffboardSeat>);
    // Keep each seat's work count on its current session.
    for (const seat of seats) clock.syncSession(seat.bindingId, seat.sessionId);
    if (at - clock.startedAt < OFFBOARD_START_GRACE_MS) {
      save();
      return summarizeOffboardRun(rows);
    }
    const due: Array<{ readonly seat: OffboardSeat; readonly address: SeatAddress; readonly minutes: number }> = [];
    for (const seat of seats) {
      if (!seat.local) continue;
      const set = offboardRulesFor(rules, seat.harness);
      const minutes = stillness(seat, at).minutes;
      if (minutes === null) continue;
      const address = { canvasName: seat.canvasName, seatId: seat.seatId };
      if (
        set.nudge.enabled &&
        seat.running &&
        seat.state === "idle" &&
        seat.paused !== true &&
        minutes >= set.nudge.minutes &&
        // Past the auto offboard interval a turn is the expensive choice.
        !(set.auto.enabled && minutes >= set.auto.minutes) &&
        !clock.wasNudged(seat.bindingId) &&
        !clock.isFresh(seat.bindingId) &&
        !ports.isClosing(address) &&
        worthOf(seat, false).worth
      ) {
        due.push({ seat, address, minutes });
      }
    }
    // Longest still first; one per pass.
    due.sort((left, right) => right.minutes - left.minutes);
    for (const { seat, address } of due.slice(0, OFFBOARD_ACTIONS_PER_PASS)) {
      const row = await askOne(address, "continue");
      // Marked whatever the outcome: no retry within a stretch.
      clock.markNudged(seat.bindingId);
      if (!row.ok) ports.log?.(`idle nudge could not ask ${seat.seatId}: ${row.reason}`);
      rows.push(row);
    }
    save();
    return summarizeOffboardRun(rows);
  };

  return { run, status, tick, beforeWake, clock };
};

export type OperatorOffboard = ReturnType<typeof makeOperatorOffboard>;

/** How often the automatic rules look. Rule intervals are whole minutes. */
export const OFFBOARD_TICK_MS = 60_000;

/** After the app opens, the idle nudge waits this long before asking anyone. */
export const OFFBOARD_START_GRACE_MS = 5 * 60_000;

/** Seats the idle nudge asks in one pass. */
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

/**
 * A seat is about to be woken. Ends its session first when it has gone cold
 * and is worth cutting, so the seat wakes fresh. Await it, then wake. It
 * never throws and never refuses the wake.
 */
export const cutBeforeWake = (seat: SeatAddress): Promise<boolean> =>
  current ? current.beforeWake(seat) : Promise.resolve(false);

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
          workMinutes: 0,
          worthCutting: false,
        })),
      );
