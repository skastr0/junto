import { describe, expect, it } from "vitest";
import { mapGlyphItems, mapSearchMatches, mapSignalItems } from "../src/main/vellum/adapters/tower-browse";

describe("mapGlyphItems", () => {
  it("picks the frozen-contract fields off each item", () => {
    const items = [
      {
        glyphId: "g1",
        orbit: "forge",
        title: "Ship the thing",
        state: "building",
        updatedAt: 1_700_000_000_000,
        createdAt: 1_699_000_000_000,
        extra: "dropped",
      },
    ];
    expect(mapGlyphItems(items)).toEqual([
      { glyphId: "g1", orbit: "forge", title: "Ship the thing", state: "building", updatedAt: 1_700_000_000_000 },
    ]);
  });

  it("returns an empty array for a missing/malformed items field", () => {
    expect(mapGlyphItems(undefined)).toEqual([]);
  });
});

describe("mapSignalItems", () => {
  it("picks the frozen-contract fields and drops payload", () => {
    const items = [
      {
        signalId: "s1",
        orbit: "beacon",
        status: "inbox",
        kind: "handoff",
        summary: "route to survey",
        priority: "high",
        updatedAt: 1_700_000_000_000,
        payload: { big: "x".repeat(6000) },
      },
    ];
    const mapped = mapSignalItems(items);
    expect(mapped).toEqual([
      {
        signalId: "s1",
        orbit: "beacon",
        status: "inbox",
        kind: "handoff",
        summary: "route to survey",
        priority: "high",
        updatedAt: 1_700_000_000_000,
      },
    ]);
    expect(mapped[0]).not.toHaveProperty("payload");
  });

  it("returns an empty array for a missing/malformed signals field", () => {
    expect(mapSignalItems(undefined)).toEqual([]);
  });
});

describe("mapSearchMatches (tower)", () => {
  it("picks the frozen-contract fields off each match", () => {
    const matches = [
      {
        family: "glyphs",
        title: "Ship the thing",
        summary: "a summary",
        projectKey: "prism",
        orbit: "forge",
        glyphId: "g1",
        state: "building",
        score: 0.87,
        extra: "dropped",
      },
    ];
    expect(mapSearchMatches(matches)).toEqual([
      {
        family: "glyphs",
        title: "Ship the thing",
        summary: "a summary",
        projectKey: "prism",
        orbit: "forge",
        glyphId: "g1",
        signalId: undefined,
        state: "building",
        status: undefined,
        score: 0.87,
      },
    ]);
  });

  it("returns an empty array for a missing/malformed matches field", () => {
    expect(mapSearchMatches(undefined)).toEqual([]);
  });
});
