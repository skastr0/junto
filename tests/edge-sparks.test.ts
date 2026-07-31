import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasEdge, CanvasNode } from "../src/shared/canvas";
import type { ActorRef } from "../src/shared/work-protocol";
import type { Task } from "../src/shared/work-model";
import {
  planWorkEdgeSparks,
  workLaneFingerprint,
} from "../src/renderer/lib/edge-sparks";

const seat = (hex: string) =>
  `seat_${hex.padEnd(64, "0")}` as ActorRef["seatId"];

const actor = (nodeId: string, seatHex: string): ActorRef => ({
  seatId: seat(seatHex),
  canvasName: "factory",
  nodeId,
});

const edge = (id: string, fromNode: string, toNode: string): CanvasEdge => ({
  id,
  fromNode,
  toNode,
});

const agentNode = (id: string): CanvasNode => ({
  id,
  type: "text",
  x: 0,
  y: 0,
  width: 120,
  height: 60,
  text: id,
  ether: { entity: { kind: "agent", name: `local:${id}` } },
});

const taskSink = (id: string, items: Task[] = []): CanvasNode => ({
  id,
  type: "text",
  x: 200,
  y: 0,
  width: 160,
  height: 80,
  text: "tasks",
  ether: { entity: { kind: "task" }, tasks: { items } },
});

const task = (id: string, state: Task["state"], claimedBy?: string): Task => ({
  id,
  state,
  history: [
    {
      messageId: `m-${id}`,
      role: "user",
      parts: [{ kind: "text", text: id }],
    },
  ],
  ...(claimedBy ? { claimedBy: claimedBy as Task["claimedBy"] } : {}),
});

const doc = (nodes: CanvasNode[], edges: CanvasEdge[]): CanvasDoc => ({
  nodes,
  edges,
});

describe("workLaneFingerprint", () => {
  it("ignores freeform geometry-only nodes", () => {
    expect(
      workLaneFingerprint({
        id: "n1",
        type: "text",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        text: "note",
      }),
    ).toBeUndefined();
  });

  it("changes when a task claim lands", () => {
    const open = taskSink("task-a", [task("t1", "submitted")]);
    const claimed = taskSink("task-a", [
      task("t1", "working", seat("aa")),
    ]);
    expect(workLaneFingerprint(open)).not.toEqual(workLaneFingerprint(claimed));
  });
});

describe("planWorkEdgeSparks", () => {
  const agentA = agentNode("agent-a");
  const agentB = agentNode("agent-b");
  const sink = taskSink("task-sink", [task("t1", "submitted")]);
  const edges = [
    edge("e-claim", "agent-a", "task-sink"),
    edge("e-peer", "agent-a", "agent-b"),
  ];
  const actors = [actor("agent-a", "aa"), actor("agent-b", "bb")];

  it("returns nothing on empty prev (canvas open)", () => {
    const next = doc([agentA, sink], edges);
    expect(planWorkEdgeSparks(doc([], []), next, actors)).toEqual([]);
  });

  it("sparks actor→sink edge on claim", () => {
    const prev = doc(
      [agentA, agentB, sink],
      edges,
    );
    const next = doc(
      [
        agentA,
        agentB,
        taskSink("task-sink", [task("t1", "working", seat("aa"))]),
      ],
      edges,
    );
    expect(planWorkEdgeSparks(prev, next, actors)).toEqual([
      { edgeId: "e-claim", fromNodeId: "agent-a" },
    ]);
  });

  it("sparks incident edges when messages change on an actor", () => {
    const withMail = (items: NonNullable<CanvasNode["ether"]>["messages"]): CanvasNode => ({
      ...agentB,
      ether: {
        ...agentB.ether!,
        messages: items,
      },
    });
    const prev = doc([agentA, agentB, sink], edges);
    const next = doc(
      [
        agentA,
        withMail({
          items: [
            {
              messageId: "msg-1",
              role: "user",
              parts: [{ kind: "text", text: "hi" }],
            },
          ],
        }),
        sink,
      ],
      edges,
    );
    const plans = planWorkEdgeSparks(prev, next, actors);
    expect(plans).toContainEqual({ edgeId: "e-peer", fromNodeId: "agent-b" });
  });

  it("skips brand-new nodes (no mass spark on paste)", () => {
    const prev = doc([agentA], [edge("e-claim", "agent-a", "task-sink")]);
    const next = doc(
      [agentA, taskSink("task-sink", [task("t1", "working", seat("aa"))])],
      edges,
    );
    // sink is new in next — claim counterparty path skipped for new node
    expect(planWorkEdgeSparks(prev, next, actors)).toEqual([]);
  });

  it("ignores pure geometry moves", () => {
    const prev = doc([agentA, sink], edges);
    const moved: CanvasNode = { ...agentA, x: 99, y: 40 };
    const next = doc([moved, sink], edges);
    expect(planWorkEdgeSparks(prev, next, actors)).toEqual([]);
  });
});
