import { describe, expect, it } from "vitest";
import {
  fetchTowerCommentGlyph,
  fetchTowerCommentSignal,
  formatPayloadJson,
  isBlankCommentBody,
  mapGlyphDetail,
  mapGlyphItems,
  mapSearchMatches,
  mapSignalDetail,
  mapSignalItems,
} from "../src/main/vellum/adapters/tower-browse";

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

describe("mapGlyphDetail", () => {
  it("maps the live GET /api/glyphs/read shape, pulling far-end glyphIds off dependency edges", () => {
    const raw = {
      glyphId: "VL-011",
      orbit: "forge",
      title: "Session drill",
      state: "done",
      content: "# Session drill\n\nbody text",
      comments: {
        total: 2,
        latest: [{ body: "most recent comment" }, { body: "older comment" }],
      },
      dependencies: [
        { from: { glyphId: "VL-011" }, to: { glyphId: "VL-005" } },
      ],
      dependents: [
        { from: { glyphId: "VL-012" }, to: { glyphId: "VL-011" } },
      ],
      updatedAt: 1_700_000_000_000,
    };
    expect(mapGlyphDetail(raw)).toEqual({
      glyphId: "VL-011",
      orbit: "forge",
      title: "Session drill",
      state: "done",
      content: "# Session drill\n\nbody text",
      commentsTotal: 2,
      latestComment: "most recent comment",
      dependencies: ["VL-005"],
      dependents: ["VL-012"],
      updatedAt: 1_700_000_000_000,
    });
  });

  it("defaults content to empty string and comments/deps to empty when absent", () => {
    const raw = { glyphId: "g1", orbit: "forge", title: "t", state: "backlog", updatedAt: 0 };
    const mapped = mapGlyphDetail(raw);
    expect(mapped.content).toBe("");
    expect(mapped.commentsTotal).toBe(0);
    expect(mapped.latestComment).toBeUndefined();
    expect(mapped.dependencies).toEqual([]);
    expect(mapped.dependents).toEqual([]);
  });

  it("drops dependency edges missing the far-end glyphId instead of emitting undefined", () => {
    const raw = {
      glyphId: "g1",
      orbit: "forge",
      title: "t",
      state: "backlog",
      dependencies: [{ from: { glyphId: "g1" }, to: {} }],
      updatedAt: 0,
    };
    expect(mapGlyphDetail(raw).dependencies).toEqual([]);
  });
});

describe("formatPayloadJson", () => {
  it("pretty-prints under the cap unchanged", () => {
    const json = formatPayloadJson({ a: 1 });
    expect(json).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it("returns undefined for an absent payload", () => {
    expect(formatPayloadJson(undefined)).toBeUndefined();
  });

  it("caps at 20,000 chars and appends a truncation marker", () => {
    const big = { text: "x".repeat(30_000) };
    const json = formatPayloadJson(big)!;
    expect(json.endsWith("… (truncated)")).toBe(true);
    expect(json.length).toBe(20_000 + "… (truncated)".length);
  });
});

describe("mapSignalDetail", () => {
  it("maps the live GET /api/signals/read shape, pulling consumedBy/consumptionSummary off audit", () => {
    const raw = {
      signalId: "sig_abc",
      orbit: "forge",
      status: "consumed",
      kind: "quartz.research-finding",
      summary: "a summary",
      priority: "high",
      payload: { topic: "x" },
      source: { name: "grok-build" },
      audit: { consumed_by: "claude-fable-orchestrator", consumption_summary: "fulfilled by X" },
      updatedAt: 1_700_000_000_000,
    };
    expect(mapSignalDetail(raw)).toEqual({
      signalId: "sig_abc",
      orbit: "forge",
      status: "consumed",
      kind: "quartz.research-finding",
      summary: "a summary",
      priority: "high",
      payloadJson: JSON.stringify({ topic: "x" }, null, 2),
      sourceName: "grok-build",
      consumedBy: "claude-fable-orchestrator",
      consumptionSummary: "fulfilled by X",
      updatedAt: 1_700_000_000_000,
    });
  });

  it("leaves sourceName/consumedBy/consumptionSummary undefined when source/audit are null", () => {
    const raw = {
      signalId: "sig_abc",
      orbit: "forge",
      status: "inbox",
      kind: "k",
      summary: "s",
      source: null,
      audit: null,
      updatedAt: 0,
    };
    const mapped = mapSignalDetail(raw);
    expect(mapped.sourceName).toBeUndefined();
    expect(mapped.consumedBy).toBeUndefined();
    expect(mapped.consumptionSummary).toBeUndefined();
    expect(mapped.payloadJson).toBeUndefined();
  });
});

describe("isBlankCommentBody", () => {
  it("treats empty and whitespace-only bodies as blank", () => {
    expect(isBlankCommentBody("")).toBe(true);
    expect(isBlankCommentBody("   \n\t  ")).toBe(true);
  });

  it("treats real text as non-blank", () => {
    expect(isBlankCommentBody("a note")).toBe(false);
    expect(isBlankCommentBody("  a note  ")).toBe(false);
  });
});

describe("fetchTowerCommentGlyph / fetchTowerCommentSignal", () => {
  // The blank-body guard fires before any config load or network call, so
  // these resolve deterministically with no fetch mocking required.
  it("rejects a blank glyph comment body without touching the network", async () => {
    const result = await fetchTowerCommentGlyph("vellum", "forge", "VL-011", "   ");
    expect(result).toEqual({ ok: false, error: "comment body is empty" });
  });

  it("rejects a blank signal comment body without touching the network", async () => {
    const result = await fetchTowerCommentSignal("prism", "forge", "sig_abc", "");
    expect(result).toEqual({ ok: false, error: "comment body is empty" });
  });
});
