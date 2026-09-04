import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { decodeCanvasDoc, type CanvasDoc } from "../src/shared/canvas";
import {
  FlowCycleError,
  flowDestinations,
  flowHops,
  flowSources,
  reachableBoards,
  validateFlowDag,
} from "../src/shared/flow-graph";

// Pure BFS/DFS helpers over the `feeds` hops between task sinks.

const node = (id: string) => ({
  id,
  type: "text" as const,
  text: id,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: { entity: { kind: "task" } },
});

/** A hop's direction is the edge's own order: fromNode is upstream. */
const flowEdge = (id: string, fromNode: string, toNode: string) => ({
  id,
  fromNode,
  toNode,
  ether: { verb: "feeds" as const },
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

  it("accepts a document whose only edge is not a hop", () => {
    const d = Result.getOrThrow(
      decodeCanvasDoc({
        nodes: [
          node("a"),
          { ...node("seat"), ether: { entity: { kind: "agent" } } },
        ],
        edges: [
          { id: "plain", fromNode: "seat", toNode: "a", ether: { verb: "contributes" } },
        ],
      }),
    );
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
  it("follows the hop's own direction", () => {
    const d = doc(["a", "b"], [flowEdge("e1", "a", "b")]);
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

describe("reachableBoards", () => {
  const path = doc(
    ["a", "b", "c", "d", "island"],
    [
      flowEdge("e1", "a", "b"),
      flowEdge("e2", "b", "c"),
      flowEdge("e3", "b", "d"),
    ],
  );

  it("includes the starting board itself", () => {
    expect(reachableBoards(path, "b").has("b")).toBe(true);
  });

  it("walks transitively forward only", () => {
    expect([...reachableBoards(path, "a")].sort()).toEqual(["a", "b", "c", "d"]);
    expect([...reachableBoards(path, "c")].sort()).toEqual(["c"]);
    expect(reachableBoards(path, "b").has("a")).toBe(false);
  });

  it("returns only the board itself when it has no flow", () => {
    expect([...reachableBoards(path, "island")]).toEqual(["island"]);
  });

  it("terminates on cyclic input", () => {
    const cyclic = doc(
      ["a", "b"],
      [flowEdge("e1", "a", "b"), flowEdge("e2", "b", "a")],
    );
    expect([...reachableBoards(cyclic, "a")].sort()).toEqual(["a", "b"]);
  });
});
