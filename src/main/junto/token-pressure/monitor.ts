/**
 * The token-pressure monitor: every few seconds, for each running local seat,
 * read how full its live context is, and when it crosses its threshold tell
 * the agent to offboard. Once per crossing, and only while the seat sits idle
 * between turns, never mid-turn. If the pressure is still there when the
 * grace period ends, ask for the seat to be rotated (again between turns).
 *
 * Everything outside the clock and the files comes in through ports, so the
 * monitor runs the same against the app and against a test.
 */
import {
  composeOffboardNudge,
  effectiveThreshold,
  harnessReadsContext,
  pressureKey,
  resolveLimit,
  stepPressure,
  type ContextReading,
  type PressurePhase,
  type SeatPressureSnapshot,
  type SeatTokenPressure,
  type TokenPressureChange,
  type TokenPressureSettings,
} from "@shared/token-pressure";
import { contextReaderFor, type SeatSessionRef } from "./readers";
import { SessionTail } from "./session-tail";

export type PressureSeat = SeatSessionRef & {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly bindingId: string;
  /** Empty while the seat has not learned its session id yet. */
  readonly sessionId: string;
  readonly override?: SeatTokenPressure;
};

export type PressureRotateResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type TokenPressurePorts = {
  /** Local agent seats with a harness, read off the canvases. */
  readonly listSeats: () => Promise<ReadonlyArray<PressureSeat>>;
  /** The seat's process is running. */
  readonly isLive: (bindingId: string) => boolean;
  /** The seat is idle between turns, confirmed (the same gate mail typing uses). */
  readonly isIdle: (bindingId: string) => boolean;
  readonly settings: () => TokenPressureSettings;
  /** Deliver the nudge as mail on the seat's ordinary delivery path. */
  readonly nudge: (seat: PressureSeat, text: string) => Promise<boolean>;
  /**
   * End the seat's session and start a fresh one in its place. Absent until
   * the rotation API exists on this build; the seat then stays marked overdue.
   */
  readonly rotate?: () => ((seat: PressureSeat) => Promise<PressureRotateResult>) | undefined;
  /**
   * Told whenever an agent runs `junto offboard`. The monitor rotates that
   * seat at its next idle moment; offboarding never rotates by itself.
   */
  readonly onOffboard?: (
    listener: (event: { readonly seatId: string; readonly canvasName: string; readonly sessionId?: string }) => void,
  ) => () => void;
  /** Changed and removed snapshots since the last publish. */
  readonly publish: (change: TokenPressureChange) => void;
  readonly home: () => string;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
};

export { pressureKey, type TokenPressureChange };

export const TOKEN_PRESSURE_TICK_MS = 5_000;
const SEAT_REFRESH_MS = 15_000;
/** A session file not found yet is looked for again after this long. */
const LOCATE_RETRY_MS = 30_000;

type TailEntry = {
  readonly tail: SessionTail<ContextReading> | undefined;
  readonly lookedAt: number;
};

type PhaseEntry = {
  readonly sessionId: string;
  phase: PressurePhase;
  /** Rotation was asked for and could not happen; shown, never retried in a loop. */
  rotation?: "unavailable" | "failed";
};

export class TokenPressureMonitor {
  private seats: ReadonlyArray<PressureSeat> = [];
  private seatsAt = Number.NEGATIVE_INFINITY;
  private readonly tails = new Map<string, TailEntry>();
  private readonly phases = new Map<string, PhaseEntry>();
  private readonly published = new Map<string, string>();
  private readonly snapshots = new Map<string, SeatPressureSnapshot>();
  /** Seats whose agent offboarded, by key, with the session it left. */
  private readonly offboards = new Map<string, string | undefined>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribeOffboard: (() => void) | undefined;
  private running = false;

  constructor(private readonly ports: TokenPressurePorts) {}

  start(intervalMs = TOKEN_PRESSURE_TICK_MS): void {
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

  /** An agent ran `junto offboard`: rotate it at its next idle tick. */
  offboarded(event: { readonly seatId: string; readonly canvasName: string; readonly sessionId?: string }): void {
    this.offboards.set(pressureKey(event.canvasName, event.seatId), event.sessionId);
  }

  /** Re-read the seat list on the next tick (a canvas changed). */
  invalidateSeats(): void {
    this.seatsAt = Number.NEGATIVE_INFINITY;
  }

  /** Current snapshots, for a renderer that just started. */
  current(): ReadonlyArray<SeatPressureSnapshot> {
    return [...this.snapshots.values()];
  }

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  /** One pass over every running seat. Overlapping ticks are skipped. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.now();
      if (now - this.seatsAt >= SEAT_REFRESH_MS) {
        try {
          this.seats = await this.ports.listSeats();
          this.seatsAt = now;
        } catch (error) {
          this.ports.log?.(`seat list failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const settings = this.ports.settings();
      const seen = new Set<string>();
      const upserts: SeatPressureSnapshot[] = [];
      for (const seat of this.seats) {
        if (!this.ports.isLive(seat.bindingId)) continue;
        const key = pressureKey(seat.canvasName, seat.nodeId);
        seen.add(key);
        const snapshot = await this.evaluate(seat, key, settings, now);
        this.snapshots.set(key, snapshot);
        const signature = JSON.stringify({ ...snapshot, at: 0 });
        if (this.published.get(key) !== signature) {
          this.published.set(key, signature);
          upserts.push(snapshot);
        }
      }
      const removed: string[] = [];
      for (const key of [...this.published.keys()]) {
        if (seen.has(key)) continue;
        this.published.delete(key);
        this.snapshots.delete(key);
        this.phases.delete(key);
        removed.push(key);
      }
      this.forgetTails();
      if (upserts.length > 0 || removed.length > 0) this.ports.publish({ upserts, removed });
    } finally {
      this.running = false;
    }
  }

  private readingFor(seat: PressureSeat, now: number): ContextReading | undefined {
    const reader = contextReaderFor(seat.harness);
    if (reader === undefined || !seat.sessionId) return undefined;
    const tailKey = `${seat.harness}:${seat.sessionId}`;
    let entry = this.tails.get(tailKey);
    if (entry === undefined || (entry.tail === undefined && now - entry.lookedAt >= LOCATE_RETRY_MS)) {
      const path = reader.locate(seat, this.ports.home());
      entry = {
        tail: path === undefined ? undefined : new SessionTail(path, (line) => reader.parseLine(line, seat)),
        lookedAt: now,
      };
      this.tails.set(tailKey, entry);
    }
    return entry.tail?.read();
  }

  /** Drop tails no running seat reads any more. */
  private forgetTails(): void {
    const wanted = new Set(
      this.seats.filter((seat) => this.ports.isLive(seat.bindingId)).map((seat) => `${seat.harness}:${seat.sessionId}`),
    );
    for (const key of this.tails.keys()) if (!wanted.has(key)) this.tails.delete(key);
  }

  private async evaluate(
    seat: PressureSeat,
    key: string,
    settings: TokenPressureSettings,
    now: number,
  ): Promise<SeatPressureSnapshot> {
    const base = { canvasName: seat.canvasName, nodeId: seat.nodeId, harness: seat.harness, at: now };
    // State belongs to one session: a seat that offboarded into a new one
    // starts clean, and is never chased for its old session's pressure.
    let entry = this.phases.get(key);
    if (entry === undefined || entry.sessionId !== seat.sessionId) {
      entry = { sessionId: seat.sessionId, phase: { phase: "below" } };
      this.phases.set(key, entry);
    }
    const chosen = effectiveThreshold(seat.override, settings);
    await this.rotateIfOffboarded(seat, key, entry, chosen !== undefined, now);
    if (!harnessReadsContext(seat.harness)) {
      return { ...base, status: "unsupported", phase: entry.phase.phase, ...rotationOf(entry) };
    }
    const reading = this.readingFor(seat, now);
    if (reading === undefined) {
      return { ...base, status: "no-session", phase: entry.phase.phase, ...rotationOf(entry) };
    }
    const limit = chosen === undefined ? undefined : resolveLimit(chosen.threshold, reading.window);
    const numbers = {
      ...base,
      status: "reading" as const,
      usedTokens: reading.usedTokens,
      ...(reading.window !== undefined ? { window: reading.window } : {}),
      ...(reading.windowSource !== undefined ? { windowSource: reading.windowSource } : {}),
      ...(chosen !== undefined ? { thresholdFrom: chosen.from } : {}),
    };
    if (limit === undefined || !limit.ok) {
      if (entry.phase.phase !== "rotating") entry.phase = { phase: "below" };
      return { ...numbers, ...(limit !== undefined ? { limitBlocked: limit.reason } : {}), phase: "below" };
    }

    const step = stepPressure(entry.phase, {
      usedTokens: reading.usedTokens,
      limitTokens: limit.limitTokens,
      idle: this.ports.isIdle(seat.bindingId),
      now,
      graceMs: settings.graceMinutes * 60_000,
    });
    const previous = entry.phase;
    entry.phase = step.next;
    if (step.next.phase === "below") entry.rotation = undefined;
    if (step.action === "nudge") {
      const text = composeOffboardNudge({
        usedTokens: reading.usedTokens,
        limitTokens: limit.limitTokens,
        graceMinutes: settings.graceMinutes,
      });
      const sent = await this.ports.nudge(seat, text).catch(() => false);
      // Not delivered: still over, and the next idle tick tries again.
      if (!sent) entry.phase = previous.phase === "below" ? { phase: "over", since: now } : previous;
      else this.ports.log?.(`nudged ${key} at ${reading.usedTokens} of ${limit.limitTokens}`);
    } else if (step.action === "rotate") {
      this.ports.log?.(`grace ended for ${key} at ${reading.usedTokens} of ${limit.limitTokens}`);
      await this.rotate(seat, key, entry);
    }
    return {
      ...numbers,
      limitTokens: limit.limitTokens,
      phase: entry.phase.phase,
      ...rotationOf(entry),
    };
  }

  /**
   * The agent offboarded this session: rotate at its first idle tick. Only
   * for a seat whose pressure policy is on; a seat set to off is left alone.
   */
  private async rotateIfOffboarded(
    seat: PressureSeat,
    key: string,
    entry: PhaseEntry,
    policyOn: boolean,
    now: number,
  ): Promise<void> {
    if (!this.offboards.has(key)) return;
    const left = this.offboards.get(key);
    if (left !== undefined && left !== seat.sessionId) {
      // The seat already moved to another session: that offboard is spent.
      this.offboards.delete(key);
      return;
    }
    if (!policyOn || entry.phase.phase === "rotating") {
      this.offboards.delete(key);
      return;
    }
    if (!this.ports.isIdle(seat.bindingId)) return;
    this.offboards.delete(key);
    entry.phase = { phase: "rotating", at: now };
    this.ports.log?.(`${key} offboarded; rotating`);
    await this.rotate(seat, key, entry);
  }

  private async rotate(seat: PressureSeat, key: string, entry: PhaseEntry): Promise<void> {
    const rotate = this.ports.rotate?.();
    if (rotate === undefined) {
      entry.rotation = "unavailable";
      this.ports.log?.(`rotation for ${key} is not available on this build`);
      return;
    }
    const result = await rotate(seat).catch(
      (error: unknown): PressureRotateResult => ({ ok: false, reason: String(error) }),
    );
    if (!result.ok) {
      entry.rotation = "failed";
      this.ports.log?.(`rotation failed for ${key}: ${result.reason}`);
    }
  }
}

const rotationOf = (entry: PhaseEntry): { readonly rotation?: "unavailable" | "failed" } =>
  entry.rotation !== undefined ? { rotation: entry.rotation } : {};
