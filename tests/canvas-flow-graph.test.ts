import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { decodeCanvasDoc, type CanvasDoc } from "../src/shared/canvas";
import {
  FlowCycleError,
  flowDestinations,
  flowHops,
  flowSources,
  isFlowEdgeAligned,
  reachableStations,
  validateFlowDag,
} from "../src/shared/flow-graph";

// Pure BFS/DFS helpers over edge ether.flow configs.

const node = (id: string) => ({
  id,
  type: "text" as const,
  text: id,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
});

const flowEdge = (
  id: string,
  fromNode: string,
  toNode: string,
  source = fromNode,
  destination = toNode,
) => ({
  id,
  fromNode,
  toNode,
  ether: { flow: { source, destination } },
});

const doc = (nodes: string[], edges: unknown[]): CanvasDoc =>
  Result.getOrThrow(decodeCanvasDoc({ nodes: nodes.map(node), edges }));

describe("validateFlowDag", () => {
  it("accepts a linear chain", () => {
    const d = doc(
      ["a", "b", "c"],
      [flowEdge("e1", "a", "b"), flowEdge("e2", "b", "c")],
    );
    expect(validateFlowDag(d)).toBeUndefined();
  });

  it("accepts a diamond (fan-out and fan-in are still a DAG)", () => {
    const d = doc(
      ["a", "b", "c", "d"],
      [
        flowEdge("e1", "a", "b"),
        flowEdge("e2", "a", "c"),
        flowEdge("e3", "b", "d"),
        flowEdge("e4", "c", "d"),
      ],
    );
    expect(validateFlowDag(d)).toBeUndefined();
  });

  it("accepts a document with no flow edges", () => {
    const d = doc(["a", "b"], [{ id: "plain", fromNode: "a", toNode: "b" }]);
    expect(validateFlowDag(d)).toBeUndefined();
    expect(flowHops(d)).toEqual([]);
  });

  it("rejects a two-node cycle with the cycle path named", () => {
    const d = doc(
      ["a", "b"],
      [flowEdge("e1", "a", "b"), flowEdge("e2", "b", "a")],
    );
    const error = validateFlowDag(d);
    expect(error).toBeInstanceOf(FlowCycleError);
    expect(error?._tag).toBe("FlowCycleError");
    expect(error?.cycle).toEqual(["a", "b"]);
    expect(error?.message).toContain("a -> b -> a");
  });

  it("rejects a self-loop", () => {
    const d = doc(["a"], [flowEdge("e1", "a", "a")]);
    const error = validateFlowDag(d);
    expect(error).toBeInstanceOf(FlowCycleError);
    expect(error?.cycle).toEqual(["a"]);
  });

  it("rejects a deep cycle reached through a tail", () => {
    const d = doc(
      ["head", "a", "b", "c"],
      [
        flowEdge("e0", "head", "a"),
        flowEdge("e1", "a", "b"),
        flowEdge("e2", "b", "c"),
        flowEdge("e3", "c", "a"),
      ],
    );
    const error = validateFlowDag(d);
    expect(error).toBeInstanceOf(FlowCycleError);
    expect(error?.cycle).toEqual(["a", "b", "c"]);
  });
});

describe("flowDestinations / flowSources", () => {
  it("follows the authored flow direction, not the draw direction", () => {
    // Edge drawn b -> a, flow authored a -> b.
    const d = doc(["a", "b"], [flowEdge("e1", "b", "a", "a", "b")]);
    expect(flowDestinations(d, "a")).toEqual(["b"]);
    expect(flowDestinations(d, "b")).toEqual([]);
    expect(flowSources(d, "b")).toEqual(["a"]);
    expect(flowSources(d, "a")).toEqual([]);
  });

  it("dedupes parallel hops and preserves document edge order", () => {
    const d = doc(
      ["a", "b", "c"],
      [
        flowEdge("e1", "a", "c"),
        flowEdge("e2", "a", "b"),
        flowEdge("e3", "a", "b"),
      ],
    );
    expect(flowDestinations(d, "a")).toEqual(["c", "b"]);
    expect(flowSources(d, "b")).toEqual(["a"]);
  });
});

describe("reachableStations", () => {
  const pipeline = doc(
    ["a", "b", "c", "d", "island"],
    [
      flowEdge("e1", "a", "b"),
      flowEdge("e2", "b", "c"),
      flowEdge("e3", "b", "d"),
    ],
  );

  it("includes the starting station itself", () => {
    expect(reachableStations(pipeline, "b").has("b")).toBe(true);
  });

  it("walks transitively forward only", () => {
    expect([...reachableStations(pipeline, "a")].sort()).toEqual(["a", "b", "c", "d"]);
    expect([...reachableStations(pipeline, "c")].sort()).toEqual(["c"]);
    expect(reachableStations(pipeline, "b").has("a")).toBe(false);
  });

  it("returns only the station itself when it has no flow", () => {
    expect([...reachableStations(pipeline, "island")]).toEqual(["island"]);
  });

  it("terminates on cyclic input", () => {
    const cyclic = doc(
      ["a", "b"],
      [flowEdge("e1", "a", "b"), flowEdge("e2", "b", "a")],
    );
    expect([...reachableStations(cyclic, "a")].sort()).toEqual(["a", "b"]);
  });
});

describe("isFlowEdgeAligned", () => {
  it("accepts both orientations and edges without flow", () => {
    const d = doc(
      ["a", "b"],
      [
        flowEdge("forward", "a", "b", "a", "b"),
        flowEdge("reversed", "a", "b", "b", "a"),
        { id: "plain", fromNode: "a", toNode: "b" },
      ],
    );
    expect(d.edges.every(isFlowEdgeAligned)).toBe(true);
  });

  it("rejects a flow config naming a node that is not an endpoint", () => {
    const d = doc(
      ["a", "b", "c"],
      [flowEdge("stray", "a", "b", "a", "c")],
    );
    expect(isFlowEdgeAligned(d.edges[0]!)).toBe(false);
  });
});
