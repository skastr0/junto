import { afterEach, describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import { nodeOfDocument } from "../src/shared/model/from-document";
import { loadDoc, renameGroup, setNodeColor, setRegionHold } from "../src/renderer/lib/mutations";
import { state$ } from "../src/renderer/lib/state";

// A region carrying everything a region can carry. Each writer that edits a
// region changes its own field and nothing else: a partial edit that dropped
// a field would lose an operator's briefing, defaults, rules or environment
// without anyone having asked for it.

const loaded = (): CanvasNode =>
  ({
    id: "works",
    type: "group",
    label: "Works",
    x: 900,
    y: 0,
    width: 500,
    height: 320,
    background: "content://backgrounds/works.png",
    backgroundStyle: "cover",
    ether: {
      region: {
        hold: false,
        instruction: "Ship the works. Ask before deleting anything.",
        defaults: {
          page: { url: "https://example.com/works", profile: "work" },
          paths: { local: "/Users/op/works" },
        },
        contract: { rules: [{ id: "r1", text: "Tests pass before review." }] },
        environment: {
          sealed: true,
          sources: [{ id: "k1", kind: "keychain", name: "EXAMPLE_AUTH_TOKEN", service: "test-region-credential" }],
          folders: ["/Users/op/works/shared"],
        },
      },
    },
  }) as unknown as CanvasNode;

const doc = (): CanvasDoc => ({ nodes: [loaded()], edges: [] });

/** The region as the model holds it, which is what every writer must leave whole. */
const held = () => {
  const node = state$.doc.peek().nodes[0]!;
  const row = nodeOfDocument("works-canvas", node, 0);
  if (row?.kind !== "region") throw new Error("the region is no longer a region");
  return row;
};

const open = (): void => {
  state$.canvasName.set("works-canvas");
  loadDoc(doc(), undefined, "works-canvas");
};

afterEach(() => {
  state$.error.set("");
  state$.saveState.set("saved");
});

describe("a writer that edits a region changes its own field and nothing else", () => {
  it("starts from a region that carries every field", () => {
    open();
    const region = held();
    expect(region.instruction).toBeDefined();
    expect(region.defaults?.page).toBeDefined();
    expect(region.defaults?.paths).toBeDefined();
    expect(region.contract?.rules).toHaveLength(1);
    expect(region.environment?.sources).toHaveLength(1);
    expect(region.background).toBeDefined();
    expect(region.backgroundStyle).toBe("cover");
  });

  it("the hold toggle changes the hold only", () => {
    open();
    const before = held();
    setRegionHold("works", true);
    expect(held()).toEqual({ ...before, hold: true });
    setRegionHold("works", false);
    expect(held()).toEqual(before);
  });

  it("a rename changes the label only, and a rename to empty clears only the label", () => {
    open();
    const before = held();
    renameGroup("works", "Works two");
    expect(held()).toEqual({ ...before, label: "Works two" });
    renameGroup("works", "");
    const { label: _gone, ...unnamed } = before;
    expect(held()).toEqual(unnamed);
  });

  it("a recolour changes the colour only, and clearing it clears only the colour", () => {
    open();
    const before = held();
    setNodeColor("works", "4");
    expect(held()).toEqual({ ...before, color: "4" });
    setNodeColor("works");
    expect(held()).toEqual(before);
  });

  it("all three in a row leave every other field as it was", () => {
    open();
    const before = held();
    setRegionHold("works", true);
    renameGroup("works", "Renamed");
    setNodeColor("works", "2");
    expect(held()).toEqual({ ...before, hold: true, label: "Renamed", color: "2" });
    expect(state$.error.peek()).toBe("");
  });
});
