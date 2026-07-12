import { describe, expect, it } from "vitest";
import { Either } from "effect";
import { decodeCanvasDoc, type CanvasDoc } from "../src/shared/canvas";
import { explodeProjectInto, type ExplodeGlyph } from "../src/shared/explode";
import { glyphKey, orbitKey, parseGlyphKey, parseOrbitKey, parseSessionKey, sessionKey } from "../src/shared/refs";

const glyphs: ReadonlyArray<ExplodeGlyph> = [
  { project: "prism", orbit: "forge", glyphId: "WFE-010", title: "Design: cache identity vs dynamic prompts", state: "backlog" },
  { project: "prism", orbit: "forge", glyphId: "WFE-011", title: "Build the thing", state: "building" },
  { project: "prism", orbit: "forge", glyphId: "WFE-012", title: "Review the thing", state: "reviewing" },
  { project: "prism", orbit: "forge", glyphId: "WFE-013", title: "Committed work item", state: "committed" },
  { project: "prism", orbit: "beacon", glyphId: "BC-001", title: "Positioning pass", state: "backlog" },
  // Different project — must be ignored by explodeProjectInto(doc, "prism", ...).
  { project: "vellum", orbit: "forge", glyphId: "VL-001", title: "Other project glyph", state: "backlog" },
];

describe("explodeProjectInto", () => {
  it("produces a valid JSON Canvas document", () => {
    const doc = explodeProjectInto({ nodes: [], edges: [] }, "prism", glyphs);
    expect(Either.isRight(decodeCanvasDoc(doc))).toBe(true);
  });

  it("creates one group node per orbit present in the glyph list", () => {
    const doc = explodeProjectInto({ nodes: [], edges: [] }, "prism", glyphs);
    const groups = doc.nodes.filter((n) => n.type === "group");
    expect(groups.map((g) => g.id).sort()).toEqual(["grp-prism-beacon", "grp-prism-forge"]);
  });

  it("never includes glyphs from another project", () => {
    const doc = explodeProjectInto({ nodes: [], edges: [] }, "prism", glyphs);
    const groups = doc.nodes.filter((n) => n.type === "group");
    expect(groups.find((g) => g.id.includes("vellum"))).toBeUndefined();
    expect(doc.nodes.find((n) => n.id.includes("vl-001"))).toBeUndefined();
  });

  it("binds each glyph node with a key equal to glyphKey(project, orbit, glyphId)", () => {
    const doc = explodeProjectInto({ nodes: [], edges: [] }, "prism", glyphs);
    const forgeGlyphs = glyphs.filter((g) => g.project === "prism" && g.orbit === "forge");
    for (const glyph of forgeGlyphs) {
      const node = doc.nodes.find(
        (n) => n.ether?.bindings?.some((b) => b.source === "tower" && b.ref.type === "glyph" && b.ref.key === glyphKey("prism", "forge", glyph.glyphId)),
      );
      expect(node, `expected a node bound to ${glyph.glyphId}`).toBeDefined();
      expect(node?.type).toBe("text");
    }
  });

  it("truncates a long title to ~40 chars in the node text", () => {
    const longTitle = "A".repeat(80);
    const doc = explodeProjectInto(
      { nodes: [], edges: [] },
      "prism",
      [{ project: "prism", orbit: "forge", glyphId: "WFE-999", title: longTitle, state: "backlog" }],
    );
    const node = doc.nodes.find((n) => n.id === "gly-prism-forge-wfe-999");
    expect(node?.type).toBe("text");
    expect(node && "text" in node ? node.text.length : 0).toBeLessThan(50);
  });

  it("preserves all existing nodes and edges", () => {
    const existing: CanvasDoc = {
      nodes: [{ id: "n1", type: "text", text: "keep me", x: 0, y: 0, width: 100, height: 40 }],
      edges: [],
    };
    const doc = explodeProjectInto(existing, "prism", glyphs);
    expect(doc.nodes.find((n) => n.id === "n1")).toBeDefined();
  });

  it("is idempotent: running twice adds no new nodes", () => {
    const first = explodeProjectInto({ nodes: [], edges: [] }, "prism", glyphs);
    const again = explodeProjectInto(first, "prism", glyphs);
    expect(again.nodes.length).toBe(first.nodes.length);
    expect(again.nodes.map((n) => n.id).sort()).toEqual(first.nodes.map((n) => n.id).sort());
  });

  it("skips an orbit entirely when there are no glyphs for it", () => {
    const doc = explodeProjectInto({ nodes: [], edges: [] }, "prism", []);
    expect(doc.nodes.length).toBe(0);
  });
});

describe("refs key round-trips", () => {
  it("parseGlyphKey(glyphKey(...)) recovers the original triple", () => {
    const key = glyphKey("prism", "forge", "WFE-010");
    expect(parseGlyphKey(key)).toEqual({ project: "prism", orbit: "forge", glyphId: "WFE-010" });
  });

  it("parseOrbitKey(orbitKey(...)) recovers the original pair", () => {
    const key = orbitKey("prism", "forge");
    expect(parseOrbitKey(key)).toEqual({ project: "prism", orbit: "forge" });
  });

  it("parseSessionKey(sessionKey(...)) recovers the original id", () => {
    const key = sessionKey("abc123");
    expect(parseSessionKey(key)).toBe("abc123");
  });

  it("parseGlyphKey rejects a non-glyph key", () => {
    expect(parseGlyphKey("orbit:prism/forge")).toBeUndefined();
    expect(parseGlyphKey("prism")).toBeUndefined();
  });
});
