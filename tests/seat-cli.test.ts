import { describe, expect, it } from "vitest";
import {
  SEAT_READ_MAX_SECONDS,
  SEAT_WAIT_DEFAULT_MS,
  SEAT_WAIT_MAX_MS,
} from "../src/shared/seat-control";
import {
  lowerSeatRead,
  lowerSeatWait,
  lowerTaskWait,
} from "../src/cli/commands/seat";

// The CLI's job on these ops is the flag surface and the transport timeout that
// must sit above the operation's own deadline. Both are pure translations, so
// they are tested without a running app.

describe("seat wait lowering", () => {
  it("lowers a named seat with the default bounded timeout", () => {
    const lowered = lowerSeatWait({ seat: "peer", any: false, until: "idle", timeout: undefined });
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.args).toEqual({ target: "peer", until: "idle", timeoutMs: SEAT_WAIT_DEFAULT_MS });
    expect(lowered.socketTimeoutMs).toBeGreaterThan(SEAT_WAIT_DEFAULT_MS);
  });

  it("lowers --any and a spoken duration", () => {
    const lowered = lowerSeatWait({ seat: undefined, any: true, until: "gone", timeout: "600s" });
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.args).toEqual({ any: true, until: "gone", timeoutMs: SEAT_WAIT_MAX_MS });
    expect(lowered.socketTimeoutMs).toBe(SEAT_WAIT_MAX_MS + 5_000);
  });

  it("refuses both, neither, an unknown state and an out-of-range timeout", () => {
    const both = lowerSeatWait({ seat: "peer", any: true, until: "idle", timeout: undefined });
    expect(both.ok).toBe(false);
    const neither = lowerSeatWait({ seat: undefined, any: false, until: "idle", timeout: undefined });
    expect(neither.ok).toBe(false);
    const unknown = lowerSeatWait({ seat: "peer", any: false, until: "done", timeout: undefined });
    expect(unknown.ok).toBe(false);
    const oversize = lowerSeatWait({ seat: "peer", any: false, until: "idle", timeout: "601s" });
    expect(oversize.ok).toBe(false);
    if (!oversize.ok) expect(oversize.error.message).toContain("capped at 600s");
  });
});

describe("seat read lowering", () => {
  it("lowers a window read and budgets the transport above it", () => {
    const lowered = lowerSeatRead({
      seat: "peer",
      lines: 200,
      since: undefined,
      sinceGeneration: undefined,
      follow: false,
      maxSeconds: undefined,
    });
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.args).toEqual({ target: "peer", lines: 200 });
    expect(lowered.socketTimeoutMs).toBeGreaterThanOrEqual(30_000);
  });

  it("lowers a follow with a cursor and keeps the generation with the sequence", () => {
    const lowered = lowerSeatRead({
      seat: "peer",
      lines: 40,
      since: "12",
      sinceGeneration: "e1",
      follow: true,
      maxSeconds: "5",
    });
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.args).toEqual({
      target: "peer",
      lines: 40,
      since: 12,
      sinceGeneration: "e1",
      follow: true,
      maxSeconds: 5,
    });
    expect(lowered.socketTimeoutMs).toBe(10_000);
  });

  it("reads a bare --max-seconds as seconds, and a spelled duration as written", () => {
    const bare = lowerSeatRead({
      seat: "peer",
      lines: undefined,
      since: undefined,
      sinceGeneration: undefined,
      follow: true,
      maxSeconds: "5",
    });
    expect(bare.ok).toBe(true);
    if (bare.ok) {
      expect(bare.args.maxSeconds).toBe(5);
      expect(bare.socketTimeoutMs).toBe(10_000);
    }

    const spelled = lowerSeatRead({
      seat: "peer",
      lines: undefined,
      since: undefined,
      sinceGeneration: undefined,
      follow: true,
      maxSeconds: "5m",
    });
    expect(spelled.ok).toBe(true);
    if (spelled.ok) expect(spelled.args.maxSeconds).toBe(300);

    for (const rejected of ["500ms", "0", "1.5"]) {
      expect(
        lowerSeatRead({
          seat: "peer",
          lines: undefined,
          since: undefined,
          sinceGeneration: undefined,
          follow: true,
          maxSeconds: rejected,
        }).ok,
        rejected,
      ).toBe(false);
    }
  });

  it("refuses a cursor without its generation, a bare max-seconds and an over-long follow", () => {
    const noGeneration = lowerSeatRead({
      seat: "peer",
      lines: undefined,
      since: "12",
      sinceGeneration: undefined,
      follow: false,
      maxSeconds: undefined,
    });
    expect(noGeneration.ok).toBe(false);
    if (!noGeneration.ok) expect(noGeneration.error.path).toBe("since");

    const strayMax = lowerSeatRead({
      seat: "peer",
      lines: undefined,
      since: undefined,
      sinceGeneration: undefined,
      follow: false,
      maxSeconds: "5",
    });
    expect(strayMax.ok).toBe(false);

    const oversize = lowerSeatRead({
      seat: "peer",
      lines: undefined,
      since: undefined,
      sinceGeneration: undefined,
      follow: true,
      maxSeconds: `${SEAT_READ_MAX_SECONDS + 1}s`,
    });
    expect(oversize.ok).toBe(false);

    const tooManyLines = lowerSeatRead({
      seat: "peer",
      lines: 5_000,
      since: undefined,
      sinceGeneration: undefined,
      follow: false,
      maxSeconds: undefined,
    });
    expect(tooManyLines.ok).toBe(false);
  });
});

describe("tasks wait lowering", () => {
  it("lowers a task wait with its sink and bounded timeout", () => {
    const lowered = lowerTaskWait({
      task: "t1",
      target: "sink",
      until: "rejected",
      timeout: "90s",
    });
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.args).toEqual({
      target: "sink",
      taskId: "t1",
      until: "rejected",
      timeoutMs: 90_000,
    });
    expect(lowered.socketTimeoutMs).toBe(95_000);
  });

  it("refuses an unknown task state", () => {
    const lowered = lowerTaskWait({
      task: "t1",
      target: "sink",
      until: "canceled",
      timeout: undefined,
    });
    expect(lowered.ok).toBe(false);
  });
});
