import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { applyPhaseMirror } from "../src/shared/canvas";
import { deriveExecutionGraph } from "../src/shared/execution-graph";
import { buildGlyphView } from "../src/shared/glyph-view";
import { digestCanvas } from "../src/shared/digest";
import { toFlow } from "../src/renderer/lib/convert";
import { criteriaPhasesNeedMirror } from "../src/main/vellum/kernel/cycle";

const project = (id: string, key: string) => ({
  id,
  type: "text" as const,
  text: id,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: {
    entity: { kind: "project" as const },
    bindings: [{ source: "tower" as const, ref: { type: "project" as const, key } }],
  },
});

describe("buildGlyphView + digest with live glyphs", () => {
  it("feeds complete browse rows into digest so glyph criteria show blocks", () => {
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
          ether: { criteria: { mode: "glyphs", glyphIds: ["g1"] }, kind: "relates" },
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
});
