import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  actorsNeedingWake,
  selectFactoryClaims,
} from "../src/shared/factory-tick";
import type { CanvasDoc, CanvasEdge } from "../src/shared/canvas";
import { admitWorkTarget } from "../src/main/junto/work/authz";
import { ActorRef } from "../src/shared/work-protocol";
import { taskAdmissionState } from "../src/shared/rules";

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
    { id: "e1", fromNode: "tasks", toNode: "worker", ether: { verb: "works" } },
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
        { id: "e2", fromNode: "tasks", toNode: "peer", ether: { verb: "works" } },
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

  it("does not let one ineligible task starve a later eligible task", () => {
    const first = doc.nodes[1]!.ether!.tasks!.items[0]!;
    const withTwoTasks: CanvasDoc = {
      ...doc,
      nodes: doc.nodes.map((node) =>
        node.id === "tasks"
          ? {
            ...node,
            ether: {
              ...node.ether,
              tasks: {
                items: [
                  first,
                  {
                    ...first,
                    id: "t2",
                    history: [{ ...first.history[0]!, messageId: "m2" }],
                  },
                ],
              },
            },
          }
          : node,
      ),
    };

    const selected = selectFactoryClaims(
      withTwoTasks,
      "demo",
      (ref) => ref.nodeId === "worker" ? worker : undefined,
      { claimEligible: (task) => task.id === "t2" },
    );

    expect(selected.map((selection) => selection.task.itemId)).toEqual(["t2"]);
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
        { id: "e2", fromNode: "tasks", toNode: "peer", ether: { verb: "works" } },
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

    it("keeps collision-prone board and task ids as separate coverage keys", () => {
      const task = doc.nodes[1]!.ether!.tasks!.items[0]!;
      const collisionDoc: CanvasDoc = {
        nodes: [
          doc.nodes[0]!,
          {
            ...doc.nodes[0]!,
            id: "peer",
            ether: {
              ...doc.nodes[0]!.ether,
              terminal: { bindingId: "bind-2", harness: "claude" },
            },
          },
          {
            ...doc.nodes[1]!,
            id: "a",
            ether: {
              ...doc.nodes[1]!.ether,
              tasks: { items: [{ ...task, id: "bc" }] },
            },
          },
          {
            ...doc.nodes[1]!,
            id: "ab",
            ether: {
              ...doc.nodes[1]!.ether,
              tasks: { items: [{ ...task, id: "c" }] },
            },
          },
        ],
        edges: [
          { id: "e1", fromNode: "a", toNode: "worker", ether: { verb: "works" } },
          { id: "e2", fromNode: "ab", toNode: "peer", ether: { verb: "works" } },
        ],
      };

      expect([
        ...actorsNeedingWake(collisionDoc, "demo", resolve, {
          isAwake: (actor) => actor.id === "worker",
        }),
      ]).toEqual(["peer"]);
    });

    it("does not wake actors for Approval, waiting, or Me tasks", () => {
      const task = doc.nodes[1]!.ether!.tasks!.items[0]!;
      const gated: CanvasDoc = {
        ...twoActors,
        nodes: twoActors.nodes.map((node) =>
          node.id === "tasks"
            ? {
              ...node,
              ether: {
                ...node.ether,
                tasks: {
                  items: [
                    { ...task, id: "approval", admission: "approval" },
                    { ...task, id: "operator", admission: "operator" },
                    {
                      ...task,
                      id: "waiting",
                      waitUntil: "1970-01-01T00:00:00.100Z",
                    },
                  ],
                },
              },
            }
            : node,
        ),
      };

      expect([
        ...actorsNeedingWake(gated, "demo", resolve, {
          isAwake: () => false,
          claimEligible: (candidate) =>
            taskAdmissionState(candidate, undefined, 0) === "claimable",
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

  // The labor pool is a relationship, not a port. `works` enrolls the seat;
  // `contributes` hands it the same `tasks.claim` key and enrolls nothing.
  describe("assignability", () => {
    const resolve = (ref: { readonly nodeId: string }) =>
      ref.nodeId === "worker" ? worker : undefined;
    const wiredAs = (verb: "works" | "contributes"): CanvasDoc => ({
      ...doc,
      edges: [
        verb === "works"
          ? { id: "e1", fromNode: "tasks", toNode: "worker", ether: { verb } }
          : ({
            id: "e1",
            fromNode: "worker",
            toNode: "tasks",
            ether: { verb },
          } satisfies CanvasEdge),
      ],
    });

    it("assigns the seat that works the sink", () => {
      const selected = selectFactoryClaims(wiredAs("works"), "demo", resolve);
      expect(selected.map((selection) => selection.actor.nodeId)).toEqual([
        "worker",
      ]);
    });

    it("never assigns the seat that only contributes", () => {
      expect(selectFactoryClaims(wiredAs("contributes"), "demo", resolve))
        .toEqual([]);
    });

    it("leaves a contributing seat free to claim by hand", () => {
      // Exactly the gate WorkService runs on `tasks.claim` (requireActor ->
      // admitWorkTarget). Untouched by the assignability filter above: the
      // seat may still take work, it is just never handed any.
      const admitted = admitWorkTarget(
        wiredAs("contributes"),
        "worker",
        "tasks",
        "tasks.claim",
      );
      expect(Result.isSuccess(admitted)).toBe(true);
    });

    it("does not wake a seat the factory would never assign to", () => {
      expect([
        ...actorsNeedingWake(wiredAs("contributes"), "demo", resolve, {
          isAwake: () => false,
        }),
      ]).toEqual([]);
    });
  });
});
