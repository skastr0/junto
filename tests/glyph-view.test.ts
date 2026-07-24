import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { edgeGlyphProjects } from "../src/shared/execution-graph";
import { buildGlyphView } from "../src/shared/glyph-view";

describe("glyph-view after criteria retirement", () => {
  it("edgeGlyphProjects is always empty", () => {
    const doc: CanvasDoc = {
      nodes: [
        {
          id: "a",
          type: "text",
          text: "a",
          x: 0,
          y: 0,
          width: 100,
          height: 40,
          ether: { entity: { kind: "task" } },
        },
      ],
      edges: [
        {
          id: "e1",
          fromNode: "a",
          toNode: "a",
          ether: { criteria: { mode: "tasks" } },
        },
      ],
    };
    expect(edgeGlyphProjects(doc).size).toBe(0);
  });

  it("buildGlyphView returns empty map when no glyph projects", () => {
    const doc: CanvasDoc = { nodes: [], edges: [] };
    const view = buildGlyphView(doc, new Map());
    expect(view.size).toBe(0);
  });
});
