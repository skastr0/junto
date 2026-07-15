import { describe, expect, it } from "vitest";
import {
  fetchTowerCommentGlyph,
  fetchTowerCommentSignal,
  fetchTowerEmitSignal,
  formatPayloadJson,
  isBlankCommentBody,
  mapGlyphDetail,
  mapGlyphItems,
  mapSearchMatches,
  mapSignalDetail,
  mapSignalItems,
  parseEmitSignalInput,
} from "../src/main/vellum/adapters/tower-browse";

// Fixtures below model what @skastr0/tower-sdk actually hands these mappers
// after Effect Schema decode — every row is already schema-valid (required
// fields present, enums narrowed), unlike the pre-SDK hand-rolled-fetch era
// where these functions had to defensively tolerate arbitrary raw JSON.

describe("mapGlyphItems", () => {
  it("picks the frozen-contract fields off each item", () => {
    const items = [
      {
        glyphId: "g1",
        orbit: "forge" as const,
        title: "Ship the thing",
        state: "building" as const,
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
        status: "inbox" as const,
        kind: "handoff",
        summary: "route to survey",
        priority: "high" as const,
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
  it("picks the frozen-contract fields off each glyph match", () => {
    const matches = [
      {
        family: "glyphs" as const,
        title: "Ship the thing",
        summary: "a summary",
        projectKey: "prism",
        orbit: "forge",
        glyphId: "g1",
        state: "building",
        status: undefined,
        score: 0.87,
        sourceRef: { family: "glyphs" as const, projectKey: "prism", orbit: "forge", glyphId: "g1" },
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

  // The SDK's SearchMatch carries no flat `signalId` field — it only lives
  // inside `sourceRef` when sourceRef.family === "signals". This is the one
  // shape genuinely dissolved-then-relocated by SDK adoption (the old
  // hand-rolled fetch response had a flat signalId).
  it("pulls signalId out of sourceRef for a signal match", () => {
    const matches = [
      {
        family: "signals" as const,
        title: "Route to survey",
        summary: undefined,
        projectKey: "prism",
        orbit: "beacon",
        glyphId: undefined,
        state: undefined,
        status: "inbox",
        score: 0.5,
        sourceRef: { family: "signals" as const, projectKey: "prism", orbit: "beacon", signalId: "sig_abc123def456abc123def456" },
      },
    ];
    expect(mapSearchMatches(matches)[0]?.signalId).toBe("sig_abc123def456abc123def456");
  });

  it("returns an empty array for a missing/malformed matches field", () => {
    expect(mapSearchMatches(undefined)).toEqual([]);
  });
});

describe("mapGlyphDetail", () => {
  it("maps the live GET /api/glyphs/read shape, pulling far-end glyphIds off dependency edges", () => {
    const dependencyEdge = (from: string, to: string) => ({
      from: { glyphId: from },
      to: { glyphId: to },
    });
    const raw = {
      glyphId: "VL-011",
      orbit: "forge" as const,
      title: "Session drill",
      state: "done" as const,
      content: "# Session drill\n\nbody text",
      comments: {
        total: 2,
        latest: [{ body: "most recent comment" }, { body: "older comment" }],
      },
      dependencies: [dependencyEdge("VL-011", "VL-005")],
      dependents: [dependencyEdge("VL-012", "VL-011")],
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

  it("defaults comments to empty when absent, content/deps stay empty", () => {
    const raw = {
      glyphId: "g1",
      orbit: "forge" as const,
      title: "t",
      state: "backlog" as const,
      content: "",
      dependencies: [],
      dependents: [],
      updatedAt: 0,
    };
    const mapped = mapGlyphDetail(raw);
    expect(mapped.content).toBe("");
    expect(mapped.commentsTotal).toBe(0);
    expect(mapped.latestComment).toBeUndefined();
    expect(mapped.dependencies).toEqual([]);
    expect(mapped.dependents).toEqual([]);
  });

  // The old "edge missing the far-end glyphId" defensive test is dissolved:
  // GlyphDependency.to/from.glyphId are required, non-optional fields on the
  // SDK's schema, so Effect Schema decode already rejects such a response
  // before mapGlyphDetail ever sees it — there is no longer a malformed-edge
  // case to defend against at this layer.
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
  const audit = (extra: Partial<{ consumed_by: string; consumption_summary: string }> = {}) => ({
    recorded_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...extra,
  });

  it("maps the live GET /api/signals/read shape, pulling consumedBy/consumptionSummary off audit", () => {
    const raw = {
      signalId: "sig_abc",
      orbit: "forge",
      status: "consumed" as const,
      kind: "quartz.research-finding",
      summary: "a summary",
      priority: "high" as const,
      payload: { topic: "x" },
      source: { name: "grok-build" },
      audit: audit({ consumed_by: "claude-fable-orchestrator", consumption_summary: "fulfilled by X" }),
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

  // `audit` is a required field on the SDK's Signal schema (never null/
  // absent post-decode) — only `source` and audit's consumed_by/
  // consumption_summary sub-fields are genuinely optional.
  it("leaves sourceName/consumedBy/consumptionSummary undefined when source is absent and audit has no consumption fields", () => {
    const raw = {
      signalId: "sig_abc",
      orbit: "forge",
      status: "inbox" as const,
      kind: "k",
      summary: "s",
      source: undefined,
      audit: audit(),
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
  // The blank-body guard fires before AppRuntime/the SDK client is ever
  // touched, so these resolve deterministically with no network involved.
  it("rejects a blank glyph comment body without touching the network", async () => {
    const result = await fetchTowerCommentGlyph("vellum", "forge", "VL-011", "   ");
    expect(result).toEqual({ ok: false, error: "comment body is empty" });
  });

  it("rejects a blank signal comment body without touching the network", async () => {
    const result = await fetchTowerCommentSignal("prism", "forge", "sig_abc", "");
    expect(result).toEqual({ ok: false, error: "comment body is empty" });
  });
});

describe("parseEmitSignalInput", () => {
  const base = {
    projectKey: "vellum",
    orbit: "forge",
    kind: "note",
    summary: "ship the emit form",
  };

  it("accepts a minimal valid emit and defaults contract/payload", () => {
    const parsed = parseEmitSignalInput(base);
    expect(parsed).toEqual({
      ok: true,
      input: {
        projectKey: "vellum",
        orbit: "forge",
        kind: "note",
        summary: "ship the emit form",
        contractSchemaId: "signal/v1",
        payload: {},
      },
    });
  });

  it("rejects missing summary / kind / orbit without touching the network", () => {
    expect(parseEmitSignalInput({ ...base, summary: "  " })).toEqual({
      ok: false,
      error: "summary is required",
    });
    expect(parseEmitSignalInput({ ...base, kind: "" })).toEqual({
      ok: false,
      error: "kind is required",
    });
    expect(parseEmitSignalInput({ ...base, orbit: "" })).toEqual({
      ok: false,
      error: "orbit is required",
    });
  });

  it("rejects malformed kind, contract, and non-object payload", () => {
    expect(parseEmitSignalInput({ ...base, kind: "Bad Kind" }).ok).toBe(false);
    expect(parseEmitSignalInput({ ...base, contractSchemaId: "no-version" }).ok).toBe(false);
    expect(parseEmitSignalInput({ ...base, payloadJson: "[]" })).toEqual({
      ok: false,
      error: "payload must be a JSON object",
    });
    expect(parseEmitSignalInput({ ...base, payloadJson: "{not json" }).ok).toBe(false);
  });

  it("parses payload JSON and optional priority / dedupe", () => {
    const parsed = parseEmitSignalInput({
      ...base,
      payloadJson: '{"ref":"VL-1"}',
      priority: "high",
      dedupeKey: "vl-1-once",
      contractSchemaId: "tower/signals/note/v1",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input.payload).toEqual({ ref: "VL-1" });
    expect(parsed.input.priority).toBe("high");
    expect(parsed.input.dedupeKey).toBe("vl-1-once");
    expect(parsed.input.contractSchemaId).toBe("tower/signals/note/v1");
  });
});

describe("fetchTowerEmitSignal", () => {
  it("rejects invalid input before the network", async () => {
    const result = await fetchTowerEmitSignal({
      projectKey: "vellum",
      orbit: "forge",
      kind: "note",
      summary: "   ",
    });
    expect(result).toEqual({ ok: false, error: "summary is required" });
  });
});
