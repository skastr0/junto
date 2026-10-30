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
 * What happens to a session gone cold is the machine's cache mode
 * (seat-offboard.ts CacheMode):
 *
 *            minute pass, a running seat at rest     the start of a resting seat
 *   off      never cut                               resumes
 *   manual   never cut                               resumes
 *   auto     cut off screen; open in front of the    starts fresh, whatever starts it
 *            operator, asked (`dueList`), and never
 *            cut without an answer
 *   hybrid   cut off screen; open, left alone        starts fresh for mail or a
 *                                                    restart; the operator's open resumes
 *
 * In every mode the operator's typing holds the cut, and a key warms the
 * session (`SeatStatusClock.noteTyped`). A resting seat is never cut: its next
 * start decides (`coldSessionStartsFresh`).
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
  type CacheMode,
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
import type { SeatStartCause } from "../term/seat-start-cause";
import { randomBytes } from "node:crypto";
import type { SeatCacheDue, SeatCacheDueAnswer, SeatCacheDueAnswerResult } from "@shared/seat-cache-due";

/** A seat as the operation needs it, read off its canvas and the terminal plane. */
export type OffboardSeat = SeatAddress & {
  readonly title?: string;
  readonly bindingId: string;
  readonly harness: string;
  /** This installation runs the seat. */
  readonly local: boolean;
  /** The machine that runs the seat, as its canvas names it. */
  readonly machine?: string;
  /** The session the seat names now, if it has one. */
  readonly sessionId?: string;
  /** A process is up for the seat. False: not running or resting. */
  readonly running: boolean;
  /** The running process's generation: a question asked of it is never answered for another. */
  readonly generation?: string;
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

/**
 * A seat's current session as the offboard clock and rules of the machine
 * that runs it read it. That machine sends it to the one that edits the
 * seat's canvas, whose row for the seat is built from it.
 */
export type SeatOffboardFacts = {
  /** When the seat last came to rest (epoch ms, on the reader's clock). Absent while it is not at rest. */
  readonly stillSince?: number;
  /** The cache window for the seat's harness, in minutes. */
  readonly windowMinutes: number;
  /** That machine's cache mode. Absent when that machine has not said it. */
  readonly cacheMode?: CacheMode;
  /** Time spent working in its current session (ms). */
  readonly workMs: number;
  /**
   * The session's context in tokens, as its harness recorded it on its
   * latest model call. Absent when the harness has not recorded it: a
   * transcript estimate decides `worth` there but is never sent.
   */
  readonly tokens?: number;
  /** The session has done enough for that machine's automatic rules to act on it. */
  readonly worth: boolean;
};

/** A session's size: either basis judges `worth`, only `recorded` is ever shown. */
export type SessionSizeRead = { readonly tokens: number; readonly basis: "recorded" | "estimated" };

/** The tokens a size shows when its basis is the harness's own count. */
const recordedTokens = (size: SessionSizeRead | undefined): number | undefined =>
  size?.basis === "recorded" ? size.tokens : undefined;

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
  readonly markEnded: (seat: SeatAddress, sessionId: string, by: OffboardBy, at: number) => void;
  /**
   * The session's size in tokens, and its basis (term/session-size.ts):
   * `recorded` is the harness's own count, `estimated` is the transcript's
   * bytes and overcounts a compacted session. Undefined when the transcript
   * cannot be located: the session is then judged on work time alone.
   * Absent port: no size is known for any seat.
   */
  readonly sessionSize?: (seat: OffboardSeat) => SessionSizeRead | undefined;
  readonly rules: () => OffboardRules;
  /**
   * The operator's hold on the seat, here or from the machine editing its
   * canvas: undefined when not held, `until` when only recent typing holds it,
   * no `until` while a window shows it, then `typedUntil` when typing holds it
   * too. A held seat's session is not cut. Absent port: nothing is ever held.
   */
  readonly held?: (seat: OffboardSeat, at: number) => { readonly until?: number; readonly typedUntil?: number } | undefined;
  /**
   * What the machine that runs a seat elsewhere last said of its session.
   * Absent port, or undefined: nothing is known of it here.
   */
  readonly remote?: (seat: OffboardSeat) => Promise<SeatOffboardFacts | undefined>;
  /** Save the clock (called once per tick). */
  readonly saveClock?: (record: SeatClockRecord) => void;
  /** The seats due the auto mode's question changed: the whole list. Absent: no one shows it. */
  readonly dueChanged?: (questions: ReadonlyArray<SeatCacheQuestion>) => void;
  /** A new question id. 16 random bytes, base64url, by default. */
  readonly mintQuestion?: () => string;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
};

/**
 * A seat due the auto mode's question, as this machine asks it: the window's
 * entry, and the seat's binding and generation the question is bound to. A
 * view of the seat from a linked machine is asked it too (seat-attach.ts).
 */
export type SeatCacheQuestion = SeatCacheDue & { readonly bindingId: string; readonly generation: string };

/** An answer settled the question (`cut`: Start fresh ended the session), or named none open. */
export type SeatCacheAnswerOutcome = { readonly settled: false } | { readonly settled: true; readonly cut: boolean };

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

/** One clock save: the seats whose saved row is out of date, and the seats no longer kept. */
export type SeatClockChanges = {
  readonly savedAt: number;
  readonly seats: SeatClockRecord["seats"];
  readonly removed: ReadonlyArray<string>;
};

/** A time as the clock table keeps it: whole, never negative. */
const wholeTime = (value: number | undefined): number | undefined =>
  value === undefined || !Number.isFinite(value) ? undefined : Math.max(0, Math.floor(value));

const sameSavedSeat = (a: SeatClockRecord["seats"][string], b: SeatClockRecord["seats"][string]): boolean =>
  wholeTime(a.idleSince) === wholeTime(b.idleSince) &&
  wholeTime(a.activitySince) === wholeTime(b.activitySince) &&
  (a.offboarded === true) === (b.offboarded === true) &&
  (wholeTime(a.workMs) ?? 0) === (wholeTime(b.workMs) ?? 0) &&
  (a.sessionId?.trim() || undefined) === (b.sessionId?.trim() || undefined);

/**
 * What a save must write, given the seats as last saved: a seat whose row
 * would read differently, and every seat still active after rest, since its
 * row's save time bounds when it came to rest across a restart. A seat at
 * rest whose row reads the same is left alone.
 */
export const seatClockChanges = (saved: SeatClockRecord["seats"], next: SeatClockRecord): SeatClockChanges => {
  const seats: Record<string, SeatClockRecord["seats"][string]> = {};
  for (const [bindingId, seat] of Object.entries(next.seats)) {
    const before = saved[bindingId];
    if (before === undefined || !sameSavedSeat(before, seat) || activeAfterRest({ idleSince: seat.idleSince, activitySince: seat.activitySince })) seats[bindingId] = seat;
  }
  const removed = Object.keys(saved).filter((bindingId) => !(bindingId in next.seats));
  return { savedAt: next.savedAt, seats, removed };
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
   * The operator typed into the seat. A key warms its session as a turn does:
   * a seat at rest is still from now. One that is active comes to rest later.
   */
  noteTyped(bindingId: string): void {
    const entry = this.entry(bindingId);
    if (!activeAfterRest(entry)) entry.idleSince = Math.max(entry.idleSince ?? this.now(), this.now());
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
  /** Seats the operator answered Keep while shown: not asked again until they leave every screen. */
  const kept = new Set<string>();
  /** Seats due the auto mode's question, as the last pass found them, each with its open question. */
  let due = new Map<string, SeatCacheQuestion>();
  const mintQuestion = ports.mintQuestion ?? (() => randomBytes(16).toString("base64url"));

  const modeOf = (seat: OffboardSeat) => offboardRulesFor(ports.rules(), seat.harness).cacheMode;

  /** A window shows the seat, here or on the machine editing its canvas: a hold with no end. */
  const shown = (seat: OffboardSeat, at: number): boolean => {
    const hold = ports.held?.(seat, at);
    return hold !== undefined && hold.until === undefined;
  };

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
  ): { readonly workMs: number; readonly size?: SessionSizeRead; readonly worth: boolean } => {
    clock.syncSession(seat.bindingId, seat.sessionId);
    const workMs = clock.workMs(seat.bindingId);
    const threshold = offboardRulesFor(ports.rules(), seat.harness).worth;
    const byWork = sessionWorthCutting(threshold, { workMs });
    let size: SessionSizeRead | undefined;
    if (seat.sessionId !== undefined && (withSize || (workMs > 0 && !byWork))) {
      try {
        size = ports.sessionSize?.(seat);
      } catch {
        size = undefined;
      }
    }
    return {
      workMs,
      ...(size !== undefined ? { size } : {}),
      worth: byWork || sessionWorthCutting(threshold, { workMs, ...(size !== undefined ? { tokens: size.tokens } : {}) }),
    };
  };

  /** This machine's clock and rules on a seat it runs, read at `at`. */
  const factsOf = (seat: OffboardSeat, at: number): SeatOffboardFacts => {
    const still = stillness(seat, at);
    const done = worthOf(seat, true);
    const set = offboardRulesFor(ports.rules(), seat.harness);
    const tokens = recordedTokens(done.size);
    return {
      ...(still.since !== undefined ? { stillSince: still.since } : {}),
      windowMinutes: set.cacheWindowMinutes,
      cacheMode: set.cacheMode,
      workMs: done.workMs,
      ...(tokens !== undefined ? { tokens } : {}),
      worth: done.worth,
    };
  };

  /** What this machine says of a seat it runs, for the machine that edits its canvas. */
  const facts = async (address: SeatAddress): Promise<SeatOffboardFacts | undefined> => {
    const seat = await ports.locate(address).catch(() => undefined);
    return seat === undefined || !seat.local ? undefined : factsOf(seat, now());
  };

  /**
   * A seat run elsewhere: the row its own machine's clock and rules give, as
   * that machine last said. What it said never enters this clock or a cut
   * here, and when it has said nothing the row knows nothing. It prefers ask:
   * this machine refuses to close a seat it does not run.
   */
  const remoteRow = (
    seatId: string,
    allowed: SeatOffboardStatus["now"],
    told: SeatOffboardFacts | undefined,
    at: number,
  ): SeatOffboardStatus => {
    if (told === undefined) return { seatId, now: allowed, idleMinutes: null, pastWindow: false, preferred: "ask" };
    const minutes = told.stillSince === undefined ? null : wholeMinutesBetween(told.stillSince, at);
    const pastWindow = minutes !== null && minutes >= told.windowMinutes;
    return {
      seatId,
      now: allowed,
      ...(told.stillSince !== undefined ? { stillSince: told.stillSince } : {}),
      idleMinutes: minutes,
      pastWindow,
      preferred: "ask",
      workMinutes: Math.floor(told.workMs / 60_000),
      ...(told.tokens !== undefined ? { sessionTokens: told.tokens } : {}),
      worthCutting: told.worth,
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
        if (seat !== undefined && !seat.local)
          return remoteRow(seatId, allowed, await ports.remote?.(seat).catch(() => undefined), at);
        const still = seat ? stillness(seat, at) : { minutes: null, pastWindow: false };
        const done = seat ? worthOf(seat, true) : { workMs: 0, worth: false };
        const tokens = recordedTokens(done.size);
        return {
          seatId,
          now: allowed,
          ...(still.since !== undefined ? { stillSince: still.since } : {}),
          idleMinutes: still.minutes,
          pastWindow: still.pastWindow,
          preferred: still.pastWindow ? "now" : "ask",
          workMinutes: Math.floor(done.workMs / 60_000),
          ...(tokens !== undefined ? { sessionTokens: tokens } : {}),
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
    // session rather than a cut or a fresh start of it.
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
   * Has this seat's session gone cold, so that a turn given now would start
   * on a fresh session? The one test behind the cut, the start decision and
   * what the seat shows. When not cold yet, `at` is when it will be if nothing
   * moves; absent, nothing but a move can make it cold. `holds`: which of
   * the operator's holds count. At a start none do, since opening a resting
   * seat is the start itself and no running session is on screen to be pulled
   * from; for the auto mode's question only typing does, since being shown is
   * what it asks about. The mode is the caller's.
   */
  const coldness = (
    seat: OffboardSeat,
    address: SeatAddress,
    holds: "all" | "typing" | "none" = "all",
  ): { readonly cold: boolean; readonly at?: number } => {
    if (seat.sessionId === undefined) return { cold: false };
    // Blocked or needs-you: the session waits on the operator and is kept,
    // by the pass, the start and the card alike.
    if (seat.waitsOnOperator === true) return { cold: false };
    const set = offboardRulesFor(ports.rules(), seat.harness);
    if (clock.isFresh(seat.bindingId)) return { cold: false };
    if (!mayCloseNow(seat, address).allowed) return { cold: false };
    const at = now();
    const still = stillness(seat, at);
    if (still.minutes === null) return { cold: false };
    const coldAt = still.since === undefined ? undefined : still.since + set.cacheWindowMinutes * 60_000;
    // Held, it goes cold no sooner than the hold ends. A shown seat's hold
    // ends when its window lets go, which asks again; typing's at a known time.
    const held = holds === "none" ? undefined : ports.held?.(seat, at);
    // Typing alone: every grace, shown or not, from any window or view.
    const typedUntil = held?.until ?? held?.typedUntil;
    const hold = holds !== "typing" ? held : typedUntil === undefined ? undefined : { until: typedUntil };
    if (hold !== undefined)
      return hold.until === undefined || coldAt === undefined ? { cold: false } : { cold: false, at: Math.max(hold.until, coldAt) };
    if (still.minutes < set.cacheWindowMinutes) return coldAt === undefined ? { cold: false } : { cold: false, at: coldAt };
    // Never recycle an empty or tiny session. Asked last: the size reads the transcript.
    return { cold: worthOf(seat, false).worth };
  };

  /**
   * The start of a resting seat by its machine's mode and why it starts: off
   * and manual resume; auto starts a cold session fresh; hybrid does too,
   * except when the operator opens the seat.
   */
  const coldForStart = (
    seat: OffboardSeat,
    address: SeatAddress,
    cause: SeatStartCause,
  ): { readonly cold: boolean; readonly at?: number } => {
    const mode = modeOf(seat);
    if (mode === "off" || mode === "manual") return { cold: false };
    if (mode === "hybrid" && cause === "operator") return { cold: false };
    return coldness(seat, address, "none");
  };

  /**
   * A seat this machine runs is about to start from rest: has its session
   * gone cold, so the start begins a fresh one (`coldForStart`)? A running
   * seat is not starting, and keeps its session. A seat just asked to
   * offboard keeps it too: that ask is mail for this session, and a fresh one
   * would throw it away. Never throws: false resumes.
   */
  const coldAtStart = async (address: SeatAddress, cause: SeatStartCause): Promise<boolean> => {
    try {
      const seat = await ports.locate(address);
      if (seat === undefined || !seat.local || seat.running) return false;
      if ((asking.get(keyOf(address)) ?? 0) > now()) return false;
      return coldForStart(seat, address, cause).cold;
    } catch (error) {
      ports.log?.(`the start decision for ${address.seatId} failed, so it resumes: ${String(error)}`);
      return false;
    }
  };

  /**
   * Whether the seat's next turn starts on a fresh session, by the same tests
   * as the cut and the start. A running seat is cut only in auto and hybrid;
   * a resting one starts as the operator's open would start it. `launch` is
   * what a start does for a seat that is not running. Undefined for a seat
   * this installation does not run: its own machine answers for it.
   */
  const nextTurn = async (address: SeatAddress, launch: SeatNextLaunch): Promise<SeatNextTurn | undefined> => {
    const seat = await ports.locate(address).catch(() => undefined);
    if (seat === undefined || !seat.local) return undefined;
    const mode = modeOf(seat);
    const cold = !seat.running
      ? coldForStart(seat, address, "operator")
      : mode === "off" || mode === "manual" ? { cold: false } : coldness(seat, address);
    return seatNextTurn({ running: seat.running, launch, cold });
  };

  /**
   * The eager cut, for one seat at the minute pass: a running seat at rest
   * (idle, or done with a turn unseen) whose session has gone cold, on a
   * canvas that is playing, not waiting on the operator and not just asked to
   * offboard, in auto or hybrid. Off and manual never cut. In auto, a seat
   * open in front of the operator is not cut but asked: it goes in `asks`.
   * Undefined when the seat is not cut. Never throws.
   */
  const cutIfDue = async (
    seat: OffboardSeat,
    at: number,
    asks: Map<string, SeatCacheQuestion>,
  ): Promise<SeatOffboardRunRow | undefined> => {
    const address = { canvasName: seat.canvasName, seatId: seat.seatId };
    const key = keyOf(address);
    try {
      if (!seat.local) return undefined;
      const open = shown(seat, at);
      if (!open) kept.delete(key);
      if (!seat.running || seat.state !== "idle") return undefined;
      if (seat.paused === true) return undefined;
      if ((asking.get(key) ?? 0) > now()) return undefined;
      const mode = modeOf(seat);
      if (mode === "off" || mode === "manual") return undefined;
      if (!coldness(seat, address).cold) {
        if (mode === "auto" && open && !kept.has(key) && seat.generation !== undefined &&
          coldness(seat, address, "typing").cold) {
          const window = offboardRulesFor(ports.rules(), seat.harness).cacheWindowMinutes;
          const since = stillness(seat, at).since ?? at;
          // Due since the last pass on the same process: the same question. Otherwise a new one.
          const standing = due.get(key);
          const tokens = recordedTokens(ports.sessionSize?.(seat));
          asks.set(key, {
            canvasName: seat.canvasName,
            seatId: seat.seatId,
            question: standing?.generation === seat.generation ? standing.question : mintQuestion(),
            windowEndsAt: since + window * 60_000,
            ...(tokens === undefined ? {} : { tokens }),
            bindingId: seat.bindingId,
            generation: seat.generation,
          });
        }
        return undefined;
      }
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
    const at = now();
    const asks = new Map<string, SeatCacheQuestion>();
    const rows = (await Promise.all(seats.map((seat) => cutIfDue(seat, at, asks)))).filter((row) => row !== undefined);
    const present = new Set(seats.map((seat) => keyOf(seat)));
    for (const key of kept) if (!present.has(key)) kept.delete(key);
    setDue(asks);
    try {
      ports.saveClock?.(clock.record());
    } catch {
      ports.log?.("the offboard clock could not be saved");
    }
    return summarizeOffboardRun(rows);
  };

  /** The open questions, as this machine asks them. */
  const questions = (): ReadonlyArray<SeatCacheQuestion> => [...due.values()];

  /** The seats due the question, as a window lists them. */
  const dueList = (): ReadonlyArray<SeatCacheDue> =>
    questions().map(({ bindingId: _binding, generation: _generation, ...ask }) => ask);

  /** Replace the seats due the question, and tell whoever shows it when that changed. */
  const setDue = (next: Map<string, SeatCacheQuestion>): void => {
    const same = next.size === due.size &&
      [...next].every(([key, ask]) => {
        const was = due.get(key);
        return was?.question === ask.question && was.windowEndsAt === ask.windowEndsAt && was.tokens === ask.tokens;
      });
    due = next;
    if (same) return;
    try {
      ports.dueChanged?.(questions());
    } catch {
      ports.log?.("the seats due a choice could not be told");
    }
  };

  /**
   * Start fresh, re-checked as the automatic rule would check the seat if no
   * one watched it: the same process, running, idle, not waiting on the
   * operator, its canvas playing, not just asked to offboard, in auto, and
   * cold with only being shown left out. Every typing grace counts, from a
   * window here or a view on a linked machine. Then the same cut, once, by the
   * operator. Never throws: false cuts nothing.
   */
  const freshIfStillDue = async (address: SeatAddress, asked: SeatCacheQuestion): Promise<boolean> => {
    try {
      const seat = await ports.locate(address);
      if (seat === undefined || !seat.local || !seat.running || seat.state !== "idle") return false;
      if (seat.generation !== asked.generation || seat.paused === true) return false;
      if ((asking.get(keyOf(address)) ?? 0) > now()) return false;
      if (modeOf(seat) !== "auto" || !coldness(seat, address, "typing").cold) return false;
      const row = await closeOne(address, "operator");
      if (row.ok) ports.log?.(`${address.seatId}: fresh by operator`);
      else ports.log?.(`fresh by operator for ${address.seatId} did not go through: ${row.reason}`);
      return row.ok;
    } catch (error) {
      ports.log?.(`fresh by operator for ${address.seatId} failed: ${String(error)}`);
      return false;
    }
  };

  /**
   * The operator's answer to the auto mode's question, from a window here or
   * a view on a linked machine. It names the open question for the seat, and
   * for its process when a view answers: anything else settles nothing. The
   * first answer settles it. Keep leaves the session, and the seat is not
   * asked again until it leaves every screen; Start fresh cuts as the rule
   * would (`freshIfStillDue`).
   */
  const answerDue = async (
    address: SeatAddress,
    question: string,
    answer: SeatCacheDueAnswer,
    generation?: string,
  ): Promise<SeatCacheAnswerOutcome> => {
    const key = keyOf(address);
    const asked = due.get(key);
    if (asked === undefined || asked.question !== question) return { settled: false };
    if (generation !== undefined && asked.generation !== generation) return { settled: false };
    const rest = new Map(due);
    rest.delete(key);
    setDue(rest);
    if (answer === "keep") {
      kept.add(key);
      return { settled: true, cut: false };
    }
    return { settled: true, cut: await freshIfStillDue(address, asked) };
  };

  /** A start ended the seat's cold session for a fresh one: Junto ended it, with no notes. */
  const endedAtStart = (address: SeatAddress, bindingId: string, sessionId: string): void => {
    try {
      ports.markEnded(address, sessionId, "automatic", now());
    } catch {
      ports.log?.(`could not record who ended ${sessionId} for ${address.seatId}`);
    }
    clock.markOffboarded(bindingId);
  };

  /**
   * A seat's next turn and how it stands against its cache window, from one
   * read of the seat: a card asks both, and the read is the whole cost.
   */
  const launchOf = async (
    address: SeatAddress,
    want: SeatNextLaunch,
  ): Promise<{ readonly nextTurn?: SeatNextTurn; readonly facts?: SeatOffboardFacts }> => {
    const seat = await ports.locate(address).catch(() => undefined);
    if (seat === undefined || !seat.local) return {};
    const mode = modeOf(seat);
    const cold = !seat.running
      ? coldForStart(seat, address, "operator")
      : mode === "off" || mode === "manual" ? { cold: false } : coldness(seat, address);
    return { nextTurn: seatNextTurn({ running: seat.running, launch: want, cold }), facts: factsOf(seat, now()) };
  };

  return { run, status, facts, tick, coldAtStart, endedAtStart, nextTurn, launch: launchOf, dueList, questions, answerDue, clock };
};

export type OperatorOffboard = ReturnType<typeof makeOperatorOffboard>;

/** How often the automatic rules look. Rule intervals are whole minutes. */
export const OFFBOARD_TICK_MS = 60_000;

// ── The process instance ───────────────────────────────────────────────────

let current: OperatorOffboard | undefined;

/** Install the app's operation (composition), or a fake (tests); undefined clears it. */
export const setOperatorOffboard = (next: OperatorOffboard | undefined): void => {
  current = next;
  seatCacheQuestionsChanged();
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
 * The start decision: whether a cold session starts fresh. Every start of a
 * seat this machine runs asks it before naming the session
 * (sessionBeforeStart), by the test the pass and the card use, and the
 * machine's cache mode says what that means for why the seat starts.
 *
 * The installed operation reads the rules first, outside its own guard: a
 * failure anywhere costs the fresh start, never the start. False resumes.
 */
export const coldSessionStartsFresh = (seat: SeatAddress, cause: SeatStartCause): Promise<boolean> => {
  if (current === undefined) return Promise.resolve(false);
  return current.coldAtStart(seat, cause).catch((error: unknown) => {
    console.error(`[offboard] the start decision for ${seat.canvasName}/${seat.seatId} failed, so it resumes: ${String(error)}`);
    return false;
  });
};

/** The seats due the auto mode's question now, as a window lists them. Empty before the operation is installed. */
export const seatCacheDueList = (): ReadonlyArray<SeatCacheDue> => current?.dueList() ?? [];

/** The questions this machine has open, for the views of its seats on linked machines. */
export const seatCacheQuestions = (): ReadonlyArray<SeatCacheQuestion> => current?.questions() ?? [];

const questionListeners = new Set<() => void>();
/** Told when this machine's open questions change. */
export const subscribeSeatCacheQuestions = (listener: () => void): (() => void) => {
  questionListeners.add(listener);
  return () => { questionListeners.delete(listener); };
};
/** The installed operation's questions changed (its `dueChanged` port), or another was installed. */
export const seatCacheQuestionsChanged = (): void => {
  for (const listener of questionListeners) {
    try {
      listener();
    } catch (error) {
      console.error("[offboard] a listener for the cache questions failed:", error);
    }
  }
};

/**
 * An answer to one of this machine's questions. `generation`: a view's, so
 * a question asked of one process is never answered for another. Nothing
 * installed, or a failure: nothing settled, and nothing cut.
 */
export const answerSeatCacheQuestion = (
  seat: SeatAddress,
  question: string,
  answer: SeatCacheDueAnswer,
  generation?: string,
): Promise<SeatCacheAnswerOutcome> =>
  current
    ? current.answerDue(seat, question, answer, generation).catch((error: unknown) => {
        console.error(`[offboard] an answer for ${seat.seatId} failed: ${String(error)}`);
        return { settled: false as const };
      })
    : Promise.resolve({ settled: false as const });

/** The operator's answer, from this machine's window, to its question for one of the seats it runs. */
export const answerSeatCacheDue = async (
  seat: SeatAddress,
  question: string,
  answer: SeatCacheDueAnswer,
): Promise<SeatCacheDueAnswerResult> => {
  if (current === undefined) return { ok: false, message: NOT_READY };
  const outcome = await answerSeatCacheQuestion(seat, question, answer);
  return outcome.settled ? { ok: true } : { ok: false, message: CACHE_QUESTION_GONE };
};

/** An answer to a question already answered, or no longer asked. */
export const CACHE_QUESTION_GONE = "This seat was already answered, or is no longer asking.";

/** The start ended the seat's cold session (`coldSessionStartsFresh`): record that Junto ended it. */
export const coldSessionEnded = (seat: SeatAddress, bindingId: string, sessionId: string): void => {
  current?.endedAtStart(seat, bindingId, sessionId);
};

/**
 * What this machine's offboard clock and rules say of a seat it runs, for
 * the machine that edits its canvas. Undefined before the operation is
 * installed, and for a seat on another machine.
 */
export const seatOffboardFactsOf = (seat: SeatAddress): Promise<SeatOffboardFacts | undefined> =>
  current ? current.facts(seat).catch(() => undefined) : Promise.resolve(undefined);

/**
 * Both answers a card asks of a running seat, from one read of it: what its
 * next turn does, and how its session stands against its cache window. Empty
 * before the operation is installed, and for a seat on another machine.
 */
export const seatLaunchOf = (
  seat: SeatAddress,
  launch: SeatNextLaunch,
): Promise<{ readonly nextTurn?: SeatNextTurn; readonly facts?: SeatOffboardFacts }> =>
  current ? current.launch(seat, launch).catch(() => ({})) : Promise.resolve({});

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
