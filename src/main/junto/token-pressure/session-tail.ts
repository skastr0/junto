/**
 * Incremental tail of an append-only JSONL session file.
 *
 * Harness transcripts grow to tens of megabytes and a station watches
 * hundreds of them, so a tick never reparses a file: it stats it, reads only
 * the bytes appended since the last tick, and keeps the latest reading the
 * parser found. A first read starts near the end (the latest usage record is
 * always recent), and a file that shrank or was replaced starts over.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";

/** Bytes a first read looks back from the end for the latest record. */
export const TAIL_FIRST_WINDOW_BYTES = 4 * 1024 * 1024;
/** Bytes one tick reads at most; the rest waits for the next tick. */
export const TAIL_TICK_BUDGET_BYTES = 8 * 1024 * 1024;

const NEWLINE = 0x0a;

export class SessionTail<T> {
  /** Byte offset of the first unread complete line. */
  private offset = 0;
  private identity = "";
  /** The offset may sit inside a record (a first read from mid-file). */
  private aligned = true;
  private latest: T | undefined;

  constructor(
    readonly path: string,
    /** Sees every complete line; reject cheaply before parsing JSON. */
    private readonly parseLine: (line: string) => T | undefined,
  ) {}

  /** The latest reading after taking in whatever was appended. */
  read(): T | undefined {
    let size: number;
    let identity: string;
    try {
      const stat = statSync(this.path);
      size = stat.size;
      identity = `${stat.dev}:${stat.ino}`;
    } catch {
      return this.latest;
    }
    if (identity !== this.identity || size < this.offset) {
      // A new file, or one that was truncated: start again near its end.
      this.identity = identity;
      this.offset = Math.max(0, size - TAIL_FIRST_WINDOW_BYTES);
      this.aligned = this.offset === 0;
      this.latest = undefined;
    }
    while (size > this.offset) {
      const end = Math.min(size, this.offset + TAIL_TICK_BUDGET_BYTES);
      const bytes = this.readRange(this.offset, end);
      if (bytes === undefined) return this.latest;
      let start = 0;
      if (!this.aligned) {
        const first = bytes.indexOf(NEWLINE);
        if (first < 0) {
          this.offset = end;
          continue;
        }
        start = first + 1;
        this.aligned = true;
      }
      const last = bytes.lastIndexOf(NEWLINE);
      if (last < start) {
        // No complete line yet. A line longer than the budget is skipped
        // whole rather than stalling the tail on it.
        if (end - this.offset >= TAIL_TICK_BUDGET_BYTES) {
          this.offset = end;
          this.aligned = false;
          continue;
        }
        return this.latest;
      }
      this.offset += last + 1;
      const text = bytes.subarray(start, last).toString("utf8");
      for (const line of text.split("\n")) {
        if (line.length === 0) continue;
        const reading = this.parseLine(line);
        if (reading !== undefined) this.latest = reading;
      }
      // One budget per tick; a large backlog finishes on later ticks.
      break;
    }
    return this.latest;
  }

  private readRange(start: number, end: number): Buffer | undefined {
    let fd: number | undefined;
    try {
      fd = openSync(this.path, "r");
      const buffer = Buffer.allocUnsafe(end - start);
      let read = 0;
      while (read < buffer.length) {
        const n = readSync(fd, buffer, read, buffer.length - read, start + read);
        if (n === 0) break;
        read += n;
      }
      return buffer.subarray(0, read);
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // best-effort
        }
      }
    }
  }
}
