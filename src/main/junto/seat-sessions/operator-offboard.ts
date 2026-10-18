/**
 * Operator offboard, the main-process side: the one operation behind the
 * seat's two buttons, the overseer command and the two automatic rules.
 *
 *   ask   send the seat's agent the offboard prompt, as ordinary mail.
 *   now   end the session without the agent: no turn, no notes, no tokens.
 *         Only for a seat that is idle, not running or resting; anything else is
 *         refused with a reason. Never queued, and it never cuts a turn.
 *
 * This module decides WHETHER a seat may be closed and reports what
 * happened, one row per seat. It does not close anything itself: the close
 * is the offboard closer's (`closeNow`), the same path an agent's own
 * offboard takes from the point its notes are saved.
 *
 * It also keeps the status clock: when each seat last came to rest, read
 * from its status, in real time and saved to disk. A seat still for ninety
 * minutes when Junto closed for eight hours has been still for nine and a
 * half when it opens: the cache it would wake into is just as cold.
 *
 * Auto offboard cuts a session once it has gone cold: at the minute pass for
 * a running seat at rest past its cache window (the eager cut), and at the
 * moment a resting or idle seat is about to be given a turn (woken, or
 * mailed). Never while the operator views or has just typed into the seat.
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
import { deriveNeeds, type NeedCause, type SeatSnapshot } from "@shared/harness-domain";
import { seatNextTurn, type SeatNextLaunch, type SeatNextTurn } from "@shared/seat-next-launch";
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
  /** A process is up for the seat. False: not running or resting. */
  readonly running: boolean;
  /**
   * What the seat's screen says, for a running seat. `idle` only when the
   * idle is confirmed (the same test that allows typing into a seat).
   */
  readonly state?: "idle" | "working" | "attention" | "unknown";
  /** The seat's canvas is paused. */
  readonly paused?: boolean;
  /** Blocked, or asking the operator for something other than a look at a finished turn. */
  readonly waitsOnOperator?: boolean;
};

/** A turn that ended unseen is done: the session may still be cut under it. */
const DONE_CAUSES: ReadonlySet<NeedCause> = new Set(["turn_unseen", "turn_failed"]);

/**
 * Whether the seat waits on the operator: Blocked, or with any need the
 * operator is to act on other than a finished turn. Such a seat keeps its
 * session through the eager cut.
 */
export const waitsOnOperator = (snapshot: SeatSnapshot | undefined): boolean =>
  snapshot !== undefined &&
  (snapshot.status._tag === "Blocked" ||
    deriveNeeds(snapshot).some((need) => need.actor === "operator" && !DONE_CAUSES.has(need.cause)));

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
  /**
   * The operator views or has just typed into the seat, here or on the
   * machine editing its canvas. A held seat's session is not cut. Absent
   * port: nothing is ever held.
   */
  readonly held?: (seat: OffboardSeat, at: number) => boolean;
  /** Save the clock (called once per tick). */
  readonly saveClock?: (record: SeatClockRecord) => void;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
};

/** What the clock keeps on disk, so it carries on across a restart. */
export type SeatClockRecord = {
  readonly savedAt: number;
  readonly seats: Readonly<
    Record<
      string,
      {
        /** When the seat last came to rest after activity (epoch ms). */
        readonly idleSince?: number;
        /** When the seat last left rest (its status's `activitySince`). */
        readonly activitySince?: number;
        readonly offboarded?: boolean;
        /** Time the seat spent working in its current session (ms). */
        readonly workMs?: number;
        /** The session that work belongs to. */
        readonly sessionId?: string;
      }
    >
  >;
};

type ClockEntry = {
  idleSince: number | undefined;
  activitySince: number | undefined;
  offboarded: boolean;
  /** Work finished so far in the current session. */
  workMs: number;
  /** Set while the seat is working: when this stretch of work began. */
  workingSince: number | undefined;
  sessionId: string | undefined;
};

/** The seat left rest after it last came to rest: it is active, or was when last seen. */
const activeAfterRest = (entry: Pick<ClockEntry, "idleSince" | "activitySince">): boolean =>
  entry.activitySince !== undefined && (entry.idleSince === undefined || entry.activitySince > entry.idleSince);

/**
 * Two things about each seat, kept together because they are saved together.
 *
 * When it last came to rest, read from its status and nothing else: the
 * moment it went Idle after activity, or exited from it. Activity is leaving
 * rest (the status's `activitySince`: work or a block, from Idle or no
 * reading yet). Output, typing and a repainting prompt are not. An Idle with
 * no activity since the last rest (a start, a resume) leaves the time where
 * it was: no turn has warmed the session. Real time, and durable: time while
 * Junto was closed counts like any other.
 *
 * How long it has worked in its current session: the time its seat state
 * read working, summed. It starts again from zero whenever the seat gets a
 * fresh session, whoever caused that. This is what tells a session worth
 * cutting from one that is empty or tiny.
 *
 * A seat the clock has never seen at rest has been still since the clock
 * first started in this run, and has done no work.
 */
export class SeatStatusClock {
  private readonly entries = new Map<string, ClockEntry>();
  /** When this run's clock started: the moment the app opened. */
  readonly startedAt: number;

  constructor(
    private readonly now: () => number = () => Date.now(),
    restored?: SeatClockRecord,
  ) {
    this.startedAt = this.now();
    // A time in the future (a changed system clock) is no evidence at all.
    const past = (at: number | undefined): number | undefined =>
      at !== undefined && Number.isFinite(at) && at <= this.startedAt ? at : undefined;
    for (const [bindingId, seat] of Object.entries(restored?.seats ?? {})) {
      const entry: ClockEntry = {
        idleSince: past(seat.idleSince),
        activitySince: past(seat.activitySince),
        offboarded: seat.offboarded === true,
        workMs: Math.max(0, seat.workMs ?? 0),
        // Whatever was working when Junto closed is not working now.
        workingSince: undefined,
        sessionId: seat.sessionId,
      };
      // Active when Junto closed: it came to rest no later than the last save.
      if (activeAfterRest(entry)) entry.idleSince = Math.min(this.startedAt, Math.max(entry.activitySince!, restored!.savedAt));
      this.entries.set(bindingId, entry);
    }
  }

  private entry(bindingId: string): ClockEntry {
    let entry = this.entries.get(bindingId);
    if (entry === undefined) {
      entry = {
        idleSince: undefined,
        activitySince: undefined,
        offboarded: false,
        workMs: 0,
        workingSince: undefined,
        sessionId: undefined,
      };
      this.entries.set(bindingId, entry);
    }
    return entry;
  }

  /**
   * The seat's status, as its snapshot reads now. Leaving rest makes a cut
   * session history; coming to rest after activity starts the stillness.
   */
  noteStatus(bindingId: string, snapshot: Pick<SeatSnapshot, "status" | "since" | "activitySince">): void {
    const entry = this.entry(bindingId);
    const left = snapshot.activitySince;
    if (left !== undefined && left <= this.now() && (entry.activitySince === undefined || left > entry.activitySince)) {
      entry.activitySince = left;
      entry.offboarded = false;
    }
    const tag = snapshot.status._tag;
    if ((tag === "Idle" || tag === "Exited") && activeAfterRest(entry)) entry.idleSince = snapshot.since;
  }

  /**
   * When the seat came to rest. A seat whose status still reads active since
   * then is still now; one never seen at rest, since this run's clock started.
   */
  stillSince(bindingId: string): number {
    const entry = this.entries.get(bindingId);
    if (entry === undefined) return this.startedAt;
    if (activeAfterRest(entry)) return this.now();
    return entry.idleSince ?? this.startedAt;
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

  private resetWork(entry: ClockEntry): void {
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

  /** Closed from outside, and not active since: its session is already fresh. */
  isFresh(bindingId: string): boolean {
    return this.entries.get(bindingId)?.offboarded === true;
  }

  forget(bindingId: string): void {
    this.entries.delete(bindingId);
  }

  /** The clock as it is saved. Call it on every pass. */
  record(): SeatClockRecord {
    const seats: Record<string, SeatClockRecord["seats"][string]> = {};
    for (const [bindingId, entry] of this.entries) {
      const workMs = this.workMs(bindingId);
      seats[bindingId] = {
        ...(entry.idleSince !== undefined ? { idleSince: entry.idleSince } : {}),
        ...(entry.activitySince !== undefined ? { activitySince: entry.activitySince } : {}),
        ...(entry.offboarded ? { offboarded: true } : {}),
        ...(workMs > 0 ? { workMs } : {}),
        ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
      };
    }
    return { savedAt: this.now(), seats };
  }
}

const finiteTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Read a saved clock; anything unreadable is no clock at all. */
export const parseSeatClockRecord = (text: string): SeatClockRecord | undefined => {
  try {
    const parsed = JSON.parse(text) as { savedAt?: unknown; seats?: unknown };
    if (typeof parsed.savedAt !== "number" || !Number.isFinite(parsed.savedAt)) return undefined;
    if (typeof parsed.seats !== "object" || parsed.seats === null || Array.isArray(parsed.seats)) return undefined;
    const seats: Record<string, SeatClockRecord["seats"][string]> = {};
    for (const [bindingId, value] of Object.entries(parsed.seats as Record<string, unknown>)) {
      const seat = value as {
        idleSince?: unknown;
        activitySince?: unknown;
        movedAt?: unknown;
        offboarded?: unknown;
        workMs?: unknown;
        sessionId?: unknown;
      };
      // A clock saved before the status fed it kept when the seat last moved.
      const idleSince = finiteTime(seat?.idleSince) ? seat.idleSince : finiteTime(seat?.movedAt) ? seat.movedAt : undefined;
      const activitySince = finiteTime(seat?.activitySince) ? seat.activitySince : undefined;
      if (idleSince === undefined && activitySince === undefined) continue;
      seats[bindingId] = {
        ...(idleSince !== undefined ? { idleSince } : {}),
        ...(activitySince !== undefined ? { activitySince } : {}),
        ...(seat.offboarded === true ? { offboarded: true } : {}),
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
  "Junto cannot tell that this seat is idle. Offboard now only closes a seat that is idle, not running or resting.";

/** How long an ask keeps its seat's session from being cut under it. */
const ASK_EXEMPT_MS = 10 * 60_000;

const keyOf = (seat: SeatAddress): string => `${seat.canvasName}\u0000${seat.seatId}`;

export const makeOperatorOffboard = (ports: OperatorOffboardPorts, clock: SeatStatusClock) => {
  const now = (): number => ports.now?.() ?? Date.now();
  /** Seats just asked to offboard, and until when their session is left alone for it. */
  const asking = new Map<string, number>();

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
    const resting = !seat.running || seat.state === "idle";
    if (!resting) return { minutes: null, pastWindow: false };
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
          ...(still.since !== undefined ? { stillSince: still.since } : {}),
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
    // Before the prompt goes out: it travels as mail, and must reach this
    // session rather than set off a cut of it.
    asking.set(keyOf(address), now() + ASK_EXEMPT_MS);
    const sent = await ports
      .ask(seat, mode)
      .catch((error: unknown) => ({ ok: false as const, message: String(error) }));
    if (!sent.ok) {
      asking.delete(keyOf(address));
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
   * Has this seat's session gone cold, so that a turn given now would be cut
   * to a fresh session first? The one test behind the cut and behind what the
   * seat shows. When not cold yet, `at` is when it will be if nothing moves;
   * absent, nothing but a move can make it cold.
   */
  const coldness = (
    seat: OffboardSeat,
    address: SeatAddress,
  ): { readonly cold: boolean; readonly at?: number } => {
    if (seat.sessionId === undefined) return { cold: false };
    const set = offboardRulesFor(ports.rules(), seat.harness);
    if (clock.isFresh(seat.bindingId)) return { cold: false };
    if (!mayCloseNow(seat, address).allowed) return { cold: false };
    // Held: it goes cold only once the operator lets go, so there is no time to give.
    if (ports.held?.(seat, now()) === true) return { cold: false };
    const still = stillness(seat, now());
    if (still.minutes === null) return { cold: false };
    if (still.minutes < set.cacheWindowMinutes)
      return still.since === undefined ? { cold: false } : { cold: false, at: still.since + set.cacheWindowMinutes * 60_000 };
    // Never recycle an empty or tiny session. Asked last: the size reads the transcript.
    return { cold: worthOf(seat, false).worth };
  };

  /**
   * Auto offboard. A seat is about to be given a turn on a session that has
   * gone cold: end that session first, so the turn happens in a fresh one.
   *
   * There are two such moments, and no others:
   *   wake  a resting or offline seat is about to be started;
   *   mail  mail is about to be typed into a seat whose agent is running and
   *         idle. The seat then rests on its fresh session, and the mail
   *         wakes it there.
   *
   * A running seat at rest is cut sooner, at the minute pass (`tick`); this
   * catches the rest, and a seat that was never cold at a pass. What the
   * operator types into a terminal themselves is never intercepted.
   *
   * Resolves true when the session was cut. Never throws: neither a wake nor
   * a delivery is ever held up by a failure here.
   */
  const cutIfCold = async (address: SeatAddress, moment: "wake" | "mail"): Promise<boolean> => {
    try {
      const seat = await ports.locate(address);
      if (seat === undefined || !seat.local) return false;
      if (moment === "wake" ? seat.running : !(seat.running && seat.state === "idle")) return false;
      // A paused canvas refuses the wake; a session is not cut for a turn that will not happen.
      if (seat.paused === true) return false;
      // The operator just asked this seat's agent to offboard: that mail is
      // meant for this session, and cutting under it would throw the ask away.
      if (moment === "mail" && (asking.get(keyOf(address)) ?? 0) > now()) return false;
      if (!coldness(seat, address).cold) return false;
      const row = await closeOne(address, "automatic");
      if (!row.ok) ports.log?.(`auto offboard before ${moment} for ${address.seatId} did not go through: ${row.reason}`);
      return row.ok;
    } catch (error) {
      ports.log?.(`auto offboard before ${moment} for ${address.seatId} failed: ${String(error)}`);
      return false;
    }
  };

  /** A resting or offline seat is about to be woken. */
  const beforeWake = (address: SeatAddress): Promise<boolean> => cutIfCold(address, "wake");

  /** Mail is about to be typed into a seat whose agent is running. */
  const beforeMail = (address: SeatAddress): Promise<boolean> => cutIfCold(address, "mail");

  /**
   * Whether the seat's next turn starts on a fresh session, by the same test
   * as the cut. `launch` is what a start does for a seat that is not running.
   * Undefined for a seat this installation does not run: its own machine
   * answers for it.
   */
  const nextTurn = async (address: SeatAddress, launch: SeatNextLaunch): Promise<SeatNextTurn | undefined> => {
    const seat = await ports.locate(address).catch(() => undefined);
    if (seat === undefined || !seat.local) return undefined;
    return seatNextTurn({ running: seat.running, launch, cold: coldness(seat, address) });
  };

  /**
   * The eager cut, for one seat at the minute pass: a running seat at rest
   * (idle, or done with a turn unseen) whose session has gone cold, on a
   * canvas that is playing, not waiting on the operator and not just asked to
   * offboard. Undefined when the seat is not due. Never throws.
   */
  const cutIfDue = async (seat: OffboardSeat): Promise<SeatOffboardRunRow | undefined> => {
    const address = { canvasName: seat.canvasName, seatId: seat.seatId };
    try {
      if (!seat.local || !seat.running || seat.state !== "idle") return undefined;
      if (seat.paused === true || seat.waitsOnOperator === true) return undefined;
      if ((asking.get(keyOf(address)) ?? 0) > now()) return undefined;
      if (!coldness(seat, address).cold) return undefined;
      const row = await closeOne(address, "automatic");
      if (!row.ok) ports.log?.(`auto offboard at the cache window for ${address.seatId} did not go through: ${row.reason}`);
      return row;
    } catch (error) {
      ports.log?.(`auto offboard at the cache window for ${address.seatId} failed: ${String(error)}`);
      return undefined;
    }
  };

  /**
   * The once-a-minute pass: keep each seat's work count on its current
   * session, cut every seat this machine runs that is due (`cutIfDue`), each
   * on its own, then save the clock. A seat on another machine is cut by
   * that machine's own pass.
   */
  const tick = async (): Promise<SeatOffboardRunResult> => {
    const seats = await ports.seats().catch(() => [] as ReadonlyArray<OffboardSeat>);
    for (const seat of seats) clock.syncSession(seat.bindingId, seat.sessionId);
    const rows = (await Promise.all(seats.map(cutIfDue))).filter((row) => row !== undefined);
    try {
      ports.saveClock?.(clock.record());
    } catch {
      ports.log?.("the offboard clock could not be saved");
    }
    return summarizeOffboardRun(rows);
  };

  return { run, status, tick, beforeWake, beforeMail, nextTurn, clock };
};

export type OperatorOffboard = ReturnType<typeof makeOperatorOffboard>;

/** How often the automatic rules look. Rule intervals are whole minutes. */
export const OFFBOARD_TICK_MS = 60_000;

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
 * The installed operation reads the rules before it runs, and that read is
 * outside the rule's own guard. A failure there must cost the cut, never the
 * wake or the delivery waiting on it.
 */
const failedCut =
  (moment: "wake" | "mail", seat: SeatAddress) =>
  (error: unknown): false => {
    console.error(`[offboard] auto offboard before ${moment} for ${seat.canvasName}/${seat.seatId} failed: ${String(error)}`);
    return false;
  };

/**
 * A seat is about to be woken. Ends its session first when it has gone cold
 * and is worth cutting, so the seat wakes fresh. Await it, then wake. It
 * never throws and never refuses the wake.
 */
export const cutBeforeWake = (seat: SeatAddress): Promise<boolean> =>
  current ? current.beforeWake(seat).catch(failedCut("wake", seat)) : Promise.resolve(false);

/**
 * Mail is about to be typed into a seat whose agent is running. Ends its
 * session first when it has gone cold and is worth cutting; the caller then
 * wakes the seat and the mail is delivered to the fresh session. It never
 * throws; false means deliver as usual.
 */
export const cutBeforeMail = (seat: SeatAddress): Promise<boolean> =>
  current ? current.beforeMail(seat).catch(failedCut("mail", seat)) : Promise.resolve(false);

/**
 * What the seat's next turn does: continue its session or start fresh.
 * Undefined before the operation is installed, and for a seat on another
 * machine.
 */
export const seatNextTurnOf = (seat: SeatAddress, launch: SeatNextLaunch): Promise<SeatNextTurn | undefined> =>
  current ? current.nextTurn(seat, launch).catch(() => undefined) : Promise.resolve(undefined);

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
