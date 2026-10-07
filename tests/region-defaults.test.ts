import { describe, expect, it } from "vitest";
import { Result, Schema } from "effect";
import { Node } from "../src/shared/model";
import {
  findContainingRegion,
  resolvePageSpawnDefaults,
  resolveRegionCwd,
  stripEmptyRegionDefaults,
  stripEmptyRegionPaths,
} from "../src/shared/region-defaults";
import { canvasOf, region } from "./support/model-nodes";

const outer = region("outer", { x: 0, y: 0, width: 800, height: 600 }, {
  label: "outer",
  hold: true,
  defaults: {
    page: { url: "https://outer.example", profile: "work", host: "studio" },
    paths: {
      local: "/Users/op/outer",
      "remote-a": "/home/op/outer-remote",
    },
  },
});

const canvas = canvasOf([
  outer,
  region("inner", { x: 100, y: 100, width: 300, height: 200 }, {
    label: "inner",
    defaults: { paths: { "remote-a": "/home/op/inner-project" } },
  }),
  region("page-only", { x: 500, y: 100, width: 200, height: 150 }, {
    label: "page-only",
    defaults: { page: { url: "https://page-only.example" } },
  }),
]);

describe("region spawn defaults", () => {
  it("a region with page and path defaults is a node the model accepts", () => {
    const decoded = Schema.decodeUnknownResult(Node)(outer, { onExcessProperty: "error" });
    expect(Result.isSuccess(decoded)).toBe(true);
  });

  it("walks out for page when inner has no page bag", () => {
    // Inner has only path defaults — page resolves from outer.
    const page = resolvePageSpawnDefaults(canvas, 150, 150);
    expect(page).toEqual({
      url: "https://outer.example",
      profile: "work",
      host: "studio",
    });
    expect(resolvePageSpawnDefaults(canvas, 550, 120)).toEqual({
      url: "https://page-only.example",
    });
  });

  it("returns undefined outside any region with defaults", () => {
    expect(resolvePageSpawnDefaults(canvas, -10, -10)).toBeUndefined();
    expect(findContainingRegion(canvas, -10, -10)).toBeUndefined();
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
    // Inside inner: remote-a uses inner path; local walks out to outer.
    expect(resolveRegionCwd(canvas, 150, 150, "remote-a")).toBe("/home/op/inner-project");
    expect(resolveRegionCwd(canvas, 150, 150, "local")).toBe("/Users/op/outer");
    // Outside inner, still in outer.
    expect(resolveRegionCwd(canvas, 50, 50, "local")).toBe("/Users/op/outer");
    expect(resolveRegionCwd(canvas, 50, 50, "remote-a")).toBe("/home/op/outer-remote");
    // Unknown host / outside region.
    expect(resolveRegionCwd(canvas, 50, 50, "studio")).toBeUndefined();
    expect(resolveRegionCwd(canvas, -10, -10, "local")).toBeUndefined();
  });

  it("stripEmptyRegionPaths trims and drops blanks", () => {
    expect(stripEmptyRegionPaths(undefined)).toBeUndefined();
    expect(stripEmptyRegionPaths({ local: "  ", x: "" })).toBeUndefined();
    expect(stripEmptyRegionPaths({ local: " /a ", remote: "/b" })).toEqual({
      local: "/a",
      remote: "/b",
    });
  });
});
