import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  SEAT_READ_DEFAULT_FOLLOW_SECONDS,
  SEAT_READ_DEFAULT_LINES,
  SEAT_READ_MAX_BYTES,
  SEAT_READ_MAX_LINES,
  SEAT_READ_MAX_SECONDS,
  SEAT_STATES_COMPLETE,
  SEAT_TIMEOUT_ERROR,
  SEAT_WAIT_DEFAULT_MS,
  SEAT_WAIT_MAX_MS,
  SeatReadArgs,
  SeatReadResult,
  SeatWaitArgs,
  SeatWaitResult,
  TaskWaitArgs,
  TaskWaitResult,
  clampFollowSeconds,
  clampReadLines,
  clipReadText,
  socketTimeoutFor,
  utf8ByteLength,
} from "../src/shared/seat-control";

const decodes = (schema: Schema.ConstraintDecoder<unknown>, input: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(input));

describe("seat-control args", () => {
  it("takes exactly one of target and any", () => {
    expect(decodes(SeatWaitArgs, { target: "peer", until: "idle" })).toBe(true);
    expect(decodes(SeatWaitArgs, { any: true, until: "gone" })).toBe(true);
    expect(decodes(SeatWaitArgs, { until: "idle" })).toBe(false);
    expect(decodes(SeatWaitArgs, { target: "peer", any: true, until: "idle" })).toBe(false);
    expect(decodes(SeatWaitArgs, { target: "peer", any: false, until: "idle" })).toBe(true);
  });

  it("bounds the wait and refuses unknown states or extra fields", () => {
    expect(decodes(SeatWaitArgs, { target: "p", until: "idle", timeoutMs: SEAT_WAIT_MAX_MS })).toBe(true);
    expect(decodes(SeatWaitArgs, { target: "p", until: "idle", timeoutMs: SEAT_WAIT_MAX_MS + 1 })).toBe(false);
    expect(decodes(SeatWaitArgs, { target: "p", until: "idle", timeoutMs: 0 })).toBe(false);
    expect(decodes(SeatWaitArgs, { target: "p", until: "done" })).toBe(false);
    expect(decodes(SeatWaitArgs, { target: "p", until: "idle", input: "\r" })).toBe(false);
  });

  it("requires a generation with a sequence cursor and bounds the read", () => {
    expect(decodes(SeatReadArgs, { target: "p" })).toBe(true);
    expect(decodes(SeatReadArgs, { target: "p", since: 12 })).toBe(false);
    expect(decodes(SeatReadArgs, { target: "p", since: 12, sinceGeneration: "e1" })).toBe(true);
    expect(decodes(SeatReadArgs, { target: "p", lines: SEAT_READ_MAX_LINES })).toBe(true);
    expect(decodes(SeatReadArgs, { target: "p", lines: SEAT_READ_MAX_LINES + 1 })).toBe(false);
    expect(decodes(SeatReadArgs, { target: "p", follow: true, maxSeconds: SEAT_READ_MAX_SECONDS })).toBe(true);
    expect(decodes(SeatReadArgs, { target: "p", follow: true, maxSeconds: SEAT_READ_MAX_SECONDS + 1 })).toBe(false);
  });

  it("addresses a task by id, never by a loose task field", () => {
    expect(decodes(TaskWaitArgs, { target: "sink", taskId: "t1", until: "rejected" })).toBe(true);
    expect(decodes(TaskWaitArgs, { target: "sink", task: "t1", until: "rejected" })).toBe(false);
    expect(decodes(TaskWaitArgs, { target: "sink", taskId: "t1", until: "canceled" })).toBe(false);
  });

  it("covers every product seat state on the wire", () => {
    expect(SEAT_STATES_COMPLETE).toBe(true);
    expect(SEAT_TIMEOUT_ERROR).toBe("Timeout");
  });

  it("decodes the result shapes the server returns", () => {
    expect(
      decodes(SeatWaitResult, {
        target: "peer",
        state: "idle",
        reason: "settled",
        confidence: "high",
        generation: "e1",
        epoch: "e1",
        at: 1,
      }),
    ).toBe(true);
    expect(
      decodes(SeatReadResult, {
        target: "peer",
        state: "working",
        reason: "turn",
        confidence: "high",
        epoch: "e1",
        generation: "e1",
        replaced: false,
        seq: 4,
        text: "a\nb",
        lineCount: 2,
        bytes: 3,
        truncated: false,
        stopped: "not-following",
      }),
    ).toBe(true);
    expect(decodes(SeatReadResult, {
      target: "peer",
      state: "idle",
      reason: "settled",
      confidence: "high",
      epoch: "e1",
      generation: "e1",
      replaced: false,
      seq: 4,
      text: "",
      lineCount: 0,
      bytes: 0,
      truncated: false,
      stopped: "paused",
    })).toBe(false);
    expect(
      decodes(TaskWaitResult, { taskId: "t1", state: "completed", epoch: 2, at: 1 }),
    ).toBe(true);
  });
});

describe("seat-control bounds", () => {
  it("clamps a spoken window onto the wire bound", () => {
    expect(clampReadLines(undefined)).toBe(SEAT_READ_DEFAULT_LINES);
    expect(clampReadLines(0)).toBe(1);
    expect(clampReadLines(-5)).toBe(1);
    expect(clampReadLines(SEAT_READ_MAX_LINES + 100)).toBe(SEAT_READ_MAX_LINES);
    expect(clampReadLines(Number.NaN)).toBe(SEAT_READ_DEFAULT_LINES);
  });

  it("clamps a spoken follow duration onto the wire bound", () => {
    expect(clampFollowSeconds(undefined)).toBe(SEAT_READ_DEFAULT_FOLLOW_SECONDS);
    expect(clampFollowSeconds(0)).toBe(1);
    expect(clampFollowSeconds(SEAT_READ_MAX_SECONDS + 1)).toBe(SEAT_READ_MAX_SECONDS);
  });

  it("keeps the transport timeout above the operation deadline", () => {
    expect(socketTimeoutFor(600_000)).toBe(605_000);
    expect(socketTimeoutFor(60_000, 1_000)).toBe(61_000);
    expect(SEAT_WAIT_DEFAULT_MS).toBeLessThan(SEAT_WAIT_MAX_MS);
  });
});

describe("clipReadText", () => {
  it("charges a separator only between kept lines", () => {
    const exact = clipReadText(["a", "b"], 3);
    expect(exact.lines).toEqual(["a", "b"]);
    expect(exact.truncated).toBe(false);
    expect(utf8ByteLength(exact.lines.join("\n"))).toBe(3);

    const clipped = clipReadText(["a", "b", "c"], 3);
    expect(clipped.lines).toEqual(["b", "c"]);
    expect(clipped.truncated).toBe(true);
    expect(utf8ByteLength(clipped.lines.join("\n"))).toBe(3);
  });

  it("keeps a line that exactly fills the budget without claiming a clip", () => {
    const emoji = clipReadText(["🙂"], 4);
    expect(emoji.lines).toEqual(["🙂"]);
    expect(emoji.truncated).toBe(false);
    expect(utf8ByteLength(emoji.lines.join("\n"))).toBe(4);
  });

  it("clips a single multibyte line to the byte budget on a code-point boundary", () => {
    // 40_000 two-byte characters = 80_000 bytes: over the 65_536-byte bound.
    const line = "é".repeat(40_000);
    const clipped = clipReadText([line]);
    expect(clipped.truncated).toBe(true);
    const text = clipped.lines.join("\n");
    expect(utf8ByteLength(text)).toBeLessThanOrEqual(SEAT_READ_MAX_BYTES);
    expect(text.length).toBeGreaterThan(0);
    expect(line.startsWith(text)).toBe(true);
    expect([...text].every((point) => point === "é")).toBe(true);
  });

  it("never splits a surrogate pair when clipping emoji", () => {
    const line = "🙂".repeat(20_000);
    const clipped = clipReadText([line]);
    expect(clipped.truncated).toBe(true);
    const text = clipped.lines.join("\n");
    expect(utf8ByteLength(text)).toBeLessThanOrEqual(SEAT_READ_MAX_BYTES);
    // An even UTF-16 length with no lone surrogate means every pair survived.
    expect(text.length % 2).toBe(0);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)).toBe(false);
    expect([...text].every((point) => point === "🙂")).toBe(true);
  });

  it("returns nothing for an empty window", () => {
    expect(clipReadText([])).toEqual({ lines: [], truncated: false });
  });
});
