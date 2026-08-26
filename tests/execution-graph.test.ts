import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { ActorRefResolver } from "../src/shared/attention";
import {
  composeRegionExecutionContext,
  deriveExecutionGraph,
  evaluateEdge,
  type ExecutionGraphContext,
  type LiveTrustViews,
} from "../src/shared/execution-graph";
import { groupMembers } from "../src/shared/graph";
import {
  ActorRef,
  type ActorRef as ActorRefValue,
} from "../src/shared/work-protocol";
import { taskItem } from "./helpers/task-fixtures";
import { geographySeat, seat } from "./helpers/physics-seats";

const actorRef = (
  nodeId: string,
  digit: string,
  canvasName = "c",
): ActorRefValue =>
  Schema.decodeUnknownSync(ActorRef)({
    seatId: `seat_${digit.repeat(64)}`,
    canvasName,
    nodeId,
  });

const resolverFor = (
  actors: ReadonlyArray<ActorRefValue>,
): ActorRefResolver =>
  (ref) => {
    const matches = actors.filter(
      (actor) =>
        actor.canvasName === ref.canvasName && actor.nodeId === ref.nodeId,
    );
    return matches.length === 1 ? matches[0] : undefined;
  };

const contextFor = (
  actors: ReadonlyArray<ActorRefValue> = [],
  trust?: LiveTrustViews,
): ExecutionGraphContext => ({
  canvasName: "c",
  resolveActorRef: resolverFor(actors),
  ...(trust ?? {}),
});

const ownedTask = (
  task: ReturnType<typeof taskItem>,
  actor: ActorRefValue,
) => ({
  ...task,
  claimedBy: actor.seatId,
});

const text = (
  id: string,
  label: string,
  ether?: CanvasDoc["nodes"][number]["ether"],
): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: label,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ...(ether ? { ether } : {}),
});

describe("evaluateEdge — derived work-lane stoppage", () => {
  it("non-work-lane access → relates", () => {
    const edge = { id: "e1", fromNode: "a", toNode: "b" };
    const result = evaluateEdge(
      edge,
      seat("a", "sink"),
      seat("b", "actor"),
      contextFor(),
    );
    expect(result.phase).toBe("relates");
    expect(result.generates).toBe(false);
  });

  it("tasks: queues relate; claimed attention blocks the seat", () => {
    const edge = {
      id: "e1",
      fromNode: "t1",
      toNode: "b",
    };
    const worker = seat("b", "actor", { label: "B" });
    const workerIdentity = actorRef("b", "1");
    const elsewhere = actorRef("someone-else", "2");
    const context = contextFor([workerIdentity]);
    const openQueue = text("t1", "Checklist", {
      entity: { kind: "task" },
      tasks: {
        items: [
          taskItem("i1", "one", "submitted"),
          ownedTask(taskItem("i2", "two", "working"), workerIdentity),
        ],
      },
    });
    expect(evaluateEdge(edge, openQueue, worker, context).phase).toBe("relates");
    expect(evaluateEdge(edge, openQueue, worker, context).generates).toBe(false);

    const heldHere = text("t1", "Checklist", {
      entity: { kind: "task" },
      tasks: {
        items: [
          ownedTask(
            taskItem("i1", "one", "input-required"),
            workerIdentity,
          ),
        ],
      },
    });
    expect(evaluateEdge(edge, heldHere, worker, context).phase).toBe("blocks");
    expect(evaluateEdge(edge, heldHere, worker, context).generates).toBe(true);
    const unresolved = evaluateEdge(
      edge,
      heldHere,
      worker,
      contextFor(),
    );
    expect(unresolved.phase).toBe("relates");
    expect(unresolved.detail).toContain("actor identity unresolved");

    const heldElsewhere = text("t1", "Checklist", {
      entity: { kind: "task" },
      tasks: {
        items: [
          ownedTask(
            taskItem("i1", "one", "input-required"),
            elsewhere,
          ),
        ],
      },
    });
    expect(evaluateEdge(edge, heldElsewhere, worker, context).phase).toBe(
      "relates",
    );

    const empty = text("t1", "Checklist", { entity: { kind: "task" }, tasks: { items: [] } });
    expect(evaluateEdge(edge, empty, worker, context).phase).toBe("relates");

    // Reverse draw direction agent→task still blocks the actor seat.
    const reverse = {
      id: "e-rev",
      fromNode: "b",
      toNode: "t1",
    };
    expect(evaluateEdge(reverse, worker, heldHere, context).phase).toBe("blocks");
    expect(evaluateEdge(reverse, worker, heldHere, context).generates).toBe(true);
    const revGraph = deriveExecutionGraph(
      {
        nodes: [worker, heldHere],
        edges: [reverse],
      },
      context,
    );
    expect(revGraph.blocked.has("b")).toBe(true);
    expect(revGraph.blocked.has("t1")).toBe(false);
  });

  it("requests: pending blocks its raiser only; other and resolved relate", () => {
    const edge = {
      id: "e1",
      fromNode: "r1",
      toNode: "b",
    };
    const worker = seat("b", "actor", { label: "B" });
    const workerIdentity = actorRef("b", "1");
    const other = actorRef("other", "2");
    const context = contextFor([workerIdentity]);
    const raisedHere = text("r1", "Requests", {
      entity: { kind: "requests" },
      requests: {
        items: [
          ownedTask(
            taskItem("q1", "approve?", "input-required"),
            workerIdentity,
          ),
        ],
      },
    });
    expect(evaluateEdge(edge, raisedHere, worker, context).phase).toBe("blocks");

    const raisedElsewhere = text("r1", "Requests", {
      entity: { kind: "requests" },
      requests: {
        items: [
          ownedTask(taskItem("q1", "approve?", "input-required"), other),
        ],
      },
    });
    expect(evaluateEdge(edge, raisedElsewhere, worker, context).phase).toBe(
      "relates",
    );

    for (const state of ["completed", "rejected", "canceled"] as const) {
      const resolved = text("r1", "Requests", {
        entity: { kind: "requests" },
        requests: {
          items: [ownedTask(taskItem("q1", "approve?", state), workerIdentity)],
        },
      });
      expect(evaluateEdge(edge, resolved, worker, context).phase).toBe(
        "relates",
      );
    }
  });
});

describe("deriveExecutionGraph — no cascade", () => {
  it("projects live escalation stoppage directly onto its actor", () => {
    const actor = actorRef("agent", "1");
    const doc: CanvasDoc = {
      nodes: [
        seat("agent", "actor"),
        seat("requests", "sink", { name: "requests" }),
      ],
      edges: [],
    };
    const graph = deriveExecutionGraph(doc, {
      ...contextFor([actor]),
      workBlockedSeats: new Map([
        [
          "agent",
          {
            requestId: "request-1",
            targetNodeId: "requests",
            detail: "choose deployment",
          },
        ],
      ]),
    });

    expect(graph.blocked).toEqual(new Set(["agent"]));
    expect(graph.reasonsByNodeId.get("agent")).toEqual([
      {
        kind: "work",
        requestId: "request-1",
        targetNodeId: "requests",
        detail: "choose deployment",
      },
    ]);
    expect(graph.blockedEdgeIds.size).toBe(0);
  });

  it("claimed input-required blocks the claimant only; no second-hop propagation", () => {
    const a1 = actorRef("a1", "1");
    const a2 = actorRef("a2", "2");
    const doc: CanvasDoc = {
      nodes: [
        text("t1", "Checklist", {
          entity: { kind: "task" },
          tasks: {
            items: [
              ownedTask(taskItem("i1", "do it", "input-required"), a1),
            ],
          },
        }),
        seat("a1", "actor", { label: "A1" }),
        seat("a2", "actor", { label: "A2" }),
      ],
      edges: [
        {
          id: "e1",
          fromNode: "t1",
          toNode: "a1",
        },
        // Actor↔actor is not a work lane — soft relates (no cascade).
        {
          id: "e2",
          fromNode: "a1",
          toNode: "a2",
        },
      ],
    };
    const graph = deriveExecutionGraph(doc, contextFor([a1, a2]));
    expect(graph.phaseByEdgeId.get("e1")).toBe("blocks");
    expect(graph.phaseByEdgeId.get("e2")).toBe("relates");
    expect(graph.blocked).toEqual(new Set(["a1"]));
    expect(graph.blocked.has("a2")).toBe(false);
  });

  it("a blocked seat never spreads its stoppage to the seat it messages", () => {
    const a1 = actorRef("a1", "1");
    const a2 = actorRef("a2", "2");
    const doc: CanvasDoc = {
      nodes: [seat("a1", "actor", { label: "A1" }), seat("a2", "actor", { label: "A2" })],
      edges: [{ id: "e-rel", fromNode: "a1", toNode: "a2" }],
    };
    const graph = deriveExecutionGraph(doc, {
      ...contextFor([a1, a2]),
      workBlockedSeats: new Map([
        [
          "a1",
          {
            requestId: "req-1",
            targetNodeId: "requests",
            detail: "choose deployment",
          },
        ],
      ]),
    });
    expect(graph.blocked).toEqual(new Set(["a1"]));
    expect(graph.blocked.has("a2")).toBe(false);
  });

  // Stoppage never fans out on its own: a second hop is an explicit relay the
  // operator drew. The law above is the whole of it — nothing else to assert.

  it("stable seat identity blocks through an alias; another seat does not", () => {
    const docFor = (items: ReadonlyArray<ReturnType<typeof taskItem>>): CanvasDoc => ({
      nodes: [
        text("t1", "Queue", { entity: { kind: "task" }, tasks: { items: [...items] } }),
        seat("a1", "actor", { label: "A1" }),
        seat("a2", "actor", { label: "A2" }),
      ],
      edges: [
        { id: "e1", fromNode: "t1", toNode: "a1" },
        { id: "e2", fromNode: "t1", toNode: "a2" },
      ],
    });
    const a1 = actorRef("a1", "1");
    const a2 = actorRef("a2", "2");
    const other = actorRef("other", "3");

    const calm = deriveExecutionGraph(
      docFor([
        ownedTask(
          taskItem("i1", "needs a human", "input-required"),
          other,
        ),
      ]),
      contextFor([a1, a2]),
    );
    expect(calm.blocked.size).toBe(0);
    expect(calm.phaseByEdgeId.get("e1")).toBe("relates");
    expect(calm.phaseByEdgeId.get("e2")).toBe("relates");

    const a2Alias = actorRef("a2-alias", "2");
    const held = deriveExecutionGraph(
      docFor([
        ownedTask(
          taskItem("i1", "needs a human", "auth-required"),
          a2Alias,
        ),
      ]),
      contextFor([a1, a2]),
    );
    expect(held.blocked).toEqual(new Set(["a2"]));
    expect(held.phaseByEdgeId.get("e1")).toBe("relates");
    expect(held.phaseByEdgeId.get("e2")).toBe("blocks");
  });

  it("sink targets never join blocked set", () => {
    const actor = actorRef("actor1", "1");
    const doc: CanvasDoc = {
      nodes: [
        text("t1", "Checklist", {
          entity: { kind: "task" },
          tasks: {
            items: [
              ownedTask(taskItem("i1", "x", "input-required"), actor),
            ],
          },
        }),
        seat("s1", "sink", { label: "sink" }),
      ],
      edges: [
        {
          id: "e1",
          fromNode: "t1",
          toNode: "s1",
        },
      ],
    };
    const graph = deriveExecutionGraph(doc, contextFor([actor]));
    // Work-lane eval may generate blocks, but sinks are not blockable seats.
    expect(graph.blocked.has("s1")).toBe(false);
  });

  it("manual blocker flags the actor only (no outbound cascade)", () => {
    const doc: CanvasDoc = {
      nodes: [
        seat("b", "actor", { label: "B", flags: ["blocker"] }),
        seat("c", "actor", { label: "C" }),
      ],
      edges: [
        {
          id: "e-bc",
          fromNode: "b",
          toNode: "c",
        },
      ],
    };
    const graph = deriveExecutionGraph(
      doc,
      contextFor([actorRef("b", "1"), actorRef("c", "2")]),
    );
    expect(graph.seedNodeIds.has("b")).toBe(true);
    expect(graph.blocked.has("b")).toBe(true);
    expect(graph.blocked.has("c")).toBe(false);
  });

  it("geography and sinks never blocked; actors can be", () => {
    const actor = actorRef("actor1", "1");
    const doc: CanvasDoc = {
      nodes: [
        text("t1", "Checklist", {
          entity: { kind: "task" },
          tasks: {
            items: [
              ownedTask(taskItem("i1", "x", "input-required"), actor),
            ],
          },
        }),
        geographySeat("note1"),
        seat("actor1", "actor"),
      ],
      edges: [
        { id: "e1", fromNode: "t1", toNode: "note1" },
        { id: "e2", fromNode: "t1", toNode: "actor1" },
      ],
    };
    const graph = deriveExecutionGraph(doc, contextFor([actor]));
    expect(graph.blocked.has("note1")).toBe(false);
    expect(graph.blocked.has("actor1")).toBe(true);
  });

});

describe("composeRegionExecutionContext", () => {
  it("includes edges, blocked reasons, and in-region task lists", () => {
    const actor = actorRef("b", "1");
    const doc: CanvasDoc = {
      nodes: [
        { id: "grp", type: "group", label: "region", x: 0, y: 0, width: 500, height: 300 },
        seat("a", "sink", { label: "Alpha", name: "pa", x: 20, y: 20 }),
        seat("b", "actor", { label: "Beta", x: 200, y: 20 }),
        text("t1", "Ops", {
          entity: { kind: "task" },
          tasks: {
            items: [
              ownedTask(
                taskItem("i1", "ship docs", "input-required"),
                actor,
              ),
            ],
          },
        }),
      ],
      edges: [
        {
          id: "e-tb",
          fromNode: "t1",
          toNode: "b",
        },
      ],
    };
    (doc.nodes[3] as { x: number; y: number }).x = 40;
    (doc.nodes[3] as { y: number }).y = 100;

    const graph = deriveExecutionGraph(doc, contextFor([actor]));
    const members = groupMembers(doc).get("grp") ?? [];
    const ctx = composeRegionExecutionContext(doc, "grp", graph, members);
    expect(ctx).toContain("execution");
    expect(ctx).toContain("blocks");
    expect(ctx).toContain("Beta");
    expect(ctx).toContain("ship docs");
  });
});


