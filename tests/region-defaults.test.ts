import { describe, expect, it } from "vitest";
import { Result } from "effect";
import {
  decodeCanvasDoc,
  serializeCanvas,
  type CanvasDoc,
} from "../src/shared/canvas";
import {
  findContainingRegion,
  resolvePageSpawnDefaults,
  resolveRegionCwd,
  stripEmptyRegionDefaults,
  stripEmptyRegionPaths,
} from "../src/shared/region-defaults";

const baseDoc = (): CanvasDoc =>
  Result.getOrThrow(
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
                page: { url: "https://outer.example", profile: "work", host: "studio" },
                paths: {
                  local: "/Users/op/outer",
                  "remote-a": "/home/op/outer-remote",
                },
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
                paths: {
                  "remote-a": "/home/op/inner-project",
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
    const again = Result.getOrThrow(decodeCanvasDoc(JSON.parse(serializeCanvas(doc))));
    expect(again).toEqual(doc);
    const outer = again.nodes.find((n) => n.id === "outer");
    expect(outer?.type).toBe("group");
    if (outer?.type === "group") {
      expect(outer.ether?.region?.defaults?.page?.profile).toBe("work");
      expect(outer.ether?.region?.defaults?.page?.host).toBe("studio");
    }
  });


  it("walks out for page when inner has no page bag", () => {
    const doc = baseDoc();
    // Inner has only path defaults — page resolves from outer.
    const page = resolvePageSpawnDefaults(doc, 150, 150);
    expect(page).toEqual({
      url: "https://outer.example",
      profile: "work",
      host: "studio",
    });
    expect(resolvePageSpawnDefaults(doc, 550, 120)).toEqual({
      url: "https://page-only.example",
    });
  });

  it("returns undefined outside any region with defaults", () => {
    const doc = baseDoc();
    expect(resolvePageSpawnDefaults(doc, -10, -10)).toBeUndefined();
    expect(findContainingRegion(doc, -10, -10)).toBeUndefined();
  });

  it("stripEmptyRegionDefaults drops blank hosts and empty bags", () => {
    expect(
      stripEmptyRegionDefaults({
        page: { url: "", profile: "  ", host: "" },
        paths: { local: "  ", "": "/x" },
      }),
    ).toBeUndefined();
    expect(
      stripEmptyRegionDefaults({
        page: { url: " https://x ", profile: "", host: " studio " },
        paths: { local: " /repo ", "  ": "/drop", remote: "" },
      }),
    ).toEqual({
      page: { url: "https://x", host: "studio" },
      paths: { local: "/repo" },
    });
  });

  it("resolveRegionCwd is host-keyed and walks outward", () => {
    const doc = baseDoc();
    // Inside inner: remote-a uses inner path; local walks out to outer.
    expect(resolveRegionCwd(doc, 150, 150, "remote-a")).toBe("/home/op/inner-project");
    expect(resolveRegionCwd(doc, 150, 150, "local")).toBe("/Users/op/outer");
    // Outside inner, still in outer.
    expect(resolveRegionCwd(doc, 50, 50, "local")).toBe("/Users/op/outer");
    expect(resolveRegionCwd(doc, 50, 50, "remote-a")).toBe("/home/op/outer-remote");
    // Unknown host / outside region.
    expect(resolveRegionCwd(doc, 50, 50, "studio")).toBeUndefined();
    expect(resolveRegionCwd(doc, -10, -10, "local")).toBeUndefined();
  });

  it("stripEmptyRegionPaths trims and drops blanks", () => {
    expect(stripEmptyRegionPaths(undefined)).toBeUndefined();
    expect(stripEmptyRegionPaths({ local: "  ", x: "" })).toBeUndefined();
    expect(stripEmptyRegionPaths({ local: " /a ", remote: "/b" })).toEqual({
      local: "/a",
      remote: "/b",
    });
  });

  it("round-trips paths through decode/serialize", () => {
    const doc = baseDoc();
    const again = Result.getOrThrow(decodeCanvasDoc(JSON.parse(serializeCanvas(doc))));
    const outer = again.nodes.find((n) => n.id === "outer");
    expect(outer?.type).toBe("group");
    if (outer?.type === "group") {
      expect(outer.ether?.region?.defaults?.paths).toEqual({
        local: "/Users/op/outer",
        "remote-a": "/home/op/outer-remote",
      });
    }
  });

  it("stripping ether leaves valid JSON Canvas", () => {
    const doc = baseDoc();
    const stripped = {
      nodes: doc.nodes.map(({ ether: _e, ...rest }) => rest),
      edges: doc.edges,
    };
    expect(Result.isSuccess(decodeCanvasDoc(stripped))).toBe(true);
  });
});
