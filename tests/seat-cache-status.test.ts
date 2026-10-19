/**
 * The still seat's cache status, in words: the line under its name and its
 * hover card, read on this window's clock; and when the card asks main again.
 */
import { describe, expect, it } from "vitest";
import {
  minutesWords,
  nextCacheStatusChange,
  seatCacheStatusCopy,
} from "../src/renderer/components/nodes/seat-cache-status";
import { nextMoment } from "../src/renderer/lib/seat-next-launch";
import type { SeatCacheWindow } from "../src/shared/seat-next-launch";

const MIN = 60_000;
const NOW = 1_800_000_000_000;

const window = (stillFor: number, extra: Partial<SeatCacheWindow> = {}): SeatCacheWindow => ({
  windowMinutes: 60,
  stillSince: NOW - stillFor * MIN,
  windowEndsAt: NOW + (60 - stillFor) * MIN,
  pastWindow: stillFor >= 60,
  pastByMs: Math.max(0, stillFor - 60) * MIN,
  ...extra,
});

const face = (stillFor: number, extra: Partial<SeatCacheWindow> = {}) => ({
  window: window(stillFor, extra),
  harness: "claude",
  machine: "this machine",
});

describe("minutesWords", () => {
  it("says minutes, then hours and minutes", () => {
    expect(minutesWords(0)).toBe("0m");
    expect(minutesWords(14)).toBe("14m");
    expect(minutesWords(60)).toBe("1h");
    expect(minutesWords(72)).toBe("1h 12m");
  });
});

describe("seatCacheStatusCopy", () => {
  it("within the window: the state and how long it has been still, no warning", () => {
    const copy = seatCacheStatusCopy("resting", face(14, { cacheMode: "hybrid" }), NOW);
    expect(copy.line).toBe("resting 14m");
    expect(copy.expired).toBe(false);
    expect(copy.rows.map((row) => row.key)).toEqual(["Status", "Cache window", "Expires", "Mode"]);
    expect(copy.rows[1]?.value).toBe("60m for Claude Code on this machine");
    expect(copy.rows[2]?.value).toMatch(/, in 46m$/);
    expect(copy.rows[3]?.value).toBe("hybrid");
    expect(copy.notes[0]).toMatch(/^Within the window/);
  });

  it("past the window, on this clock: expired, and by how much", () => {
    const copy = seatCacheStatusCopy("resting", face(72), NOW);
    expect(copy.line).toBe("resting 1h 12m");
    expect(copy.expired).toBe(true);
    expect(copy.rows[0]?.value).toMatch(/^resting for 1h 12m, since /);
    expect(copy.rows[2]).toMatchObject({ key: "Expired" });
    expect(copy.rows[2]?.value).toMatch(/, 12m ago$/);
    expect(copy.notes[0]).toMatch(/^Past the window the harness's cache has expired/);
  });

  it("a seat still under a minute says only its state", () => {
    expect(seatCacheStatusCopy("resting", face(0.5), NOW).line).toBe("resting");
  });

  it("leaves the mode out when the seat's machine has not said it", () => {
    const copy = seatCacheStatusCopy("resting", face(14), NOW);
    expect(copy.rows.some((row) => row.key === "Mode")).toBe(false);
    expect(copy.notes).toHaveLength(1);
  });

  it("names a remote machine, and never uses a middle dot", () => {
    const copy = seatCacheStatusCopy("not running", { ...face(72, { cacheMode: "manual" }), machine: "Atlas" }, NOW);
    expect(copy.rows[1]?.value).toBe("60m for Claude Code on Atlas");
    expect(JSON.stringify(copy)).not.toContain("·");
  });
});

describe("nextCacheStatusChange", () => {
  it("is the next whole minute still, or the window's end if that comes first", () => {
    const w = window(14.5);
    expect(nextCacheStatusChange(w, NOW)).toBe(w.stillSince + 15 * MIN);
    const ending = window(59.75);
    expect(nextCacheStatusChange(ending, NOW)).toBe(ending.windowEndsAt);
    const past = window(72.5);
    expect(nextCacheStatusChange(past, NOW)).toBe(past.stillSince + 73 * MIN);
  });
});

describe("nextMoment", () => {
  it("asks again at the first of the cold moment and a window end still ahead", () => {
    expect(nextMoment(undefined, undefined, NOW)).toBeUndefined();
    expect(nextMoment(NOW + 5 * MIN, undefined, NOW)).toBe(NOW + 5 * MIN);
    expect(nextMoment(undefined, NOW + 3 * MIN, NOW)).toBe(NOW + 3 * MIN);
    expect(nextMoment(NOW + 5 * MIN, NOW + 3 * MIN, NOW)).toBe(NOW + 3 * MIN);
    // A window already past moves nothing.
    expect(nextMoment(undefined, NOW - MIN, NOW)).toBeUndefined();
  });
});
