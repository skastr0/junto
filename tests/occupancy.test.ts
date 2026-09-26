import { describe, expect, it } from "vitest";
import {
  DEFAULT_STALL_AFTER_MS,
  OccupancySpectrum,
  deriveOccupancy,
  type DeriveOccupancyInput,
} from "../src/shared/occupancy";

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const derive = (partial: Partial<DeriveOccupancyInput> & Pick<DeriveOccupancyInput, "hasOccupant">) =>
  deriveOccupancy({ nowMs: NOW, ...partial });

describe("OccupancySpectrum", () => {
  it("is the closed seat spectrum from factory physics", () => {
    expect(OccupancySpectrum.literals).toEqual([
      "empty",
      "idle",
      "working",
      "attention",
      "activity_blocked",
      "stalled",
      "gone",
    ]);
  });
});

describe("deriveOccupancy — vacancy", () => {
  it("empty when no occupant and no lastSeen", () => {
    expect(derive({ hasOccupant: false })).toBe("empty");
  });

  it("gone when no occupant but lastSeen records a former bind", () => {
    expect(derive({ hasOccupant: false, lastSeenAtMs: NOW - HOUR })).toBe("gone");
  });

  it("vacancy ignores harness (no phantom occupied states)", () => {
    expect(
      derive({
        hasOccupant: false,
        activity: { harness: "working" },
      }),
    ).toBe("empty");
    expect(
      derive({
        hasOccupant: false,
        lastSeenAtMs: NOW - HOUR,
        activity: { harness: "blocked" },
      }),
    ).toBe("gone");
  });
});

describe("deriveOccupancy — occupied baseline", () => {
  it("idle when bound with no elevating signals", () => {
    expect(derive({ hasOccupant: true })).toBe("idle");
  });

  it("idle for harness idle/unknown/absent", () => {
    expect(derive({ hasOccupant: true, activity: { harness: "idle" } })).toBe("idle");
    expect(derive({ hasOccupant: true, activity: { harness: "unknown" } })).toBe("idle");
    expect(derive({ hasOccupant: true, activity: {} })).toBe("idle");
  });

  it("working when harness is working", () => {
    expect(derive({ hasOccupant: true, activity: { harness: "working" } })).toBe("working");
  });

  it("activity_blocked when harness is blocked", () => {
    expect(derive({ hasOccupant: true, activity: { harness: "blocked" } })).toBe(
      "activity_blocked",
    );
  });

  it("attention from harness", () => {
    expect(derive({ hasOccupant: true, activity: { harness: "attention" } })).toBe("attention");
  });
});

describe("deriveOccupancy — stall", () => {
  it("does not invent stall without lastSeen", () => {
    expect(
      derive({
        hasOccupant: true,
        activity: { harness: "working" },
        // lastSeen omitted
      }),
    ).toBe("working");
  });

  it("stalled when lastSeen exceeds default 24h", () => {
    expect(
      derive({
        hasOccupant: true,
        lastSeenAtMs: NOW - DEFAULT_STALL_AFTER_MS - 1,
      }),
    ).toBe("stalled");
  });

  it("not stalled at exactly the threshold (strict >)", () => {
    expect(
      derive({
        hasOccupant: true,
        lastSeenAtMs: NOW - DEFAULT_STALL_AFTER_MS,
      }),
    ).toBe("idle");
  });

  it("respects custom stallAfterMs", () => {
    expect(
      derive({
        hasOccupant: true,
        lastSeenAtMs: NOW - 2 * HOUR,
        stallAfterMs: HOUR,
      }),
    ).toBe("stalled");
    expect(
      derive({
        hasOccupant: true,
        lastSeenAtMs: NOW - 30 * 60 * 1000,
        stallAfterMs: HOUR,
        activity: { harness: "working" },
      }),
    ).toBe("working");
  });

  it("stalled beats working when heartbeat is stale", () => {
    expect(
      derive({
        hasOccupant: true,
        activity: { harness: "working" },
        lastSeenAtMs: NOW - DEFAULT_STALL_AFTER_MS - 1,
      }),
    ).toBe("stalled");
  });
});

describe("deriveOccupancy — priority ladder (occupied)", () => {
  it("activity_blocked wins over stall and working", () => {
    expect(
      derive({
        hasOccupant: true,
        activity: { harness: "blocked" },
        lastSeenAtMs: NOW - DEFAULT_STALL_AFTER_MS - 1,
      }),
    ).toBe("activity_blocked");
  });

  it("attention wins over stall", () => {
    expect(
      derive({
        hasOccupant: true,
        activity: { harness: "attention" },
        lastSeenAtMs: NOW - DEFAULT_STALL_AFTER_MS - 1,
      }),
    ).toBe("attention");
  });

  it("stalled wins over working", () => {
    expect(
      derive({
        hasOccupant: true,
        activity: { harness: "working" },
        lastSeenAtMs: NOW - DEFAULT_STALL_AFTER_MS - 1,
      }),
    ).toBe("stalled");
  });

  it("working wins over idle", () => {
    expect(derive({ hasOccupant: true, activity: { harness: "working" } })).toBe("working");
  });
});
