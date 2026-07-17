import { describe, expect, it } from "vitest";
import { Either } from "effect";
import {
  decodeCanvasDoc,
  serializeCanvas,
  type CanvasDoc,
} from "../src/shared/canvas";
import {
  findContainingRegion,
  resolveHerdrSpawnDefaults,
  resolvePageSpawnDefaults,
  stripEmptyRegionDefaults,
} from "../src/shared/region-defaults";

const baseDoc = (): CanvasDoc =>
  Either.getOrThrow(
    decodeCanvasDoc({
      nodes: [
        {
          id: "outer",
          type: "group",
          label: "outer",
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          ether: {
            region: {
              hold: true,
              defaults: {
                herdr: { host: "local", session: null, workspaceId: "w-outer" },
                page: { url: "https://outer.example", profile: "work" },
              },
            },
          },
        },
        {
          id: "inner",
          type: "group",
          label: "inner",
          x: 100,
          y: 100,
          width: 300,
          height: 200,
          ether: {
            region: {
              defaults: {
                herdr: {
                  host: "remote-a",
                  session: "dev",
                  workspaceId: "w-inner",
                  tabId: "t1",
                },
              },
            },
          },
        },
        {
          id: "page-only",
          type: "group",
          label: "page-only",
          x: 500,
          y: 100,
          width: 200,
          height: 150,
          ether: {
            region: {
              defaults: {
                page: { url: "https://page-only.example" },
              },
            },
          },
        },
      ],
      edges: [],
    }),
  );

describe("region spawn defaults", () => {
  it("round-trips region.defaults through decode/serialize", () => {
    const doc = baseDoc();
    const again = Either.getOrThrow(decodeCanvasDoc(JSON.parse(serializeCanvas(doc))));
    expect(again).toEqual(doc);
    const outer = again.nodes.find((n) => n.id === "outer");
    expect(outer?.type).toBe("group");
    if (outer?.type === "group") {
      expect(outer.ether?.region?.defaults?.herdr?.host).toBe("local");
      expect(outer.ether?.region?.defaults?.page?.profile).toBe("work");
    }
  });

  it("resolves innermost herdr bag (bag-atomic, no field merge)", () => {
    const doc = baseDoc();
    // Inside inner region — must take whole inner bag, not outer workspace.
    const seed = resolveHerdrSpawnDefaults(doc, 150, 150);
    expect(seed).toEqual({
      host: "remote-a",
      session: "dev",
      workspaceId: "w-inner",
      tabId: "t1",
    });
    // Outside inner, still in outer.
    const outerSeed = resolveHerdrSpawnDefaults(doc, 50, 50);
    expect(outerSeed).toEqual({
      host: "local",
      session: null,
      workspaceId: "w-outer",
    });
  });

  it("walks out for page when inner has no page bag", () => {
    const doc = baseDoc();
    // Inner has only herdr defaults — page resolves from outer.
    const page = resolvePageSpawnDefaults(doc, 150, 150);
    expect(page).toEqual({ url: "https://outer.example", profile: "work" });
    // page-only region has page, no herdr.
    expect(resolvePageSpawnDefaults(doc, 550, 120)).toEqual({
      url: "https://page-only.example",
    });
    expect(resolveHerdrSpawnDefaults(doc, 550, 120)).toEqual({
      host: "local",
      session: null,
      workspaceId: "w-outer",
    });
  });

  it("returns undefined outside any region with defaults", () => {
    const doc = baseDoc();
    expect(resolveHerdrSpawnDefaults(doc, -10, -10)).toBeUndefined();
    expect(resolvePageSpawnDefaults(doc, -10, -10)).toBeUndefined();
    expect(findContainingRegion(doc, -10, -10)).toBeUndefined();
  });

  it("stripEmptyRegionDefaults drops blank hosts and empty bags", () => {
    expect(
      stripEmptyRegionDefaults({
        herdr: { host: "  ", workspaceId: "w1" },
        page: { url: "", profile: "  " },
      }),
    ).toBeUndefined();
    expect(
      stripEmptyRegionDefaults({
        herdr: { host: "local", session: null, workspaceId: " w1 " },
        page: { url: " https://x ", profile: "" },
      }),
    ).toEqual({
      herdr: { host: "local", session: null, workspaceId: "w1" },
      page: { url: "https://x" },
    });
  });

  it("stripping ether leaves valid JSON Canvas", () => {
    const doc = baseDoc();
    const stripped = {
      nodes: doc.nodes.map(({ ether: _e, ...rest }) => rest),
      edges: doc.edges,
    };
    expect(Either.isRight(decodeCanvasDoc(stripped))).toBe(true);
  });
});
