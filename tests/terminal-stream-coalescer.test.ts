import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalHostEvent } from "../src/main/vellum-command/term/local-host";
import {
  TERMINAL_STREAM_FLUSH_BYTES,
  TERMINAL_STREAM_FLUSH_MS,
  TerminalStreamCoalescer,
  terminalBindingKey,
} from "../src/main/vellum-command/term/stream-coalescer";

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

/**
 * Waits one real event loop turn.
 *
 * Resolving on `setImmediate` puts this continuation behind anything the
 * coalescer already queued on the immediate queue, so after the await a
 * same-turn flush has necessarily run.
 */
const nextTurn = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

describe("TerminalStreamCoalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("batches chunks while preserving sequence boundaries as UTF-16 offsets", () => {
    const seen: LocalHostEvent[] = [];
    const coalescer = new TerminalStreamCoalescer((e) => seen.push(e), 50, 1024);

    coalescer.push(output(1n, "a"));
    coalescer.push(output(2n, "💡"));
    coalescer.push(output(3n, "c"));
    expect(seen).toHaveLength(0);

    vi.advanceTimersByTime(50);
    expect(seen).toHaveLength(1);
    expect(asOutput(seen[0])).toMatchObject({
      type: "output",
      bindingId: "b1",
      epoch: "e1",
      seq: 3n,
      data: "a💡c",
      chunks: [
        { seq: 1n, end: 1 },
        { seq: 2n, end: 3 },
        { seq: 3n, end: 4 },
      ],
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
    // Fake the clock but leave the immediate queue real. Vitest's default
    // `toFake` includes setImmediate, which would make "flushed on the next
    // event loop turn" indistinguishable from "flushed on a very short timer":
    // every assertion below would pass by advancing a clock and would prove
    // nothing. With setImmediate real, a driven flush can only happen because
    // a real loop turn ran, and `vi.getTimerCount()` reports exactly how many
    // flushes are still waiting on the clock.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ships a driven binding in the same turn, with no timer advance", async () => {
    const seen: LocalHostEvent[] = [];
    const coalescer = new TerminalStreamCoalescer(
      (payload) => seen.push(payload),
      TERMINAL_STREAM_FLUSH_MS,
      TERMINAL_STREAM_FLUSH_BYTES,
      () => true,
    );

    for (let i = 1; i <= 40; i++) coalescer.push(output(BigInt(i), `c${i}`));
    // Still inside the turn: nothing has been posted per chunk.
    expect(seen).toHaveLength(0);
    // And nothing is waiting on the clock — this batch never asked for a window.
    expect(vi.getTimerCount()).toBe(0);

    await nextTurn();

    // 40 chunks, one IPC event: the batching survives, the waiting does not.
    expect(seen).toHaveLength(1);
    expect(asOutput(seen[0]!).seq).toBe(40n);
    expect(asOutput(seen[0]!).data).toBe(
      Array.from({ length: 40 }, (_, i) => `c${i + 1}`).join(""),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still makes an undriven binding wait its window", async () => {
    const seen: LocalHostEvent[] = [];
    const driven = new Set(["focused"]);
    const coalescer = new TerminalStreamCoalescer(
      (payload) => seen.push(payload),
      TERMINAL_STREAM_FLUSH_MS,
      TERMINAL_STREAM_FLUSH_BYTES,
      (bindingId) => driven.has(bindingId),
    );

    coalescer.push(output(1n, "a", "focused"));
    coalescer.push(output(1n, "a", "background"));

    await nextTurn();
    expect(seen.map((e) => e.bindingId)).toEqual(["focused"]);
    // The background stream is on the clock, exactly as before.
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(TERMINAL_STREAM_FLUSH_MS - 1);
    expect(seen.map((e) => e.bindingId)).toEqual(["focused"]);

    vi.advanceTimersByTime(1);
    expect(seen.map((e) => e.bindingId)).toEqual(["focused", "background"]);
  });

  it("falls back to the long window when the ownership probe throws", async () => {
    const seen: LocalHostEvent[] = [];
    const coalescer = new TerminalStreamCoalescer(
      (payload) => seen.push(payload),
      TERMINAL_STREAM_FLUSH_MS,
      TERMINAL_STREAM_FLUSH_BYTES,
      () => {
        throw new Error("ownership probe is broken");
      },
    );

    coalescer.push(output(1n, "a"));
    await nextTurn();
    expect(seen).toHaveLength(0);

    // Degraded, never dropped.
    vi.advanceTimersByTime(TERMINAL_STREAM_FLUSH_MS);
    expect(seen).toHaveLength(1);
  });

  it("drop cancels a scheduled same-turn flush", async () => {
    const seen: LocalHostEvent[] = [];
    let driven = true;
    const coalescer = new TerminalStreamCoalescer(
      (payload) => seen.push(payload),
      TERMINAL_STREAM_FLUSH_MS,
      TERMINAL_STREAM_FLUSH_BYTES,
      () => driven,
    );

    coalescer.push(output(1n, "dropped"));
    coalescer.drop("b1", "e1");

    // Re-fill the same key on the slow cadence. A leaked immediate still
    // holds this key and would fire on the next turn, emitting the new
    // buffer long before its window — the exact bug clearImmediate prevents.
    driven = false;
    coalescer.push(output(2n, "kept"));

    await nextTurn();
    expect(seen).toHaveLength(0);

    vi.advanceTimersByTime(TERMINAL_STREAM_FLUSH_MS);
    expect(seen).toHaveLength(1);
    expect(asOutput(seen[0]!)).toMatchObject({ seq: 2n, data: "kept" });
  });

  it("byte cap still ships a driven binding synchronously", async () => {
    const seen: LocalHostEvent[] = [];
    const coalescer = new TerminalStreamCoalescer(
      (payload) => seen.push(payload),
      TERMINAL_STREAM_FLUSH_MS,
      8,
      () => true,
    );

    coalescer.push(output(1n, "1234"));
    coalescer.push(output(2n, "5678"));
    expect(seen).toHaveLength(1);
    expect(asOutput(seen[0]!)).toMatchObject({ seq: 2n, data: "12345678" });

    // The arm from the first chunk was cancelled, not left to double-emit.
    await nextTurn();
    expect(seen).toHaveLength(1);
  });

  it("control events flush a driven binding's pending output first", async () => {
    const seen: LocalHostEvent[] = [];
    const coalescer = new TerminalStreamCoalescer(
      (payload) => seen.push(payload),
      TERMINAL_STREAM_FLUSH_MS,
      TERMINAL_STREAM_FLUSH_BYTES,
      () => true,
    );

    coalescer.push(output(1n, "tail"));
    coalescer.push(exit(2n));
    expect(seen.map((e) => e.type)).toEqual(["output", "exit"]);

    await nextTurn();
    expect(seen.map((e) => e.type)).toEqual(["output", "exit"]);
  });
});
