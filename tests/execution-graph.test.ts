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
import type { ProofStamp, StampView } from "../src/shared/proof-stamps";
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

describe("evaluateEdge — authorial modes", () => {
  it("no criteria → relates", () => {
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

  it("kind-only ether is soft relates (kind is not authorial)", () => {
    const edge = { id: "e1", fromNode: "a", toNode: "b", ether: { kind: "blocks" as const } };
    const result = evaluateEdge(
      edge,
      seat("a", "sink"),
      seat("b", "actor"),
      contextFor(),
    );
    expect(result.phase).toBe("relates");
    expect(result.generates).toBe(false);
  });

  it("tasks: queues relate; claimed attention blocks only its compiled seat", () => {
    const edge = {
      id: "e1",
      fromNode: "t1",
      toNode: "b",
      ether: { stops: { mode: "tasks" as const } },
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
  });

  it("requests: pending blocks its raiser only; other and resolved relate", () => {
    const edge = {
      id: "e1",
      fromNode: "r1",
      toNode: "b",
      ether: { stops: { mode: "tasks" as const } },
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
          ether: { stops: { mode: "tasks" } },
        },
        // An actor has no task inventory, so this criteria edge relates.
        {
          id: "e2",
          fromNode: "a1",
          toNode: "a2",
          ether: { stops: { mode: "tasks" } },
        },
      ],
    };
    const graph = deriveExecutionGraph(doc, contextFor([a1, a2]));
    expect(graph.phaseByEdgeId.get("e1")).toBe("blocks");
    expect(graph.phaseByEdgeId.get("e2")).toBe("relates");
    expect(graph.blocked).toEqual(new Set(["a1"]));
    expect(graph.blocked.has("a2")).toBe(false);
  });

  it("relayState off (default) never cascades actor stoppage", () => {
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

  // relayState cascade deleted by wires law (explicitness) — no tests reasserting it.

  it("stable seat identity blocks through an alias; another seat does not", () => {
    const docFor = (items: ReadonlyArray<ReturnType<typeof taskItem>>): CanvasDoc => ({
      nodes: [
        text("t1", "Queue", { entity: { kind: "task" }, tasks: { items: [...items] } }),
        seat("a1", "actor", { label: "A1" }),
        seat("a2", "actor", { label: "A2" }),
      ],
      edges: [
        { id: "e1", fromNode: "t1", toNode: "a1", ether: { stops: { mode: "tasks" } } },
        { id: "e2", fromNode: "t1", toNode: "a2", ether: { stops: { mode: "tasks" } } },
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
    const doc: CanvasDoc = {
      nodes: [
        text("proof", "Proof", {
          entity: { kind: "artifacts" },
          artifacts: { items: [] },
        }),
        seat("s1", "sink", { label: "sink" }),
      ],
      edges: [
        {
          id: "e1",
          fromNode: "proof",
          toNode: "s1",
          ether: { stops: { mode: "proof", step: "build" } },
        },
      ],
    };
    const graph = deriveExecutionGraph(doc, contextFor());
    expect(graph.phaseByEdgeId.get("e1")).toBe("blocks");
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
          ether: { stops: { mode: "tasks" } },
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
        { id: "e1", fromNode: "t1", toNode: "note1", ether: { stops: { mode: "tasks" } } },
        { id: "e2", fromNode: "t1", toNode: "actor1", ether: { stops: { mode: "tasks" } } },
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
          ether: { stops: { mode: "tasks" } },
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

describe("evaluateEdge — proof / approval", () => {
  const sink = (id = "sink"): CanvasDoc["nodes"][number] =>
    text(id, "Artifacts", { entity: { kind: "artifacts" }, artifacts: { items: [] } });

  const stamp = (partial: Partial<ProofStamp> & Pick<ProofStamp, "step">): ProofStamp => ({
    seat: "agent-1",
    occupant: "pid:9",
    inputsHash: "h1",
    evidenceRefs: ["art-1"],
    ts: 1,
    ...partial,
  });

  it("proof missing → blocks actor; stamped → relates", () => {
    const from = sink("sink");
    const edge = {
      id: "e1",
      fromNode: "sink",
      toNode: "down",
      ether: { stops: { mode: "proof" as const, step: "build" } },
    };
    expect(
      evaluateEdge(
        edge,
        from,
        undefined,
        contextFor([], { stamps: new Map() }),
      ).phase,
    ).toBe("blocks");

    const down = actorRef("down", "1");
    const doc: CanvasDoc = {
      nodes: [from, seat("down", "actor", { label: "Downstream" })],
      edges: [edge],
    };
    expect(
      deriveExecutionGraph(
        doc,
        contextFor([down], { stamps: new Map() }),
      ).blocked.has("down"),
    ).toBe(true);

    const stamps: StampView = new Map([
      ["sink", [stamp({ step: "build", inputsHash: "h1" })]],
    ]);
    const cleared = evaluateEdge(
      { ...edge, ether: { stops: { mode: "proof", step: "build", inputsHash: "h1" } } },
      from,
      undefined,
      contextFor([], { stamps }),
    );
    expect(cleared.phase).toBe("relates");
    expect(cleared.generates).toBe(false);
  });

  it("approval holds until human grant", () => {
    const from = sink("sink");
    const edge = {
      id: "e1",
      fromNode: "sink",
      toNode: "down",
      ether: { stops: { mode: "approval" as const, step: "ship" } },
    };
    expect(evaluateEdge(edge, from, undefined, contextFor()).phase).toBe(
      "blocks",
    );
    const granted = evaluateEdge(
      edge,
      from,
      undefined,
      contextFor([], {
        approvals: new Map([
          ["ship", { step: "ship", principal: "human" as const, ts: 1 }],
        ]),
      }),
    );
    expect(granted.phase).toBe("relates");
  });
});
