import type { LocalHostEvent } from "./local-host";

export const TERMINAL_STREAM_FLUSH_MS = 50;
export const TERMINAL_STREAM_FLUSH_BYTES = 64 * 1024;

type OutputBuffer = {
  readonly bindingId: string;
  readonly epoch: string;
  chunks: string[];
  bytes: number;
  seq: bigint;
  timer: ReturnType<typeof setTimeout> | undefined;
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
 */
export class TerminalStreamCoalescer {
  private readonly buffers = new Map<string, OutputBuffer>();

  constructor(
    private readonly sink: (payload: LocalHostEvent) => void,
    private readonly flushMs: number = TERMINAL_STREAM_FLUSH_MS,
    private readonly flushBytes: number = TERMINAL_STREAM_FLUSH_BYTES,
  ) {}

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
        timer: undefined,
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
    if (buf.timer === undefined) {
      buf.timer = setTimeout(() => this.flush(key), this.flushMs);
      buf.timer.unref?.();
    }
  }

  /** Emit buffered output for a binding now (ordering point for control events). */
  flush(key: string): void {
    const buf = this.buffers.get(key);
    if (!buf) return;
    if (buf.timer !== undefined) {
      clearTimeout(buf.timer);
      buf.timer = undefined;
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
    if (buf.timer !== undefined) clearTimeout(buf.timer);
    this.buffers.delete(key);
  }

  flushAll(): void {
    for (const key of [...this.buffers.keys()]) this.flush(key);
  }
}
