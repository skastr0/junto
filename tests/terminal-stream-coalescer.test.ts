import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalHostEvent } from "../src/main/vellum/term/local-host";
import {
  TERMINAL_STREAM_FLUSH_BYTES,
  TERMINAL_STREAM_FLUSH_MS,
  TERMINAL_STREAM_INTERACTIVE_FLUSH_MS,
  TerminalStreamCoalescer,
  terminalBindingKey,
} from "../src/main/vellum/term/stream-coalescer";

const output = (
  seq: bigint,
  data: string,
  bindingId = "b1",
  epoch = "e1",
): LocalHostEvent => ({ type: "output", bindingId, epoch, seq, data });

const exit = (seq: bigint, bindingId = "b1", epoch = "e1"): LocalHostEvent => ({
  type: "exit",
  bindingId,
  epoch,
  seq,
  code: 0,
  signal: undefined,
});

const asOutput = (
  e: LocalHostEvent,
): Extract<LocalHostEvent, { readonly type: "output" }> => {
  if (e.type !== "output") throw new Error("expected output event");
  return e;
};


describe("TerminalStreamCoalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("batches chunks into one event per flush window with the last seq", () => {
    const seen: LocalHostEvent[] = [];
    const coalescer = new TerminalStreamCoalescer((e) => seen.push(e), 50, 1024);

    coalescer.push(output(1n, "a"));
    coalescer.push(output(2n, "b"));
    coalescer.push(output(3n, "c"));
    expect(seen).toHaveLength(0);

    vi.advanceTimersByTime(50);
    expect(seen).toHaveLength(1);
    expect(asOutput(seen[0])).toMatchObject({
      type: "output",
      bindingId: "b1",
      epoch: "e1",
      seq: 3n,
      data: "abc",
    });
  });

  it("flushes immediately once the byte cap is reached", () => {
    const seen: LocalHostEvent[] = [];
    const coalescer = new TerminalStreamCoalescer((e) => seen.push(e), 50, 8);

    coalescer.push(output(1n, "1234"));
    coalescer.push(output(2n, "5678")); // 8 bytes total → immediate flush
    expect(seen).toHaveLength(1);
    expect(asOutput(seen[0])).toMatchObject({ seq: 2n, data: "12345678" });
  });

  it("control events flush pending output first, preserving order", () => {
    const seen: LocalHostEvent[] = [];
    const coalescer = new TerminalStreamCoalescer((e) => seen.push(e), 50, 1024);

    coalescer.push(output(1n, "tail"));
    coalescer.push(exit(2n));
    expect(seen.map((e) => e.type)).toEqual(["output", "exit"]);
    expect(asOutput(seen[0])).toMatchObject({ data: "tail", seq: 1n });
  });

  it("keeps separate buffers per binding+epoch", () => {
    const seen: LocalHostEvent[] = [];
    const coalescer = new TerminalStreamCoalescer((e) => seen.push(e), 50, 1024);

    coalescer.push(output(1n, "x", "b1", "e1"));
    coalescer.push(output(1n, "y", "b2", "e2"));
    vi.advanceTimersByTime(50);

    expect(seen).toHaveLength(2);
    expect(seen.map((e) => [e.bindingId, asOutput(e).data])).toEqual([
      ["b1", "x"],
      ["b2", "y"],
    ]);
  });

  it("drop discards buffered output and cancels the timer", () => {
    const seen: LocalHostEvent[] = [];
    const coalescer = new TerminalStreamCoalescer((e) => seen.push(e), 50, 1024);

    coalescer.push(output(1n, "discard me"));
    coalescer.drop("b1", "e1");
    vi.advanceTimersByTime(100);
    expect(seen).toHaveLength(0);
  });

  it("flushAll emits everything pending", () => {
    const seen: LocalHostEvent[] = [];
    const coalescer = new TerminalStreamCoalescer((e) => seen.push(e), 50, 1024);

    coalescer.push(output(1n, "a"));
    coalescer.push(output(2n, "b"));
    coalescer.flushAll();
    expect(seen).toHaveLength(1);
    expect(asOutput(seen[0])).toMatchObject({ data: "ab" });
  });

  it("terminalBindingKey is stable", () => {
    expect(terminalBindingKey("b1", "e1")).toBe("b1:e1");
  });
});

describe("cadence follows who is driving the surface", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives a driven binding one frame and everything else the long window", () => {
    const seen: LocalHostEvent[] = [];
    const driven = new Set(["focused"]);
    const coalescer = new TerminalStreamCoalescer(
      (payload) => seen.push(payload),
      TERMINAL_STREAM_FLUSH_MS,
      TERMINAL_STREAM_FLUSH_BYTES,
      (bindingId) => driven.has(bindingId),
      TERMINAL_STREAM_INTERACTIVE_FLUSH_MS,
    );

    coalescer.push(output(1n, "a", "focused"));
    coalescer.push(output(1n, "a", "background"));

    // One frame: the surface the operator drives has already painted; the
    // other has not. This is the whole point — a full-screen TUI repaints
    // through the PTY, so its frame rate is this window.
    vi.advanceTimersByTime(TERMINAL_STREAM_INTERACTIVE_FLUSH_MS);
    expect(seen.map((e) => e.bindingId)).toEqual(["focused"]);

    vi.advanceTimersByTime(TERMINAL_STREAM_FLUSH_MS);
    expect(seen.map((e) => e.bindingId)).toEqual(["focused", "background"]);
  });

  it("still batches within the frame rather than emitting per chunk", () => {
    const seen: LocalHostEvent[] = [];
    const coalescer = new TerminalStreamCoalescer(
      (payload) => seen.push(payload),
      TERMINAL_STREAM_FLUSH_MS,
      TERMINAL_STREAM_FLUSH_BYTES,
      () => true,
      TERMINAL_STREAM_INTERACTIVE_FLUSH_MS,
    );

    for (let i = 1; i <= 40; i++) coalescer.push(output(BigInt(i), `c${i}`));
    vi.advanceTimersByTime(TERMINAL_STREAM_INTERACTIVE_FLUSH_MS);

    // A repaint storm cannot post more IPC messages than the display can show.
    expect(seen).toHaveLength(1);
    expect(asOutput(seen[0]!).seq).toBe(40n);
  });

  it("falls back to the long window when the ownership probe throws", () => {
    const seen: LocalHostEvent[] = [];
    const coalescer = new TerminalStreamCoalescer(
      (payload) => seen.push(payload),
      TERMINAL_STREAM_FLUSH_MS,
      TERMINAL_STREAM_FLUSH_BYTES,
      () => {
        throw new Error("ownership probe is broken");
      },
      TERMINAL_STREAM_INTERACTIVE_FLUSH_MS,
    );

    coalescer.push(output(1n, "a"));
    vi.advanceTimersByTime(TERMINAL_STREAM_INTERACTIVE_FLUSH_MS);
    expect(seen).toHaveLength(0);

    // Degraded, never dropped.
    vi.advanceTimersByTime(TERMINAL_STREAM_FLUSH_MS);
    expect(seen).toHaveLength(1);
  });
});
