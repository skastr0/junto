import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import type { ClaimDef, TasksSinkContract } from "../src/shared/work-model";
import {
  collectCanvasClaims,
  copyClaim,
  matchesClaimQuery,
  reusableClaims,
} from "../src/renderer/components/claims/claim-sources";
import {
  formatBakeTime,
  normalizeSinkContract,
  parseBakeTime,
} from "../src/renderer/components/claims/sink-contract";

const claim = (id: string, text: string, severity: "hard" | "soft" = "hard"): ClaimDef => ({
  id,
  text,
  severity,
});

const sink = (id: string, contract?: TasksSinkContract): CanvasNode => ({
  id,
  type: "text",
  text: "tasks",
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  ether: {
    entity: { kind: "task" },
    tasks: { items: [], ...(contract !== undefined ? { contract } : {}) },
  },
});

const region = (id: string, label: string, claims?: ReadonlyArray<ClaimDef>): CanvasNode => ({
  id,
  type: "group",
  x: 0,
  y: 0,
  width: 800,
  height: 800,
  label,
  ether: {
    region: { ...(claims !== undefined ? { contract: { claims: [...claims] } } : {}) },
  },
});

const agent = (id: string): CanvasNode => ({
  id,
  type: "text",
  text: "seat",
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  ether: { entity: { kind: "agent" } },
});

describe("collectCanvasClaims", () => {
  it("gathers region and sink contract claims with their origin", () => {
    const doc: CanvasDoc = {
      nodes: [
        region("r1", "Delivery", [claim("c1", "ships behind a flag")]),
        sink("s1", { claims: [claim("c2", "has a rollback", "soft")] }),
        agent("a1"),
        region("r2", "Empty"),
        sink("s2"),
      ],
      edges: [],
    };
    expect(collectCanvasClaims(doc)).toEqual([
      {
        claim: claim("c1", "ships behind a flag"),
        origin: { kind: "region", nodeId: "r1", label: "Delivery" },
      },
      {
        claim: claim("c2", "has a rollback", "soft"),
        origin: { kind: "sink", nodeId: "s1", label: "tasks" },
      },
    ]);
  });

  it("reads nothing from nodes with no contract", () => {
    const doc: CanvasDoc = { nodes: [agent("a1"), sink("s1"), region("r1", "R")], edges: [] };
    expect(collectCanvasClaims(doc)).toEqual([]);
  });
});

describe("reusableClaims", () => {
  const doc: CanvasDoc = {
    nodes: [
      region("r1", "Delivery", [claim("c1", "ships behind a flag")]),
      sink("s1", { claims: [claim("c2", "has a rollback")] }),
      sink("s2", { claims: [claim("c3", "names an owner")] }),
    ],
    edges: [],
  };

  it("excludes the owner's own claims", () => {
    const entries = reusableClaims(doc, "s1", [claim("c2", "has a rollback")]);
    expect(entries.map((entry) => entry.claim.id)).toEqual(["c1", "c3"]);
  });

  it("excludes text the owner already holds under another id", () => {
    const entries = reusableClaims(doc, "s2", [claim("local", "  Has A Rollback ")]);
    expect(entries.map((entry) => entry.claim.id)).toEqual(["c1"]);
  });
});

describe("matchesClaimQuery", () => {
  const entry = {
    claim: claim("c1", "ships behind a flag", "soft"),
    origin: { kind: "region" as const, nodeId: "r1", label: "Delivery" },
  };

  it("matches text, severity, and origin label, and passes everything on a blank query", () => {
    expect(matchesClaimQuery(entry, "  ")).toBe(true);
    expect(matchesClaimQuery(entry, "FLAG")).toBe(true);
    expect(matchesClaimQuery(entry, "soft")).toBe(true);
    expect(matchesClaimQuery(entry, "delivery")).toBe(true);
    expect(matchesClaimQuery(entry, "rollback")).toBe(false);
  });
});

describe("copyClaim", () => {
  it("keeps the words and severity under a new identity", () => {
    expect(copyClaim(claim("c1", "ships behind a flag", "soft"), "c9")).toEqual({
      id: "c9",
      text: "ships behind a flag",
      severity: "soft",
    });
  });
});

describe("normalizeSinkContract", () => {
  it("drops a contract that carries nothing", () => {
    expect(normalizeSinkContract(undefined)).toBeUndefined();
    expect(normalizeSinkContract({})).toBeUndefined();
    expect(
      normalizeSinkContract({
        instruction: "   ",
        claims: [],
        inbound: { admission: "auto", claimableAfterMs: 0, checklist: [] },
        outbound: { emission: "" },
      }),
    ).toBeUndefined();
  });

  it("keeps authored values and trims prose", () => {
    expect(
      normalizeSinkContract({
        instruction: "  Review the diff  ",
        claims: [claim("c1", "  has a test  ")],
        inbound: {
          admission: "operator-gated",
          claimableAfterMs: 3_600_000,
          description: "code review",
        },
        outbound: { emission: "what changed", checklist: [] },
      }),
    ).toEqual({
      instruction: "Review the diff",
      claims: [claim("c1", "has a test")],
      inbound: {
        description: "code review",
        admission: "operator-gated",
        claimableAfterMs: 3_600_000,
      },
      outbound: { emission: "what changed" },
    });
  });

  it("drops checks missing a name or a command", () => {
    expect(
      normalizeSinkContract({
        inbound: {
          checklist: [
            { id: "k1", label: "typecheck", command: " bun run typecheck " },
            { id: "k2", label: "  ", command: "bun test" },
            { id: "k3", label: "lint", command: "" },
          ],
        },
      }),
    ).toEqual({
      inbound: { checklist: [{ id: "k1", label: "typecheck", command: "bun run typecheck" }] },
    });
  });
});

describe("bake time", () => {
  it("parses the durations an operator speaks", () => {
    expect(parseBakeTime("90m")).toEqual({ ok: true, ms: 5_400_000 });
    expect(parseBakeTime(" 12H ")).toEqual({ ok: true, ms: 43_200_000 });
    expect(parseBakeTime("7d")).toEqual({ ok: true, ms: 604_800_000 });
    expect(parseBakeTime("500")).toEqual({ ok: true, ms: 500 });
  });

  it("reads blank and zero as no bake", () => {
    expect(parseBakeTime("")).toEqual({ ok: true, ms: undefined });
    expect(parseBakeTime("0h")).toEqual({ ok: true, ms: undefined });
  });

  it("refuses what it cannot read", () => {
    expect(parseBakeTime("soon")).toEqual({ ok: false });
    expect(parseBakeTime("1d12h")).toEqual({ ok: false });
  });

  it("prints the largest exact unit", () => {
    expect(formatBakeTime(undefined)).toBe("");
    expect(formatBakeTime(0)).toBe("");
    expect(formatBakeTime(604_800_000)).toBe("1w");
    expect(formatBakeTime(43_200_000)).toBe("12h");
    expect(formatBakeTime(5_400_000)).toBe("90m");
    expect(formatBakeTime(1_500)).toBe("1500ms");
  });
});
