import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { applyPhaseMirror } from "../src/shared/canvas";
import { deriveExecutionGraph } from "../src/shared/execution-graph";
import { buildGlyphView } from "../src/shared/glyph-view";
import { digestCanvas } from "../src/shared/digest";
import { createFlowIdentityCache, toFlow } from "../src/renderer/lib/convert";
import { criteriaPhasesNeedMirror } from "../src/main/vellum/kernel/cycle";
import { seat } from "./helpers/physics-seats";

const project = (id: string, key: string) =>
  seat(id, "sink", { label: id, name: key });

describe("buildGlyphView + digest with live glyphs", () => {
  it("feeds complete browse rows into digest so glyph criteria show blocks on actors", () => {
    const doc: CanvasDoc = {
      nodes: [project("a", "pa"), seat("b", "actor", { label: "b" })],
      edges: [
        {
          id: "e1",
          fromNode: "a",
          toNode: "b",
          ether: { criteria: { mode: "glyphs", glyphIds: ["g1"] } },
        },
      ],
    };
    const view = buildGlyphView(
      doc,
      new Map([
        [
          "pa",
          {
            ok: true,
            glyphs: [{ glyphId: "g1", orbit: "forge", title: "g1", state: "building" }],
          },
        ],
      ]),
    );
    const digest = digestCanvas("live", doc, { bundles: [] }, view);
    expect(digest).toContain("blocks");
    expect(digest).toContain("blocked closure :: 1 nodes");
  });

  it("omits partial tower reads so criteria do not fail-closed", () => {
    const doc: CanvasDoc = {
      nodes: [project("a", "pa"), project("b", "pb")],
      edges: [
        {
          id: "e1",
          fromNode: "a",
          toNode: "b",
          ether: { criteria: { mode: "glyphs", glyphIds: ["g1"] } },
        },
      ],
    };
    const view = buildGlyphView(
      doc,
      new Map([
        [
          "pa",
          {
            ok: true,
            partial: true,
            glyphs: [{ glyphId: "g1", orbit: "forge", title: "g1", state: "building" }],
          },
        ],
      ]),
    );
    expect(view.has("pa")).toBe(false);
    const graph = deriveExecutionGraph(doc, view);
    expect(graph.phaseByEdgeId.get("e1")).toBe("relates");
  });
});

describe("toFlow consumes kernel execution overlay", () => {
  it("paints blocked + blocks phase from overlay even without GlyphView", () => {
    const doc: CanvasDoc = {
      nodes: [project("a", "pa"), project("b", "pb")],
      edges: [
        {
          id: "e1",
          fromNode: "a",
          toNode: "b",
          ether: { criteria: { mode: "glyphs", glyphIds: ["g1"] } },
        },
      ],
    };
    // Without overlay: unknown glyphs → relates, not blocked.
    const cold = toFlow(doc, null);
    const coldEdge = cold.edges[0];
    const coldB = cold.nodes.find((n) => n.id === "b");
    expect(coldEdge?.data?.phase).toBe("relates");
    expect(coldB?.data?.blocked).toBe(false);

    const live = toFlow(doc, {
      phaseByEdgeId: { e1: "blocks" },
      detailByEdgeId: { e1: "0/1 done" },
      blocked: ["b"],
      blockedEdgeIds: ["e1"],
    });
    const liveEdge = live.edges[0];
    const liveB = live.nodes.find((n) => n.id === "b");
    expect(liveEdge?.data?.phase).toBe("blocks");
    expect(liveEdge?.data?.detail).toBe("0/1 done");
    expect(liveB?.data?.blocked).toBe(true);
    expect(liveEdge?.data?.rippling).toBe(true);
  });

  it("reuses FlowNode/FlowEdge identity when inputs are unchanged (cache hit)", () => {
    const doc: CanvasDoc = {
      nodes: [project("a", "pa"), project("b", "pb")],
      edges: [
        {
          id: "e1",
          fromNode: "a",
          toNode: "b",
          ether: { criteria: { mode: "glyphs", glyphIds: ["g1"] } },
        },
      ],
    };
    const overlay = {
      phaseByEdgeId: { e1: "blocks" as const },
      detailByEdgeId: { e1: "0/1 done" },
      blocked: ["b"],
      blockedEdgeIds: ["e1"],
    };
    const cache = createFlowIdentityCache();
    const first = toFlow(doc, overlay, cache);
    const second = toFlow(doc, overlay, cache);
    expect(second.nodes[0]).toBe(first.nodes[0]);
    expect(second.nodes[1]).toBe(first.nodes[1]);
    expect(second.edges[0]).toBe(first.edges[0]);
  });

  it("remints only the node whose blocked flag or doc ref changed", () => {
    const doc: CanvasDoc = {
      nodes: [project("a", "pa"), project("b", "pb")],
      edges: [],
    };
    const cache = createFlowIdentityCache();
    const first = toFlow(doc, { phaseByEdgeId: {}, detailByEdgeId: {}, blocked: [], blockedEdgeIds: [] }, cache);
    const second = toFlow(
      doc,
      { phaseByEdgeId: {}, detailByEdgeId: {}, blocked: ["b"], blockedEdgeIds: [] },
      cache,
    );
    expect(second.nodes.find((n) => n.id === "a")).toBe(first.nodes.find((n) => n.id === "a"));
    expect(second.nodes.find((n) => n.id === "b")).not.toBe(first.nodes.find((n) => n.id === "b"));
    expect(second.nodes.find((n) => n.id === "b")?.data?.blocked).toBe(true);
  });
});

describe("applyPhaseMirror production path helpers", () => {
  it("mirrors derived phase onto criteria edges and reports when write is needed", () => {
    const doc: CanvasDoc = {
      nodes: [project("a", "pa"), project("b", "pb")],
      edges: [
        {
          id: "e1",
          fromNode: "a",
          toNode: "b",
          ether: { criteria: { mode: "glyphs", glyphIds: ["g1"] } },
        },
      ],
    };
    const phaseByEdgeId = new Map([["e1", "blocks" as const]]);
    expect(criteriaPhasesNeedMirror(doc, phaseByEdgeId)).toBe(true);
    const mirrored = applyPhaseMirror(doc, phaseByEdgeId);
    expect(mirrored.edges[0]?.ether?.kind).toBe("blocks");
    expect(mirrored.edges[0]?.label).toBe("blocks");
    expect(mirrored.edges[0]?.color).toBe("1");
    expect(criteriaPhasesNeedMirror(mirrored, phaseByEdgeId)).toBe(false);
  });

  it("does not stamp soft relates (no criteria) with kind/label/color", () => {
    const soft = {
      id: "soft",
      fromNode: "a",
      toNode: "b",
      label: "my free label",
      color: "4" as const,
    };
    const doc: CanvasDoc = {
      nodes: [project("a", "pa"), project("b", "pb")],
      edges: [soft],
    };
    const phaseByEdgeId = new Map([
      ["soft", "blocks" as const],
      ["missing", "depends" as const],
    ]);
    expect(criteriaPhasesNeedMirror(doc, phaseByEdgeId)).toBe(false);
    const mirrored = applyPhaseMirror(doc, phaseByEdgeId);
    expect(mirrored.edges[0]).toEqual(soft);
    expect(mirrored.edges[0]?.ether).toBeUndefined();
  });

  it("demotes blocks → depends: clears color 1 and updates kind/label", () => {
    const doc: CanvasDoc = {
      nodes: [project("a", "pa"), project("b", "pb")],
      edges: [
        {
          id: "e1",
          fromNode: "a",
          toNode: "b",
          label: "blocks",
          color: "1",
          ether: {
            kind: "blocks",
            criteria: { mode: "glyphs", glyphIds: ["g1"] },
          },
        },
      ],
    };
    const phaseByEdgeId = new Map([["e1", "depends" as const]]);
    expect(criteriaPhasesNeedMirror(doc, phaseByEdgeId)).toBe(true);
    const demoted = applyPhaseMirror(doc, phaseByEdgeId);
    expect(demoted.edges[0]?.ether?.kind).toBe("depends");
    expect(demoted.edges[0]?.label).toBe("depends");
    expect(demoted.edges[0]?.color).toBeUndefined();
    expect(demoted.edges[0]?.ether?.criteria).toEqual({ mode: "glyphs", glyphIds: ["g1"] });
    expect(criteriaPhasesNeedMirror(demoted, phaseByEdgeId)).toBe(false);
  });

  it("demotes blocks → relates: clears color 1 and updates kind/label", () => {
    const doc: CanvasDoc = {
      nodes: [project("a", "pa"), project("b", "pb")],
      edges: [
        {
          id: "e1",
          fromNode: "a",
          toNode: "b",
          label: "blocks",
          color: "1",
          ether: {
            kind: "blocks",
            criteria: { mode: "tasks" },
          },
        },
      ],
    };
    const phaseByEdgeId = new Map([["e1", "relates" as const]]);
    const demoted = applyPhaseMirror(doc, phaseByEdgeId);
    expect(demoted.edges[0]?.ether?.kind).toBe("relates");
    expect(demoted.edges[0]?.label).toBe("relates");
    expect(demoted.edges[0]?.color).toBeUndefined();
    expect(criteriaPhasesNeedMirror(demoted, phaseByEdgeId)).toBe(false);
  });

  it("criteriaPhasesNeedMirror is true when color 1 is stuck after demotion phase", () => {
    // kind already depends, but mirror crimson left behind — still needs write.
    const doc: CanvasDoc = {
      nodes: [project("a", "pa"), project("b", "pb")],
      edges: [
        {
          id: "e1",
          fromNode: "a",
          toNode: "b",
          label: "depends",
          color: "1",
          ether: {
            kind: "depends",
            criteria: { mode: "glyphs", glyphIds: ["g1"] },
          },
        },
      ],
    };
    const phaseByEdgeId = new Map([["e1", "depends" as const]]);
    expect(criteriaPhasesNeedMirror(doc, phaseByEdgeId)).toBe(true);
    const fixed = applyPhaseMirror(doc, phaseByEdgeId);
    expect(fixed.edges[0]?.color).toBeUndefined();
    expect(fixed.edges[0]?.ether?.kind).toBe("depends");
    expect(criteriaPhasesNeedMirror(fixed, phaseByEdgeId)).toBe(false);
  });

  it("criteriaPhasesNeedMirror is true when blocks phase is missing color 1", () => {
    const doc: CanvasDoc = {
      nodes: [project("a", "pa"), project("b", "pb")],
      edges: [
        {
          id: "e1",
          fromNode: "a",
          toNode: "b",
          label: "blocks",
          ether: {
            kind: "blocks",
            criteria: { mode: "wip" },
          },
        },
      ],
    };
    const phaseByEdgeId = new Map([["e1", "blocks" as const]]);
    expect(criteriaPhasesNeedMirror(doc, phaseByEdgeId)).toBe(true);
    const fixed = applyPhaseMirror(doc, phaseByEdgeId);
    expect(fixed.edges[0]?.color).toBe("1");
    expect(criteriaPhasesNeedMirror(fixed, phaseByEdgeId)).toBe(false);
  });
});
