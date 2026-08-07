import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalHostEvent } from "../src/main/vellum/term/local-host";
import {
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
