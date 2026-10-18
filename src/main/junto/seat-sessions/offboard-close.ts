/**
 * The offboard closer: `junto offboard` ends the session, mechanically and
 * at once.
 *
 * The moment an offboard is announced (its notes are on disk and its reply
 * has been written back to the agent's CLI), the closer rotates the seat:
 * the session ends, the seat gets a fresh session id, and its process is
 * stopped. Nothing is waited for: not an idle seat, not a settle, not a tick.
 * The turn in flight is cut; that is what offboard means.
 *
 * rest: the seat rests; whatever wakes it next starts the fresh session,
 * which onboards into the notes.
 *
 * continue: the same, then Junto starts the fresh session as soon as the old
 * process is gone and has it told, in one line, to read its handoff.
 *
 * From the offboard until the old process is gone nothing is typed into the
 * seat (the closing fence, sealed where the offboard is accepted). The fence
 * lifts with the process; if the close fails before the process was stopped,
 * the closer releases it.
 *
 * Each seat is its own: many seats offboarding in the same instant are all
 * stopped in that instant, and one that fails or hangs delays no other.
 *
 * The closer also keeps where each seat's offboard stands (asked, saved,
 * resting, started, waiting, failed) for the operator. Everything it touches
 * comes in through ports, so it runs the same against the app and a test.
 */
import type { OffboardMode, SeatAddress, SeatOffboardProgress, SeatOffboardStage } from "@shared/seat-sessions";
import type { SeatRotateResult } from "./rotate";
import type { SeatOffboardEvent } from "./service";

export type OffboardClosePorts = {
  /**
   * End the session, give the seat a fresh one and stop its process; start
   * the fresh one only when `wake`. Resolves once the old process is gone.
   */
  readonly close: (seat: SeatAddress, wake: boolean) => Promise<SeatRotateResult>;
  /** Have the fresh session of a continuing seat told to read its handoff. */
  readonly kickoff: (seat: SeatAddress) => Promise<boolean>;
  /**
   * The close failed before the seat's process was stopped: the session goes
   * on, so lift the fence that was keeping everything out of it.
   */
  readonly release?: (seat: SeatAddress) => void;
  /**
   * Keep everything out of the seat's running session from now: it is being
   * closed from outside. (An agent's own offboard is sealed where it is
   * answered, before its reply.)
   */
  readonly seal?: (seat: SeatAddress) => Promise<void> | void;
  readonly publish: (progress: SeatOffboardProgress) => void;
  /** Told whenever an agent's `junto offboard` has been answered. */
  readonly onOffboard?: (listener: (event: SeatOffboardEvent) => void) => () => void;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
};

/** Who can end a session from outside it. */
export type OffboardOutside = Exclude<NonNullable<SeatOffboardProgress["by"]>, "agent">;

const addressOf = (entry: SeatAddress): SeatAddress => ({ seatId: entry.seatId, canvasName: entry.canvasName });

const keyOf = (seat: SeatAddress): string => `${seat.canvasName}\u0000${seat.seatId}`;

export class SeatOffboardCloser {
  /** Seats being closed right now, each with its own flight. */
  private readonly closing = new Map<string, Promise<void>>();
  private readonly progress = new Map<string, SeatOffboardProgress>();
  /** Closes in flight that did not come from the seat's own agent, and who asked. */
  private readonly outside = new Map<string, OffboardOutside>();
  private unsubscribeOffboard: (() => void) | undefined;

  constructor(private readonly ports: OffboardClosePorts) {}

  /** Listen for offboards. There is no clock: each one is acted on as it arrives. */
  start(): void {
    if (this.unsubscribeOffboard !== undefined) return;
    this.unsubscribeOffboard = this.ports.onOffboard?.((event) => void this.offboarded(event)) ?? (() => {});
  }

  stop(): void {
    this.unsubscribeOffboard?.();
    this.unsubscribeOffboard = undefined;
  }

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  private report(seat: SeatAddress, mode: OffboardMode, stage: SeatOffboardStage, message?: string): void {
    const key = keyOf(seat);
    const outside = this.outside.get(key);
    const at = this.now();
    // An ask carries through to the close it led to; a new ask starts over.
    const previous = this.progress.get(key);
    const askedAt = stage === "asked" ? at : previous?.stage === "asked" || previous?.stage === "saved" ? previous.askedAt : undefined;
    const progress: SeatOffboardProgress = {
      seatId: seat.seatId,
      canvasName: seat.canvasName,
      mode,
      stage,
      at,
      ...(askedAt !== undefined ? { askedAt } : {}),
      ...(message ? { message } : {}),
      // Closed from outside the session: who did it, and that it left no notes.
      ...(outside !== undefined && stage !== "asked" ? { by: outside, notes: false } : {}),
    };
    this.progress.set(key, progress);
    this.ports.publish(progress);
  }

  /** The operator sent the offboard prompt for this mode. */
  asked(seat: SeatAddress, mode: OffboardMode): void {
    this.report(seat, mode, "asked");
  }

  /**
   * An agent's `junto offboard` was answered: close its session now. The stop
   * is issued before this returns; the promise settles when the close is
   * through (the old process gone, the fresh one started or the seat at rest).
   */
  offboarded(event: SeatOffboardEvent): Promise<void> {
    const seat = addressOf(event);
    const key = keyOf(seat);
    const flying = this.closing.get(key);
    if (flying !== undefined) {
      // That session is already ending; it cannot offboard twice.
      this.ports.log?.(`${event.seatId} offboarded again while its session was closing; ignored`);
      return flying;
    }
    this.report(seat, event.mode, "saved");
    const flight = this.close(seat, event.mode).finally(() => {
      if (this.closing.get(key) === flight) this.closing.delete(key);
    });
    this.closing.set(key, flight);
    return flight;
  }

  /** A close of this seat's session is in flight, whoever started it. */
  isClosing(seat: SeatAddress): boolean {
    return this.closing.has(keyOf(seat));
  }

  /**
   * Close a seat's session from outside it: the operator, the overseer, or a
   * rule. No agent turn and no notes; from there it is the same close an
   * agent's own offboard gets. Whether the seat may be closed is the
   * caller's to decide. A seat already closing is not closed twice: this
   * returns the flight in progress.
   */
  closeNow(seat: SeatAddress, options: { readonly mode: OffboardMode; readonly by: OffboardOutside }): Promise<void> {
    const address = addressOf(seat);
    const key = keyOf(address);
    const flying = this.closing.get(key);
    if (flying !== undefined) return flying;
    this.outside.set(key, options.by);
    this.report(address, options.mode, "saved");
    const flight = (async () => {
      try {
        await this.ports.seal?.(address);
      } catch (error) {
        this.ports.log?.(`could not seal ${address.seatId} before closing it: ${String(error)}`);
      }
      await this.close(address, options.mode);
    })().finally(() => {
      if (this.closing.get(key) === flight) this.closing.delete(key);
      this.outside.delete(key);
    });
    this.closing.set(key, flight);
    return flight;
  }

  /** Where every seat's latest offboard stands, for a renderer that just started. */
  current(): ReadonlyArray<SeatOffboardProgress> {
    return [...this.progress.values()];
  }

  private async close(seat: SeatAddress, mode: OffboardMode): Promise<void> {
    const wake = mode === "continue";
    let result: SeatRotateResult;
    try {
      // Called in the same turn of the event loop as the offboard arrived.
      result = await this.ports.close(seat, wake);
    } catch (error) {
      result = { ok: false, reason: String(error) };
    }
    if (!result.ok) {
      this.ports.release?.(seat);
      this.ports.log?.(`closing ${seat.seatId} failed: ${result.reason}`);
      this.report(seat, mode, "failed", result.reason);
      return;
    }
    if (!wake) {
      this.ports.log?.(`${seat.seatId} offboarded; its session closed and the seat rests`);
      this.report(seat, mode, "resting");
      return;
    }
    // The continuation is owed to a seat that did not start (a paused
    // canvas) too, and reaches the fresh session when it does.
    const told = await this.ports.kickoff(seat).catch(() => false);
    if (!told) {
      this.report(seat, mode, "failed", "The fresh session is ready, but Junto could not send it the kickoff.");
      return;
    }
    this.ports.log?.(`${seat.seatId} offboarded; continuing in a fresh session`);
    this.report(seat, mode, result.woke ? "started" : "waiting");
  }
}
