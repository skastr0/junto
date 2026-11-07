/**
 * The drain manager: what becomes of a session after it offboards.
 *
 * `junto offboard` moves the seat on at once: the fresh session takes the
 * binding and everything addressed to the seat. The old process is not
 * killed. It is detached, in a world of its own under a drain key: nothing
 * reaches it, and Junto keeps reading it. These sessions are meant to be
 * read back and verified, so the last turn is left to finish and its
 * transcript is whole.
 *
 * This manager decides when a draining process is done:
 *  - it reads idle, and stays idle for the settle: stopped, "settled";
 *  - ten minutes after the detach, whatever it is doing: stopped, "cap";
 *  - it exits by itself: "settled" on a clean exit, "crashed" otherwise;
 *  - Junto quits: "quit".
 * How each one ended goes on record, beside when it was detached.
 *
 * Every drain is independent: many seats at once, and more than one drain
 * per seat (the fresh session may offboard while its predecessor still winds
 * down). Everything outside the clock comes in through ports.
 */

/** How a draining session's process came to an end. */
export type DrainEnd = "settled" | "cap" | "crashed" | "quit";

export type DrainingSession = {
  readonly seatId: string;
  /** The session that offboarded, when the seat named one. */
  readonly sessionId: string;
  /** The key the detached process lives under; never the seat's binding. */
  readonly drainKey: string;
};

export type SessionDrainPorts = {
  /** The detached process reads idle between turns, confirmed, right now. */
  readonly isIdle: (drainKey: string) => boolean;
  /**
   * Stop the detached process: TERM, then KILL on the host's own bound. Its
   * exit is told through `noteExit`.
   */
  readonly stop: (drainKey: string) => void;
  readonly record: {
    /** The offboard did not go through: this session was not offboarded after all. */
    readonly cancel?: (draining: DrainingSession) => void;
    readonly begin: (draining: DrainingSession, at: number) => void;
    readonly end: (draining: DrainingSession, how: DrainEnd, at: number) => void;
  };
  readonly now?: () => number;
  readonly log?: (message: string) => void;
};

/** How long a draining process must read idle before it is stopped. */
export const DRAIN_SETTLE_MS = 2_000;
/** A draining process is stopped this long after its detach, whatever it is doing. */
export const DRAIN_CAP_MS = 10 * 60 * 1_000;

type Drain = {
  readonly session: DrainingSession;
  readonly cap: ReturnType<typeof setTimeout>;
  settle: ReturnType<typeof setTimeout> | undefined;
  /** Why Junto stopped it, once it has; the exit that follows is recorded as this. */
  stopping: DrainEnd | undefined;
};

export class SessionDrainManager {
  private readonly drains = new Map<string, Drain>();

  constructor(private readonly ports: SessionDrainPorts) {}

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  /** The process was just detached from its seat: manage it to its end. */
  begin(session: DrainingSession): void {
    if (this.drains.has(session.drainKey)) return;
    const cap = setTimeout(() => this.stop(session.drainKey, "cap"), DRAIN_CAP_MS);
    cap.unref?.();
    const drain: Drain = { session, cap, settle: undefined, stopping: undefined };
    this.drains.set(session.drainKey, drain);
    try {
      this.ports.record.begin(session, this.now());
    } catch (error) {
      this.ports.log?.(`could not record the drain of ${session.sessionId}: ${String(error)}`);
    }
    // It may have finished its turn already.
    this.noteState(session.drainKey);
  }

  /** The detached process's seat state was read again. */
  noteState(drainKey: string): void {
    const drain = this.drains.get(drainKey);
    if (drain === undefined || drain.stopping !== undefined) return;
    if (!this.ports.isIdle(drainKey)) {
      if (drain.settle !== undefined) clearTimeout(drain.settle);
      drain.settle = undefined;
      return;
    }
    if (drain.settle !== undefined) return;
    drain.settle = setTimeout(() => {
      drain.settle = undefined;
      // Read again at the end of the settle: a turn may have begun and the
      // event for it not arrived.
      if (this.ports.isIdle(drainKey)) this.stop(drainKey, "settled");
    }, DRAIN_SETTLE_MS);
    drain.settle.unref?.();
  }

  private stop(drainKey: string, how: DrainEnd): void {
    const drain = this.drains.get(drainKey);
    if (drain === undefined || drain.stopping !== undefined) return;
    drain.stopping = how;
    this.clearTimers(drain);
    this.ports.log?.(`stopping the offboarded session ${drain.session.sessionId} (${how})`);
    try {
      this.ports.stop(drainKey);
    } catch (error) {
      this.ports.log?.(`could not stop the offboarded session ${drain.session.sessionId}: ${String(error)}`);
    }
  }

  /**
   * The offboard that detached this process did not go through: its seat
   * could not be given a fresh session and still names this one. The process
   * is stopped now, and the session has no wind-down on record: it was not
   * offboarded, and the seat's next wake resumes it. False when unknown.
   */
  abandon(drainKey: string): boolean {
    const drain = this.drains.get(drainKey);
    if (drain === undefined) return false;
    this.clearTimers(drain);
    this.drains.delete(drainKey);
    this.ports.log?.(`stopping ${drain.session.sessionId}: its offboard did not go through, and its seat keeps it`);
    try {
      this.ports.record.cancel?.(drain.session);
    } catch (error) {
      this.ports.log?.(`could not clear the drain of ${drain.session.sessionId}: ${String(error)}`);
    }
    try {
      this.ports.stop(drainKey);
    } catch (error) {
      this.ports.log?.(`could not stop ${drain.session.sessionId}: ${String(error)}`);
    }
    return true;
  }

  /** The detached process is gone. */
  noteExit(drainKey: string, code: number | undefined): void {
    const drain = this.drains.get(drainKey);
    if (drain === undefined) return;
    this.finish(drain, drain.stopping ?? (code === 0 ? "settled" : "crashed"));
  }

  /**
   * Junto is quitting: the host stops every process it holds. What was still
   * draining is recorded as ended by that, now, while the record can be written.
   */
  quit(): void {
    for (const drain of [...this.drains.values()]) this.finish(drain, "quit");
  }

  /** Sessions still winding down. */
  draining(): ReadonlyArray<DrainingSession> {
    return [...this.drains.values()].map((drain) => drain.session);
  }

  private clearTimers(drain: Drain): void {
    clearTimeout(drain.cap);
    if (drain.settle !== undefined) clearTimeout(drain.settle);
    drain.settle = undefined;
  }

  private finish(drain: Drain, how: DrainEnd): void {
    this.clearTimers(drain);
    this.drains.delete(drain.session.drainKey);
    try {
      this.ports.record.end(drain.session, how, this.now());
    } catch (error) {
      this.ports.log?.(`could not record the end of ${drain.session.sessionId}: ${String(error)}`);
    }
  }
}
