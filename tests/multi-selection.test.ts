import { agentKeysAmong, classifySelectionOf, seatIdsAmong, selectionLabelOf, surfaceKeyOf } from "../src/renderer/lib/multi-selection";
import { note, region, seat, taskBoard } from "./support/model-nodes";
import { describe, expect, it } from "vitest";
import { asNodeId, type Node } from "../src/shared/model";
import { surfaceLabel } from "../src/renderer/lib/multi-selection";

describe("labels", () => {
  it("names a surface in the plural", () => {
    expect(surfaceLabel("kind:agent")).toBe("agents");
    expect(surfaceLabel("region")).toBe("regions");
  });
});

describe("the same classification of model nodes", () => {
  it("keys a node in the words the document form gave", () => {
    expect(surfaceKeyOf(region("r", { x: 0, y: 0, width: 400, height: 300 }))).toBe("region");
    expect(surfaceKeyOf(seat("a"))).toBe("kind:agent");
    expect(surfaceKeyOf(note("n"))).toBe("type:text");
    expect(surfaceKeyOf(taskBoard("t"))).toBe("kind:task");
    const link = { kind: "link", id: asNodeId("l"), url: "https://x.com", x: 0, y: 0, width: 200, height: 80, z: 0 } as Node;
    expect(surfaceKeyOf(link)).toBe("type:link");
  });

  it("classifies empty, single, alike and mixed selections", () => {
    const one = seat("a");
    expect(classifySelectionOf([])).toEqual({ mode: "empty" });
    expect(selectionLabelOf(classifySelectionOf([]))).toBe("no selection");
    expect(selectionLabelOf(classifySelectionOf([one]))).toBe("1 selected");
    expect(classifySelectionOf([one])).toEqual({ mode: "single", node: one });
    const alike = [seat("a"), seat("b")];
    expect(classifySelectionOf(alike)).toEqual({ mode: "homogeneous", surface: "kind:agent", nodes: alike });
    expect(selectionLabelOf(classifySelectionOf(alike))).toBe("2 - agents");
    const mixed = classifySelectionOf([seat("a"), note("n")]);
    expect(mixed).toMatchObject({ mode: "heterogeneous", surfaces: ["kind:agent", "type:text"] });
    expect(selectionLabelOf(mixed)).toBe("2 - mixed");
  });

  it("finds the seats in a selection, in order", () => {
    const nodes = [note("n"), seat("b"), seat("a")];
    expect(seatIdsAmong(nodes)).toEqual(["b", "a"]);
    expect(agentKeysAmong(nodes)).toEqual([
      { nodeId: "b", agentKey: "local:b" },
      { nodeId: "a", agentKey: "local:a" },
    ]);
  });
});
