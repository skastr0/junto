/**
 * The offboard closer: once an agent that ran `junto offboard` is idle
 * between turns, close its session in the mode the agent chose.
 *
 * rest: the session ends, the seat gets a fresh session id, and its process
 * stops. The seat rests; whatever wakes it next starts the fresh session,
 * which onboards into the notes.
 *
 * continue: the same, then Junto starts the fresh session right away and
 * tells it, in one line, to read its handoff, so it carries on unprompted.
 * Nothing else starts a session with a message: a seat that rests, or one the
 * operator opens, comes up to its own empty composer.
 *
 * The closer also keeps where each seat's offboard stands (asked, saved,
 * resting, started) for the operator. Everything outside the clock comes in
 * through ports, so the closer runs the same against the app and a test.
 */
import type { OffboardMode, SeatAddress, SeatOffboardProgress, SeatOffboardStage } from "@shared/seat-sessions";
import type { SeatRotateResult } from "./rotate";
import type { SeatOffboardEvent } from "./service";

/** The seat as the closer needs it, read off its canvas. */
export type ClosingSeat = {
  readonly bindingId: string;
  /** The session the node names now, when it names one. */
  readonly sessionId?: string;
};

export type OffboardClosePorts = {
  readonly locate: (seat: SeatAddress) => Promise<ClosingSeat | undefined>;
  /** The seat's process is running. */
  readonly isRunning: (bindingId: string) => boolean;
  /** The seat is idle between turns, confirmed (the same gate mail typing uses). */
  readonly isIdle: (bindingId: string) => boolean;
  /** End the session and give the seat a fresh one; start it only when `wake`. */
  readonly close: (seat: SeatAddress, wake: boolean) => Promise<SeatRotateResult>;
  /** Have the fresh session of a continuing seat told to read its handoff. */
  readonly kickoff: (seat: SeatAddress) => Promise<boolean>;
  readonly publish: (progress: SeatOffboardProgress) => void;
  /** Told whenever an agent runs `junto offboard`. */
  readonly onOffboard?: (listener: (event: SeatOffboardEvent) => void) => () => void;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
};

export const OFFBOARD_CLOSE_TICK_MS = 1_000;
/**
 * How long the seat must sit idle before its session closes. The agent runs
 * offboard mid-turn; this outlasts a stale idle reading and the turn's last
 * words.
 */
export const OFFBOARD_SETTLE_MS = 2_000;

type Pending = {
  readonly seatId: string;
  readonly canvasName: string;
  readonly sessionId: string;
  readonly mode: OffboardMode;
  idleSince?: number;
};

const addressOf = (entry: SeatAddress): SeatAddress => ({ seatId: entry.seatId, canvasName: entry.canvasName });

const keyOf = (canvasName: string, seatId: string): string => `${canvasName}\u0000${seatId}`;

export class SeatOffboardCloser {
  private readonly pending = new Map<string, Pending>();
  private readonly closing = new Set<string>();
  private readonly progress = new Map<string, SeatOffboardProgress>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribeOffboard: (() => void) | undefined;
  private running = false;

  constructor(private readonly ports: OffboardClosePorts) {}

  start(intervalMs = OFFBOARD_CLOSE_TICK_MS): void {
    if (this.timer !== undefined) return;
    this.unsubscribeOffboard = this.ports.onOffboard?.((event) => this.offboarded(event));
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribeOffboard?.();
    this.unsubscribeOffboard = undefined;
  }

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  private report(
    seatId: string,
    canvasName: string,
    mode: OffboardMode,
    stage: SeatOffboardStage,
    message?: string,
  ): void {
    const key = keyOf(canvasName, seatId);
    const at = this.now();
    // An ask carries through to the close it led to; a new ask starts over.
    const previous = this.progress.get(key);
    const askedAt = stage === "asked" ? at : previous?.stage === "asked" || previous?.stage === "saved" ? previous.askedAt : undefined;
    const progress: SeatOffboardProgress = {
      seatId,
      canvasName,
      mode,
      stage,
      at,
      ...(askedAt !== undefined ? { askedAt } : {}),
      ...(message ? { message } : {}),
    };
    this.progress.set(key, progress);
    this.ports.publish(progress);
  }

  /** The operator sent the offboard prompt for this mode. */
  asked(seat: SeatAddress, mode: OffboardMode): void {
    this.report(seat.seatId, seat.canvasName, mode, "asked");
  }

  /** An agent ran `junto offboard`: close its session at its next idle moment. */
  offboarded(event: SeatOffboardEvent): void {
    const key = keyOf(event.canvasName, event.seatId);
    // The latest offboard decides the mode; its notes replaced the earlier ones.
    this.pending.set(key, {
      seatId: event.seatId,
      canvasName: event.canvasName,
      sessionId: event.sessionId,
      mode: event.mode,
    });
    this.report(event.seatId, event.canvasName, event.mode, "saved");
  }

  /** Where every seat's latest offboard stands, for a renderer that just started. */
  current(): ReadonlyArray<SeatOffboardProgress> {
    return [...this.progress.values()];
  }

  /** One pass over every seat waiting to close. Overlapping ticks are skipped. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const [key, entry] of [...this.pending]) {
        await this.step(key, entry);
      }
    } finally {
      this.running = false;
    }
  }

  private async step(key: string, entry: Pending): Promise<void> {
    const seat = await this.ports.locate(addressOf(entry)).catch(() => undefined);
    if (seat === undefined) {
      this.pending.delete(key);
      this.report(entry.seatId, entry.canvasName, entry.mode, "failed", "The seat is no longer on its canvas.");
      return;
    }
    if (seat.sessionId !== undefined && seat.sessionId !== entry.sessionId) {
      // The seat already moved to another session: that offboard is spent.
      this.pending.delete(key);
      return;
    }
    // A seat with no process has no turn in flight: close it now.
    if (this.ports.isRunning(seat.bindingId)) {
      if (!this.ports.isIdle(seat.bindingId)) {
        entry.idleSince = undefined;
        return;
      }
      const now = this.now();
      entry.idleSince ??= now;
      if (now - entry.idleSince < OFFBOARD_SETTLE_MS) return;
    }
    this.pending.delete(key);
    this.closing.add(key);
    try {
      await this.close(key, entry);
    } finally {
      this.closing.delete(key);
    }
  }

  private async close(key: string, entry: Pending): Promise<void> {
    const wake = entry.mode === "continue";
    const result = await this.ports
      .close(addressOf(entry), wake)
      .catch((error: unknown): SeatRotateResult => ({ ok: false, reason: String(error) }));
    if (!result.ok) {
      this.ports.log?.(`closing ${entry.seatId} failed: ${result.reason}`);
      this.report(entry.seatId, entry.canvasName, entry.mode, "failed", result.reason);
      return;
    }
    if (!wake) {
      this.ports.log?.(`${entry.seatId} offboarded; its session closed and the seat rests`);
      this.report(entry.seatId, entry.canvasName, entry.mode, "resting");
      return;
    }
    // The kickoff waits for a seat that did not start (a paused canvas),
    // and reaches the fresh session when it does.
    const mailed = await this.ports.kickoff(addressOf(entry)).catch(() => false);
    if (!mailed) {
      this.report(
        entry.seatId,
        entry.canvasName,
        entry.mode,
        "failed",
        "The fresh session is ready, but Junto could not send it the kickoff.",
      );
      return;
    }
    this.ports.log?.(`${entry.seatId} offboarded; continuing in a fresh session`);
    this.report(entry.seatId, entry.canvasName, entry.mode, result.woke ? "started" : "waiting");
  }
}
