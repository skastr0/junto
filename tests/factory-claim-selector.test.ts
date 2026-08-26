import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  actorsNeedingWake,
  selectFactoryClaims,
} from "../src/shared/factory-tick";
import type { CanvasDoc } from "../src/shared/canvas";
import { ActorRef } from "../src/shared/work-protocol";

const worker = Schema.decodeUnknownSync(ActorRef)({
  seatId: `seat_${"1".repeat(64)}`,
  canvasName: "demo",
  nodeId: "worker",
});

const doc: CanvasDoc = {
  nodes: [
    {
      id: "worker",
      type: "text",
      text: "claude",
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      ether: {
        entity: { kind: "agent", name: "local:claude" },
        terminal: { bindingId: "bind-1", harness: "claude" },
      },
    },
    {
      id: "tasks",
      type: "text",
      text: "tasks",
      x: 200,
      y: 0,
      width: 100,
      height: 80,
      ether: {
        entity: { kind: "task" },
        tasks: {
          items: [
            {
              id: "t1",
              state: "submitted",
              history: [
                {
                  messageId: "m0",
                  role: "user",
                  parts: [{ kind: "text", text: "ship the loop" }],
                  contextId: "demo",
                },
              ],
            },
          ],
        },
      },
    },
  ],
  edges: [
    { id: "e1", fromNode: "worker", toNode: "tasks", ether: { verb: "contributes" } },
  ],
};

describe("factory claim selector", () => {
  it("returns durable work identity without inventing a Canvas mailbox nudge", () => {
    const selected = selectFactoryClaims(
      doc,
      "demo",
      (ref) =>
        ref.canvasName === worker.canvasName && ref.nodeId === worker.nodeId
          ? worker
          : undefined,
    );
    expect(selected).toEqual([
      {
        sink: { canvasName: "demo", nodeId: "tasks" },
        task: {
          kind: "task",
          itemId: "t1",
          sink: { canvasName: "demo", nodeId: "tasks" },
        },
        actor: worker,
      },
    ]);
    expect(
      doc.nodes.find((node) => node.id === "worker")?.ether?.messages,
    ).toBeUndefined();
  });

  it("can exclude only the released task-seat pair while leaving peers eligible", () => {
    const peer = Schema.decodeUnknownSync(ActorRef)({
      seatId: `seat_${"2".repeat(64)}`,
      canvasName: "demo",
      nodeId: "peer",
    });
    const withPeer: CanvasDoc = {
      ...doc,
      nodes: [
        ...doc.nodes,
        {
          ...doc.nodes[0]!,
          id: "peer",
          ether: {
            ...doc.nodes[0]!.ether,
            terminal: { bindingId: "bind-2", harness: "claude" },
          },
        },
      ],
      edges: [
        ...doc.edges,
        { id: "e2", fromNode: "peer", toNode: "tasks", ether: { verb: "contributes" } },
      ],
    };
    const selected = selectFactoryClaims(
      withPeer,
      "demo",
      (ref) => ref.nodeId === "worker"
        ? worker
        : ref.nodeId === "peer"
          ? peer
          : undefined,
      {
        claimEligible: (_task, actor) => actor.seatId !== worker.seatId,
      },
    );

    expect(selected[0]?.actor).toEqual(peer);
  });

  describe("lazy actor wake", () => {
    const peer = Schema.decodeUnknownSync(ActorRef)({
      seatId: `seat_${"2".repeat(64)}`,
      canvasName: "demo",
      nodeId: "peer",
    });
    const twoActors: CanvasDoc = {
      ...doc,
      nodes: [
        ...doc.nodes,
        {
          ...doc.nodes[0]!,
          id: "peer",
          ether: {
            ...doc.nodes[0]!.ether,
            terminal: { bindingId: "bind-2", harness: "claude" },
          },
        },
      ],
      edges: [
        ...doc.edges,
        { id: "e2", fromNode: "peer", toNode: "tasks", ether: { verb: "contributes" } },
      ],
    };
    const resolve = (ref: { readonly nodeId: string }) =>
      ref.nodeId === "worker" ? worker : ref.nodeId === "peer" ? peer : undefined;

    it("wakes nobody when there is no open work", () => {
      const idle: CanvasDoc = {
        ...twoActors,
        nodes: twoActors.nodes.map((node) =>
          node.id === "tasks"
            ? { ...node, ether: { ...node.ether, tasks: { items: [] } } }
            : node,
        ),
      };
      expect([
        ...actorsNeedingWake(idle, "demo", resolve, { isAwake: () => false }),
      ]).toEqual([]);
    });

    it("wakes the actor an open task would fall to", () => {
      expect([
        ...actorsNeedingWake(twoActors, "demo", resolve, {
          isAwake: () => false,
        }),
      ]).toEqual(["peer"]);
    });

    // Coverage is keyed by task, not by actor: the live seat here is not even
    // the one the unrestricted pass would pick, and still nobody is woken.
    it("leaves both asleep when a live seat can already absorb the work", () => {
      expect([
        ...actorsNeedingWake(twoActors, "demo", resolve, {
          isAwake: (actor) => actor.id === "worker",
        }),
      ]).toEqual([]);
    });

    it("does not wake a paused seat", () => {
      expect([
        ...actorsNeedingWake(twoActors, "demo", resolve, {
          isAwake: () => false,
          seatPaused: (nodeId) => nodeId === "peer",
        }),
      ]).toEqual(["worker"]);
    });
  });
});
