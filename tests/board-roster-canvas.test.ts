import { describe, expect, it } from "vitest";
import {
  resolveBoardConnectedActors,
  resolvePadInboundActors,
} from "../src/shared/board-actors";
import { edgeNotifyOn, resolveBoardWakeSet } from "../src/shared/board-wake";
import { flowDestinations, flowSources, reachableBoards, validateFlowDag } from "../src/shared/flow-graph";
import { asCanvasName, asNodeId, asWireId, type Node, type Wire } from "../src/shared/model";
import type { Canvas } from "../src/shared/model/canvas";

const at = { x: 0, y: 0, width: 10, height: 10, z: 0 };

const seat = (id: string): Node =>
  ({
    kind: "agent", id: asNodeId(id), ...at, name: `local:${id}`, label: id, host: "local",
    overseer: false, bindingId: `bind-${id}`, harness: "claude", onRemove: "detach",
  }) as Node;

const thing = (kind: "board" | "pad" | "task", id: string): Node =>
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

describe("board wake set", () => {
  const room = canvas(
    [seat("ana"), seat("bo"), seat("cy"), thing("board", "hall"), thing("pad", "sketch")],
    [
      wire("participates", "ana", "hall"),
      wire("messages", "bo", "hall"),
      wire("edits", "cy", "sketch"),
    ],
  );

  it("wakes a seat that participates and not one that only messages", () => {
    expect(resolveBoardWakeSet(room, "hall")).toEqual([
      { nodeId: "ana", target: { bindingId: "bind-ana" } },
    ]);
    expect(edgeNotifyOn(room, "hall", "ana")).toBe(true);
    expect(edgeNotifyOn(room, "ana", "hall")).toBe(true);
    expect(edgeNotifyOn(room, "hall", "bo")).toBe(false);
  });

  it("wakes no one on a board the canvas does not hold", () => {
    expect(resolveBoardWakeSet(room, "gone")).toEqual([]);
  });

  it("lists every seat wired to the board, with whether it can be woken", () => {
    expect(resolveBoardConnectedActors(room, "hall")).toEqual([
      { nodeId: "ana", agentKey: "local:ana", label: "local:ana", wake: true },
      { nodeId: "bo", agentKey: "local:bo", label: "local:bo", wake: false },
    ]);
  });

  it("names only seats with a wire into the pad", () => {
    expect(resolvePadInboundActors(room, "sketch").map((actor) => actor.nodeId)).toEqual(["cy"]);
    expect(resolvePadInboundActors(room, "hall").map((actor) => actor.nodeId)).toEqual(["ana", "bo"]);
    expect(resolvePadInboundActors(room, "gone")).toEqual([]);
  });
});

describe("task paths", () => {
  const line = canvas(
    [thing("task", "a"), thing("task", "b"), thing("task", "c"), seat("ana")],
    [wire("feeds", "a", "b"), wire("feeds", "b", "c"), wire("contributes", "ana", "a")],
  );

  it("follows feeds wires and nothing else", () => {
    expect(flowDestinations(line, "a")).toEqual(["b"]);
    expect(flowSources(line, "c")).toEqual(["b"]);
    expect(flowDestinations(line, "ana")).toEqual([]);
    expect([...reachableBoards(line, "a")]).toEqual(["a", "b", "c"]);
    expect(validateFlowDag(line)).toBeUndefined();
  });

  it("names the cycle a closing wire would make", () => {
    const loop = canvas([...line.nodes.values()], [...line.wires.values(), wire("feeds", "c", "a")]);
    expect(validateFlowDag(loop)?.cycle).toEqual(["a", "b", "c"]);
  });
});
