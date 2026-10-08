import { afterEach, describe, expect, it } from "vitest";
import { asNodeId, type NodeOf } from "../src/shared/model";
import { modelStore } from "../src/renderer/lib/use-model";
import { openModelCanvas } from "./support/open-model-canvas";
import { renameGroup, setNodeColor, setRegionHold } from "../src/renderer/lib/mutations";
import { state$ } from "../src/renderer/lib/state";

// A region carrying everything a region can carry. Each writer that edits a
// region changes its own field and nothing else: a partial edit that dropped
// a field would lose an operator's briefing, defaults, rules or environment
// without anyone having asked for it.

const loaded = (): NodeOf<"region"> => ({
  id: asNodeId("works"), kind: "region", label: "Works", x: 900, y: 0, width: 500, height: 320, z: 0, hold: false,
  background: "content://backgrounds/works.png", backgroundStyle: "cover", instruction: "Ship the works. Ask before deleting anything.",
  defaults: { page: { url: "https://example.com/works", profile: "work" }, paths: { local: "/Users/op/works" } },
  contract: { rules: [{ id: "r1", text: "Tests pass before review." }] },
  environment: { sealed: true, sources: [{ id: "k1", kind: "keychain", name: "EXAMPLE_AUTH_TOKEN", service: "test-region-credential" }], folders: ["/Users/op/works/shared"] },
});
const held = () => {
  const row = modelStore.node$("works-canvas", "works").peek();
  if (row?.kind !== "region") throw new Error("the region is no longer a region");
  return row;
};
let close: (() => Promise<void>) | undefined;
const open = (): void => { close = openModelCanvas("works-canvas", [loaded()]); };
afterEach(async () => { await close?.(); state$.error.set(""); state$.saveState.set("saved"); });

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
