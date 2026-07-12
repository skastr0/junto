import { describe, expect, it } from "vitest";
import { Either } from "effect";
import { decodeCanvasDoc } from "../src/shared/canvas";
import type { SnapshotState } from "../src/shared/entities";
import { buildPortfolioDoc, mergePortfolioInto, mergeProjects } from "../src/shared/portfolio";

const state: SnapshotState = {
  bundles: [
    {
      source: "tower",
      fetchedAt: "2026-07-12T00:00:00.000Z",
      ok: true,
      entities: [
        { source: "tower", key: "prism", kind: "project", title: "prism", stats: { glyphs_active: 60 }, updatedAt: "2026-07-12T00:00:00.000Z" },
        { source: "tower", key: "PRISM", kind: "project", title: "PRISM", stats: { glyphs_active: 0 }, updatedAt: "2026-07-12T00:00:00.000Z" },
        { source: "tower", key: "relay", kind: "project", title: "relay", stats: { glyphs_active: 5 }, updatedAt: "2026-07-12T00:00:00.000Z" },
      ],
    },
    {
      source: "quasar",
      fetchedAt: "2026-07-12T00:00:00.000Z",
      ok: true,
      entities: [
        { source: "quasar", key: "git:github.com/skastr0/prism", kind: "project", title: "prism", stats: {}, updatedAt: "2026-07-12T00:00:00.000Z" },
        { source: "quasar", key: "git:github.com/third/party-clone", kind: "project", title: "party-clone", stats: {}, updatedAt: "2026-07-12T00:00:00.000Z" },
      ],
    },
    { source: "booth", fetchedAt: "2026-07-12T00:00:00.000Z", ok: false, error: "502", entities: [] },
  ],
};

describe("portfolio merge", () => {
  it("dedups a same-source duplicate by activity — real prism wins over empty PRISM", () => {
    const merged = mergeProjects(state);
    const prism = merged.find((p) => p.display.toLowerCase() === "prism");
    expect(prism?.display).toBe("prism");
    const towerBinding = prism?.bindings.find((b) => b.source === "tower");
    expect(towerBinding?.ref.key).toBe("prism");
  });

  it("merges the same project across sources into one node with both bindings", () => {
    const prism = mergeProjects(state).find((p) => p.display.toLowerCase() === "prism");
    expect(prism?.bindings.map((b) => b.source).sort()).toEqual(["quasar", "tower"]);
  });

  it("excludes third-party repos by default, includes them with { all }", () => {
    const owned = mergeProjects(state).map((p) => p.display);
    expect(owned).not.toContain("party-clone");
    const all = mergeProjects(state, { all: true }).map((p) => p.display);
    expect(all).toContain("party-clone");
  });

  it("orders busiest-first", () => {
    const displays = mergeProjects(state).map((p) => p.display);
    expect(displays[0]).toBe("prism");
  });

  it("produces a valid JSON Canvas document", () => {
    const doc = buildPortfolioDoc(state);
    expect(Either.isRight(decodeCanvasDoc(doc))).toBe(true);
  });

  it("merge preserves existing nodes and skips already-bound projects", () => {
    const existing = buildPortfolioDoc(state);
    const before = existing.nodes.length;
    const again = mergePortfolioInto(existing, state);
    expect(again.nodes.length).toBe(before);
  });
});
