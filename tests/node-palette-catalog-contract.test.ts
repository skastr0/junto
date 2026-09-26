import { describe, expect, it } from "vitest";
import {
  DEFAULT_NODE_CATALOG_ENTRIES,
  NODE_CATALOG_CATEGORY_ACCENT,
  catalogMatchesQuery,
} from "../src/renderer/components/node-palette/NodeCatalogGrid";

const entry = (id: string) => {
  const match = DEFAULT_NODE_CATALOG_ENTRIES.find((candidate) => candidate.id === id);
  if (!match) throw new Error(`missing catalog entry: ${id}`);
  return match;
};

describe("node palette catalog contract", () => {
  it("assigns one non-blocker accent per node category", () => {
    expect(NODE_CATALOG_CATEGORY_ACCENT).toEqual({
      shell: "text-cyan",
      sinks: "text-amber",
      schedule: "text-violet",
      canvas: "text-indigo",
    });
    expect(Object.values(NODE_CATALOG_CATEGORY_ACCENT)).not.toContain("text-crimson");
  });

  it("gives every entry a one-line description and no wire explainer", () => {
    for (const candidate of DEFAULT_NODE_CATALOG_ENTRIES) {
      expect(candidate.purpose.trim()).not.toBe("");
      expect(candidate.purpose).not.toMatch(/\n/u);
      expect(candidate.purpose).not.toMatch(/\b(?:wires?|ports?)\b/iu);
      expect(Object.keys(candidate).sort()).toEqual(["category", "icon", "id", "label", "purpose"]);
    }
    expect(entry("terminal").category).toBe("shell");
  });
});

describe("catalog query matching", () => {
  it("matches identity fuzzily without reordering the catalog", () => {
    expect(catalogMatchesQuery(entry("terminal"), "termnl")).toBe(true);
    expect(catalogMatchesQuery(entry("region"), "rgn")).toBe(true);
    const visible = DEFAULT_NODE_CATALOG_ENTRIES.filter((candidate) =>
      catalogMatchesQuery(candidate, "t"),
    );
    const original = DEFAULT_NODE_CATALOG_ENTRIES.filter((candidate) =>
      visible.some((row) => row.id === candidate.id),
    );
    expect(visible.map((row) => row.id)).toEqual(original.map((row) => row.id));
  });

  it("matches prose by contiguous substring only", () => {
    expect(catalogMatchesQuery(entry("git"), "commits and diffs")).toBe(true);
    expect(catalogMatchesQuery(entry("git"), "cmtsdf")).toBe(false);
  });

  it("requires every token and allows mixed identity plus prose", () => {
    expect(catalogMatchesQuery(entry("terminal"), "terminal machine")).toBe(true);
    expect(catalogMatchesQuery(entry("terminal"), "terminal missing")).toBe(false);
  });
});
