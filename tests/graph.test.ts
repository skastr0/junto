import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  actorRefResolverFromProjection,
  childRegions,
  groupMembers,
  regionDisplayName,
  regionStack,
  UNNAMED_REGION,
} from "../src/shared/graph";
import { actorRefFixture } from "./helpers/actor-ref-fixtures";

describe("regionDisplayName", () => {
  const group = (label?: string) =>
    ({ id: "g", type: "group", x: 0, y: 0, width: 10, height: 10, ...(label === undefined ? {} : { label }) }) as const;

  it("is the trimmed label whenever the label has any text", () => {
    for (const label of ["PTY", "  forge  ", "0", "x", "false", "unnamed", "\tOps\n"]) {
      expect(regionDisplayName(group(label))).toBe(label.trim());
      expect(regionDisplayName(group(label))).not.toBe(UNNAMED_REGION);
    }
  });

  it("is the one placeholder only when the label is absent, empty or blank", () => {
    for (const label of [undefined, "", "   ", "\n\t"]) {
      expect(regionDisplayName(group(label))).toBe("unnamed region");
    }
  });
});

describe("graph derivations", () => {
  it("groupMembers includes a node whose center is inside the group and excludes one outside", () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: "grp", type: "group", label: "region", x: 0, y: 0, width: 400, height: 200 },
        { id: "inside", type: "text", text: "in", x: 20, y: 20, width: 100, height: 50 },
        { id: "outside", type: "text", text: "out", x: 20, y: 300, width: 100, height: 50 },
      ],
      edges: [],
    };
    expect(groupMembers(doc).get("grp")).toEqual(["inside"]);
  });

  it("projection resolver fails closed for duplicate canvas-local actor refs", () => {
    const first = actorRefFixture("a1");
    const duplicate = {
      ...actorRefFixture("other"),
      canvasName: first.canvasName,
      nodeId: first.nodeId,
    };
    const resolve = actorRefResolverFromProjection([first, duplicate]);

    expect(
      resolve({ canvasName: first.canvasName, nodeId: first.nodeId }),
    ).toBeUndefined();
  });

  it("regionStack: three-deep nesting stacks outer → inner and members belong to every container", () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: "outer", type: "group", label: "outer", x: 0, y: 0, width: 1000, height: 1000 },
        { id: "mid", type: "group", label: "mid", x: 50, y: 50, width: 500, height: 500 },
        { id: "inner", type: "group", label: "inner", x: 100, y: 100, width: 200, height: 200 },
        { id: "n", type: "text", text: "deep", x: 120, y: 120, width: 100, height: 50 },
      ],
      edges: [],
    };
    expect(regionStack(doc, "n").map((g) => g.id)).toEqual(["outer", "mid", "inner"]);
    const members = groupMembers(doc);
    expect(members.get("outer")).toEqual(["n"]);
    expect(members.get("mid")).toEqual(["n"]);
    expect(members.get("inner")).toEqual(["n"]);
  });

  it("regionStack works for a group target (region-in-region), excluding the group itself", () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: "outer", type: "group", x: 0, y: 0, width: 1000, height: 1000 },
        { id: "mid", type: "group", x: 50, y: 50, width: 500, height: 500 },
        { id: "inner", type: "group", x: 100, y: 100, width: 200, height: 200 },
      ],
      edges: [],
    };
    expect(regionStack(doc, "inner").map((g) => g.id)).toEqual(["outer", "mid"]);
    expect(regionStack(doc, "mid").map((g) => g.id)).toEqual(["outer"]);
    expect(regionStack(doc, "outer")).toEqual([]);
  });

  it("childRegions returns every fully contained group; a straddling group is out", () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: "outer", type: "group", x: 0, y: 0, width: 1000, height: 1000 },
        { id: "mid", type: "group", x: 50, y: 50, width: 500, height: 500 },
        { id: "inner", type: "group", x: 100, y: 100, width: 200, height: 200 },
        // extends past outer's right edge — not contained
        { id: "straddler", type: "group", x: 900, y: 0, width: 300, height: 100 },
      ],
      edges: [],
    };
    expect(childRegions(doc, "outer").map((g) => g.id)).toEqual(["mid", "inner"]);
    expect(childRegions(doc, "mid").map((g) => g.id)).toEqual(["inner"]);
    expect(childRegions(doc, "inner")).toEqual([]);
    expect(childRegions(doc, "n-not-a-group")).toEqual([]);
  });

  it("overlapping regions: a node inside both is a member of both, stack order deterministic", () => {
    const doc: CanvasDoc = {
      nodes: [
        // equal areas, partially overlapping — tiebreak on id
        { id: "gB", type: "group", x: 100, y: 0, width: 400, height: 300 },
        { id: "gA", type: "group", x: 0, y: 0, width: 400, height: 300 },
        { id: "n", type: "text", text: "both", x: 150, y: 50, width: 100, height: 50 },
      ],
      edges: [],
    };
    expect(regionStack(doc, "n").map((g) => g.id)).toEqual(["gA", "gB"]);
    const members = groupMembers(doc);
    expect(members.get("gA")).toEqual(["n"]);
    expect(members.get("gB")).toEqual(["n"]);
  });

  it("regionStack excludes partial containment and unknown targets", () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: "outer", type: "group", x: 0, y: 0, width: 400, height: 400 },
        { id: "inner", type: "group", x: 20, y: 20, width: 200, height: 200 },
        // fully inside outer, straddles inner's right edge
        { id: "n", type: "text", text: "straddle", x: 180, y: 40, width: 100, height: 50 },
      ],
      edges: [],
    };
    expect(regionStack(doc, "n").map((g) => g.id)).toEqual(["outer"]);
    expect(regionStack(doc, "missing")).toEqual([]);
  });
});
