import { describe, expect, it } from "vitest";
import { deriveTargets, flowDestinations, flowHops, flowSources, reachableBoards, validateFlowDag } from "../src/shared/flow-graph";
import { asNodeId, asWireId, type Wire } from "../src/shared/model";
import type { Canvas } from "../src/shared/model/canvas";

const wire = (verb: Wire["verb"], from: string, to: string, tag = ""): Wire => ({
  id: asWireId(`${verb}:${from}:${to}${tag}`),
  from: asNodeId(from),
  to: asNodeId(to),
  verb,
});

const wired = (...wires: ReadonlyArray<Wire>): Pick<Canvas, "wires"> => ({
  wires: new Map(wires.map((entry) => [entry.id, entry])),
});

const flow = (from: string, to: string, tag = "") => wire("flows", from, to, tag);

describe("flow graph", () => {
  it("reads only task to task flow wires, in wire order", () => {
    const canvas = wired(flow("a", "b"), wire("messages", "a", "c"), flow("a", "d"));
    expect(flowHops(canvas)).toEqual([
      { edgeId: "flows:a:b", source: "a", destination: "b" },
      { edgeId: "flows:a:d", source: "a", destination: "d" },
    ]);
    expect(flowDestinations(canvas, "a")).toEqual(["b", "d"]);
  });

  it("dedupes parallel wires between the same two nodes", () => {
    const canvas = wired(flow("a", "b"), flow("a", "b", ":again"));
    expect(flowDestinations(canvas, "a")).toEqual(["b"]);
    expect(flowSources(canvas, "b")).toEqual(["a"]);
  });

  it("names a node with no downstream as the end of the line", () => {
    const canvas = wired(flow("a", "b"));
    expect(flowDestinations(canvas, "b")).toEqual([]);
    expect(flowSources(canvas, "a")).toEqual([]);
  });

  it("reaches every node a diamond leads to, once", () => {
    const canvas = wired(flow("a", "b"), flow("a", "c"), flow("b", "d"), flow("c", "d"));
    expect([...reachableBoards(canvas, "a")]).toEqual(["a", "b", "c", "d"]);
    expect([...reachableBoards(canvas, "c")]).toEqual(["c", "d"]);
    expect(validateFlowDag(canvas)).toBeUndefined();
  });

  it("refuses a cycle, a node flowing into itself included", () => {
    expect(validateFlowDag(wired(flow("a", "a")))?.cycle).toEqual(["a"]);
    const loop = validateFlowDag(wired(flow("x", "a"), flow("a", "b"), flow("b", "a")));
    expect(loop?.cycle).toEqual(["a", "b"]);
    expect(loop?.message).toBe("task path must stay a DAG; cycle: a -> b -> a");
  });

  it("terminates on cyclic input when walking reach", () => {
    expect([...reachableBoards(wired(flow("a", "b"), flow("b", "a")), "a")]).toEqual(["a", "b"]);
  });

  it("keeps the derives graph a DAG on its own, apart from flows", () => {
    const derive = (from: string, to: string) => wire("derives", from, to);
    const canvas = wired(flow("a", "b"), derive("a", "c"), derive("a", "d"), derive("b", "a"));
    expect(deriveTargets(canvas, "a")).toEqual(["c", "d"]);
    expect(flowDestinations(canvas, "a")).toEqual(["b"]);
    // a flows into b and b derives into a: two graphs, neither loops.
    expect(validateFlowDag(canvas)).toBeUndefined();
    expect(validateFlowDag(wired(derive("a", "b"), derive("b", "a")))?.cycle).toEqual(["a", "b"]);
  });
});
