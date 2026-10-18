/**
 * What a seat that is not running does at its next start, from the facts
 * main reads: its open session, the harness's own proof, and how its last
 * session ended.
 */
import { describe, expect, it } from "vitest";
import { SEAT_FRESH_NEXT_LINE, seatCacheWindow, seatNextLaunch, seatNextTurn } from "../src/shared/seat-next-launch";

const open = (harness = "claude") => ({ harness, sessionId: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed" });

describe("seatNextLaunch", () => {
  it("resumes a captured session the harness still holds", () => {
    expect(seatNextLaunch({ harness: "claude", open: open(), provisioned: false, provenOnDisk: true })).toBe("resume");
  });

  it("resumes a provisioned thread by its id alone", () => {
    expect(seatNextLaunch({ harness: "amp", open: open("amp"), provisioned: true, provenOnDisk: false })).toBe("resume");
  });

  it("starts fresh after an offboard, with or without a pin minted for the next session", () => {
    // Pin harness: offboard records a new id with nothing behind it yet.
    expect(seatNextLaunch({ harness: "claude", open: open(), provisioned: false, provenOnDisk: false, lastEnded: "offboard" })).toBe("offboarded");
    // Capture harness: offboard leaves no open session.
    expect(seatNextLaunch({ harness: "codex", provisioned: false, provenOnDisk: false, lastEnded: "offboard" })).toBe("offboarded");
  });

  it("starts fresh with no session, or one from another harness", () => {
    expect(seatNextLaunch({ harness: "claude", provisioned: false, provenOnDisk: false })).toBe("fresh");
    expect(seatNextLaunch({ harness: "claude", open: open("codex"), provisioned: false, provenOnDisk: true, lastEnded: "reseat" })).toBe("fresh");
    expect(seatNextLaunch({ harness: "claude", open: { harness: "claude", sessionId: " " }, provisioned: false, provenOnDisk: true })).toBe("fresh");
  });

});

describe("seatNextTurn", () => {
  it("a seat that is not running and has nothing to resume starts fresh", () => {
    expect(seatNextTurn({ running: false, launch: "offboarded", cold: { cold: false, at: 5 } })).toEqual({ fresh: true });
    expect(seatNextTurn({ running: false, launch: "fresh", cold: { cold: false } })).toEqual({ fresh: true });
  });

  it("otherwise the session's coldness decides, running or not", () => {
    expect(seatNextTurn({ running: false, launch: "resume", cold: { cold: true } })).toEqual({ fresh: true });
    expect(seatNextTurn({ running: true, launch: "fresh", cold: { cold: false, at: 5 } })).toEqual({ fresh: false, freshAt: 5 });
    expect(seatNextTurn({ running: true, launch: "resume", cold: { cold: false } })).toEqual({ fresh: false });
  });

  it("says only the fresh case, in words a seat line holds uncut at fit-all, and never names a cache", () => {
    expect(SEAT_FRESH_NEXT_LINE).toBe("fresh next");
    expect(SEAT_FRESH_NEXT_LINE.length).toBeLessThanOrEqual(18);
  });
});

describe("seatCacheWindow", () => {
  const T = 1_792_000_000_000;
  const MIN = 60_000;
  const continues = { fresh: false };

  it("tells a still seat that picks up where it was when its window ends, and how far past it is", () => {
    expect(seatCacheWindow(continues, { stillSince: T, windowMinutes: 5 }, T + 4 * MIN))
      .toEqual({ windowMinutes: 5, stillSince: T, windowEndsAt: T + 5 * MIN, pastWindow: false, pastByMs: 0 });
    // The moment the window ends, the seat is past it: the cut's own test.
    expect(seatCacheWindow(continues, { stillSince: T, windowMinutes: 5 }, T + 5 * MIN)).toMatchObject({ pastWindow: true, pastByMs: 0 });
    expect(seatCacheWindow(continues, { stillSince: T, windowMinutes: 5 }, T + 12 * MIN)).toMatchObject({ pastWindow: true, pastByMs: 7 * MIN });
    // The machine's mode goes with it when the machine said it.
    expect(seatCacheWindow(continues, { stillSince: T, windowMinutes: 5, cacheMode: "auto" }, T)).toMatchObject({ cacheMode: "auto" });
    expect(seatCacheWindow(continues, { stillSince: T, windowMinutes: 5 }, T)).not.toHaveProperty("cacheMode");
  });

  it("tells nothing for a seat in a turn, or one whose next turn starts fresh or is not known", () => {
    expect(seatCacheWindow(continues, { windowMinutes: 5 }, T)).toBeUndefined();
    expect(seatCacheWindow({ fresh: true }, { stillSince: T, windowMinutes: 5 }, T + 60 * MIN)).toBeUndefined();
    expect(seatCacheWindow(undefined, { stillSince: T, windowMinutes: 5 }, T + 60 * MIN)).toBeUndefined();
  });
});
