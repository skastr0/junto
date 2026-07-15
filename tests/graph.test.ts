import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { blockedClosure, blockedEdgeIds, groupMembers } from "../src/shared/graph";

const project = (id: string, label: string, flags?: ReadonlyArray<"blocker" | "parked" | "attention">) => ({
  id,
  type: "text" as const,
  text: label,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: {
    entity: { kind: "project" as const },
    bindings: [{ source: "tower" as const, ref: { type: "project" as const, key: id } }],
    ...(flags ? { flags: [...flags] } : {}),
  },
});

describe("graph derivations", () => {
  it("blockedClosure is transitive: a blocks b blocks c => {b, c}", () => {
    const doc: CanvasDoc = {
      nodes: [
        project("a", "a", ["blocker"]),
        project("b", "b"),
        project("c", "c"),
      ],
      edges: [
        { id: "e-ab", fromNode: "a", toNode: "b", ether: { kind: "blocks" } },
        { id: "e-bc", fromNode: "b", toNode: "c", ether: { kind: "blocks" } },
      ],
    };

    const blocked = blockedClosure(doc);
    expect(blocked).toEqual(new Set(["b", "c"]));
  });

  it("blockedEdgeIds picks both edges in the transitive chain", () => {
    const doc: CanvasDoc = {
      nodes: [
        project("a", "a", ["blocker"]),
        project("b", "b"),
        project("c", "c"),
      ],
      edges: [
        { id: "e-ab", fromNode: "a", toNode: "b", ether: { kind: "blocks" } },
        { id: "e-bc", fromNode: "b", toNode: "c", ether: { kind: "blocks" } },
      ],
    };

    const ids = blockedEdgeIds(doc);
    expect(ids).toEqual(new Set(["e-ab", "e-bc"]));
  });

  it("groupMembers includes a node whose center is inside the group and excludes one outside", () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: "grp", type: "group", label: "region", x: 0, y: 0, width: 400, height: 200 },
        // center (70, 45) is inside [0,400]x[0,200]
        { id: "inside", type: "text", text: "in", x: 20, y: 20, width: 100, height: 50 },
        // center (70, 325) is outside the group's y range
        { id: "outside", type: "text", text: "out", x: 20, y: 300, width: 100, height: 50 },
      ],
      edges: [],
    };

    const members = groupMembers(doc);
    expect(members.get("grp")).toEqual(["inside"]);
  });
});
