import { describe, expect, it } from "vitest";
import { flowDestinations, flowSources, reachableBoards, validateFlowDag } from "../src/shared/flow-graph";
import { asCanvasName, asNodeId, asWireId, type Node, type Wire } from "../src/shared/model";
import type { Canvas } from "../src/shared/model/canvas";

const at = { x: 0, y: 0, width: 10, height: 10, z: 0 };

const seat = (id: string): Node =>
  ({
    kind: "agent", id: asNodeId(id), ...at, agentKey: `local:${id}`, label: id, host: "local",
    overseer: false, bindingId: `bind-${id}`, harness: "claude",
  }) as Node;

const thing = (kind: "task", id: string): Node =>
  ({ kind, id: asNodeId(id), ...at }) as Node;

const wire = (verb: Wire["verb"], from: string, to: string, mask?: Wire["mask"]): Wire => ({
  id: asWireId(`${verb}:${from}:${to}`),
  from: asNodeId(from),
  to: asNodeId(to),
  verb,
  ...(mask === undefined ? {} : { mask }),
});

const canvas = (nodes: ReadonlyArray<Node>, wires: ReadonlyArray<Wire>): Canvas => ({
  name: asCanvasName("factory"),
  seq: 0,
  nodes: new Map(nodes.map((node) => [node.id, node])),
  wires: new Map(wires.map((entry) => [entry.id, entry])),
});

describe("task paths", () => {
  const line = canvas(
    [thing("task", "a"), thing("task", "b"), thing("task", "c"), seat("ana")],
    [wire("flows", "a", "b"), wire("flows", "b", "c"), wire("messages", "ana", "a")],
  );

  it("follows flows wires and nothing else", () => {
    expect(flowDestinations(line, "a")).toEqual(["b"]);
    expect(flowSources(line, "c")).toEqual(["b"]);
    expect(flowDestinations(line, "ana")).toEqual([]);
    expect([...reachableBoards(line, "a")]).toEqual(["a", "b", "c"]);
    expect(validateFlowDag(line)).toBeUndefined();
  });

  it("names the cycle a closing wire would make", () => {
    const loop = canvas([...line.nodes.values()], [...line.wires.values(), wire("flows", "c", "a")]);
    expect(validateFlowDag(loop)?.cycle).toEqual(["a", "b", "c"]);
  });
});
