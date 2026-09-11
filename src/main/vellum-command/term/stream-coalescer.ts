import type { LocalHostEvent } from "./local-host";

export const TERMINAL_STREAM_FLUSH_MS = 50;
export const TERMINAL_STREAM_FLUSH_BYTES = 64 * 1024;

/**
 * A flush that has been scheduled and not yet run. Cancelling is part of the
 * contract: `drop()` and every early flush must be able to take a scheduled
 * batch back, whether it is sitting on a timer or on the immediate queue.
 */
type PendingFlush = {
  readonly cancel: () => void;
};

type OutputBuffer = {
  readonly bindingId: string;
  readonly epoch: string;
  chunks: string[];
  bytes: number;
  seq: bigint;
  pending: PendingFlush | undefined;
};

export const terminalBindingKey = (bindingId: string, epoch: string): string =>
  `${bindingId}:${epoch}`;

/**
 * Coalesces PTY output chunks per binding+epoch before they reach the
 * renderer fan-out. Observation (journal, seat-state) is untouched — this
 * only shapes IPC: N chunks/second become one `output` event per flush
 * window, so open terminal surfaces parse and redraw at a bounded cadence
 * instead of once per OS chunk. With hundreds of observed streams this is
 * what keeps the renderer cost proportional to visible surfaces, not to
 * stream volume.
 *
 * Ordering law: non-output events (resize/exit/session) flush pending
 * output first, so a binding's event order is preserved. The batched event
 * carries the last chunk's `seq` — the renderer's replay dedup keys on seq.
 *
 * Cadence is per binding, not global, and the two cadences answer different
 * questions:
 *
 * - **Driven** (the operator holds a control lease) — coalesced per **event
 *   loop turn** via `setImmediate`. Every chunk that arrived in the same turn
 *   ships as one event, on that same turn. A fixed window is a throughput
 *   argument, but the cost the operator feels is latency: a chunk landing just
 *   after a flush waits the entire window, so any constant is a guess and an
 *   unlucky chunk pays for the guess. Per-turn coalescing keeps the batching
 *   and drops the waiting.
 * - **Undriven** — the unchanged {@link TERMINAL_STREAM_FLUSH_MS} timer.
 *   Bounding aggregate cost across hundreds of background streams is exactly
 *   what that window is for, and no operator is watching them.
 *
 * Why the immediate cannot starve the event loop: a flush is armed only in
 * `push()`, only when nothing is pending, and the flush callback arms nothing
 * — it emits and returns with the buffer already deleted. So the next
 * immediate requires the next PTY chunk, which requires another trip through
 * the poll phase. There is no self-feeding chain. Even if one were introduced,
 * an immediate queued from inside the check phase runs on the *next* loop
 * iteration, so timers and I/O still get their turn — unlike `process.nextTick`
 * or a microtask, which drain before the loop can advance at all.
 *
 * `interactive` is asked at arm time only, so a binding that changes hands
 * mid-buffer runs at most one batch on the previous cadence.
 */
export class TerminalStreamCoalescer {
  private readonly buffers = new Map<string, OutputBuffer>();

  constructor(
    private readonly sink: (payload: LocalHostEvent) => void,
    private readonly flushMs: number = TERMINAL_STREAM_FLUSH_MS,
    private readonly flushBytes: number = TERMINAL_STREAM_FLUSH_BYTES,
    private readonly interactive: (bindingId: string) => boolean = () => false,
  ) {}

  /** Is the operator driving this binding right now? */
  private isDriven(bindingId: string): boolean {
    try {
      return this.interactive(bindingId);
    } catch {
      // A broken ownership probe must never stall a stream: fall back to the
      // conservative window rather than dropping the event.
      return false;
    }
  }

  /** Arm this binding's next batch: same turn if driven, else one window. */
  private schedule(key: string, bindingId: string): PendingFlush {
    if (this.isDriven(bindingId)) {
      const handle = setImmediate(() => this.flush(key));
      handle.unref?.();
      return { cancel: () => clearImmediate(handle) };
    }
    const handle = setTimeout(() => this.flush(key), this.flushMs);
    handle.unref?.();
    return { cancel: () => clearTimeout(handle) };
  }

  push(event: LocalHostEvent): void {
    if (event.type !== "output") {
      this.flush(terminalBindingKey(event.bindingId, event.epoch));
      this.sink(event);
      return;
    }
    const key = terminalBindingKey(event.bindingId, event.epoch);
    let buf = this.buffers.get(key);
    if (!buf) {
      buf = {
        bindingId: event.bindingId,
        epoch: event.epoch,
        chunks: [],
        bytes: 0,
        seq: 0n,
        pending: undefined,
      };
      this.buffers.set(key, buf);
    }
    buf.chunks.push(event.data);
    buf.bytes += event.data.length;
    buf.seq = event.seq;
    if (buf.bytes >= this.flushBytes) {
      this.flush(key);
      return;
    }
    if (buf.pending === undefined) {
      buf.pending = this.schedule(key, event.bindingId);
    }
  }

  /** Emit buffered output for a binding now (ordering point for control events). */
  flush(key: string): void {
    const buf = this.buffers.get(key);
    if (!buf) return;
    if (buf.pending !== undefined) {
      buf.pending.cancel();
      buf.pending = undefined;
    }
    this.buffers.delete(key);
    if (buf.chunks.length === 0) return;
    this.sink({
      type: "output",
      bindingId: buf.bindingId,
      epoch: buf.epoch,
      seq: buf.seq,
      data: buf.chunks.join(""),
    });
  }

  /** Drop buffered output without emitting (no owners left for the binding). */
  drop(bindingId: string, epoch: string): void {
    const key = terminalBindingKey(bindingId, epoch);
    const buf = this.buffers.get(key);
    if (!buf) return;
    buf.pending?.cancel();
    this.buffers.delete(key);
  }

  flushAll(): void {
    for (const key of [...this.buffers.keys()]) this.flush(key);
  }
}
