import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasEdge, CanvasNode } from "../src/shared/canvas";
import type { ActorRef } from "../src/shared/work-protocol";
import type { Task } from "../src/shared/work-model";
import {
  planSchedulerFireSparks,
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
  const agentC = agentNode("agent-c");
  const sink = taskSink("task-sink", [task("t1", "submitted")]);
  const edges = [
    edge("e-claim", "agent-a", "task-sink"),
    edge("e-peer", "agent-a", "agent-b"),
    edge("e-boardish", "agent-a", "agent-c"),
  ];
  const actors = [
    actor("agent-a", "aa"),
    actor("agent-b", "bb"),
    actor("agent-c", "cc"),
  ];

  it("returns nothing on empty prev (canvas open)", () => {
    const next = doc([agentA, sink], edges);
    expect(planWorkEdgeSparks(doc([], []), next, actors)).toEqual([]);
  });

  it("sparks actor→sink edge on claim (source → target)", () => {
    const prev = doc([agentA, agentB, agentC, sink], edges);
    const next = doc(
      [
        agentA,
        agentB,
        agentC,
        taskSink("task-sink", [task("t1", "working", seat("aa"))]),
      ],
      edges,
    );
    expect(planWorkEdgeSparks(prev, next, actors)).toEqual([
      { edgeId: "e-claim", fromNodeId: "agent-a" },
    ]);
  });

  it("sparks only the peer edge for msg.send-enable notices (no storm)", () => {
    // Connecting A↔B delivers mailbox notices on both seats with peerId —
    // previously lit every incident edge of each agent (claim + boardish + peer).
    const withMail = (
      base: CanvasNode,
      peerId: string,
    ): CanvasNode => ({
      ...base,
      ether: {
        ...base.ether!,
        messages: {
          items: [
            {
              messageId: `msg-${base.id}`,
              role: "user",
              parts: [{ kind: "text", text: "msg.send enabled" }],
              metadata: {
                factoryLink: true,
                msgSendEnabled: true,
                peerId,
              },
            },
          ],
        },
      },
    });
    const prev = doc([agentA, agentB, agentC, sink], edges);
    const next = doc(
      [
        withMail(agentA, "agent-b"),
        withMail(agentB, "agent-a"),
        agentC,
        sink,
      ],
      edges,
    );
    const plans = planWorkEdgeSparks(prev, next, actors);
    expect(plans).toEqual([{ edgeId: "e-peer", fromNodeId: "agent-a" }]);
    expect(plans.map((p) => p.edgeId)).not.toContain("e-claim");
    expect(plans.map((p) => p.edgeId)).not.toContain("e-boardish");
  });

  it("sparks a newly created edge source → target only", () => {
    const prev = doc([agentA, agentB, agentC, sink], [
      edge("e-claim", "agent-a", "task-sink"),
      edge("e-boardish", "agent-a", "agent-c"),
    ]);
    const next = doc([agentA, agentB, agentC, sink], edges);
    expect(planWorkEdgeSparks(prev, next, actors)).toEqual([
      { edgeId: "e-peer", fromNodeId: "agent-a" },
    ]);
  });

  it("does not fan-out all incident edges when only one mailbox changes", () => {
    const withMail = (items: NonNullable<CanvasNode["ether"]>["messages"]): CanvasNode => ({
      ...agentB,
      ether: {
        ...agentB.ether!,
        messages: items,
      },
    });
    const prev = doc([agentA, agentB, agentC, sink], edges);
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
        agentC,
        sink,
      ],
      edges,
    );
    // No peer metadata and no co-changed counterpart — stay silent (no storm).
    expect(planWorkEdgeSparks(prev, next, actors)).toEqual([]);
  });

  it("sparks peer edge when new message carries peerId", () => {
    const withMail = (items: NonNullable<CanvasNode["ether"]>["messages"]): CanvasNode => ({
      ...agentB,
      ether: {
        ...agentB.ether!,
        messages: items,
      },
    });
    const prev = doc([agentA, agentB, agentC, sink], edges);
    const next = doc(
      [
        agentA,
        withMail({
          items: [
            {
              messageId: "msg-1",
              role: "user",
              parts: [{ kind: "text", text: "hi" }],
              metadata: { peerId: "agent-a" },
            },
          ],
        }),
        agentC,
        sink,
      ],
      edges,
    );
    expect(planWorkEdgeSparks(prev, next, actors)).toEqual([
      { edgeId: "e-peer", fromNodeId: "agent-a" },
    ]);
  });

  it("skips brand-new nodes (no mass spark on paste)", () => {
    const claimOnly = [edge("e-claim", "agent-a", "task-sink")];
    const prev = doc([agentA], claimOnly);
    const next = doc(
      [agentA, taskSink("task-sink", [task("t1", "working", seat("aa"))])],
      claimOnly,
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

  it("sparks inbound does edges when a sink gains tasks (scheduler delivery)", () => {
    const cron: CanvasNode = {
      id: "cron-1",
      type: "text",
      text: "cron",
      x: 0,
      y: 0,
      width: 80,
      height: 40,
      ether: { entity: { kind: "cron" }, timer: { everyMinutes: 30 } },
    };
    const doesEdge: CanvasEdge = {
      id: "e-effect",
      fromNode: "cron-1",
      toNode: "task-sink",
      ether: { verb: "enqueues" },
    };
    const prev = doc([cron, taskSink("task-sink", [])], [doesEdge]);
    const next = doc(
      [cron, taskSink("task-sink", [task("t-new", "submitted")])],
      [doesEdge],
    );
    expect(planWorkEdgeSparks(prev, next, [])).toEqual([
      { edgeId: "e-effect", fromNodeId: "cron-1" },
    ]);
  });
});

describe("planSchedulerFireSparks", () => {
  it("sparks the fire action and the chain cascade from cron through relay", () => {
    const cron: CanvasNode = {
      id: "cron",
      type: "text",
      text: "cron",
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      ether: { entity: { kind: "cron" } },
    };
    const relay: CanvasNode = {
      id: "relay",
      type: "text",
      text: "relay",
      x: 100,
      y: 0,
      width: 40,
      height: 40,
      ether: { entity: { kind: "relay" } },
    };
    const tasks = taskSink("tasks", []);
    const edges: CanvasEdge[] = [
      { id: "e-chain", fromNode: "cron", toNode: "relay", ether: { verb: "chains" } },
      { id: "e-does", fromNode: "relay", toNode: "tasks", ether: { verb: "enqueues" } },
    ];
    const plans = planSchedulerFireSparks(doc([cron, relay, tasks], edges), "cron");
    expect(plans.map((p) => p.edgeId).sort()).toEqual(["e-chain", "e-does"]);
  });
});
