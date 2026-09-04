import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  attentionOf,
  resolveCompiledActorRef,
  sinkGlance,
  taskScanCounts,
  type ActorRefResolver,
} from "../src/shared/attention";
import { deriveExecutionGraph } from "../src/shared/execution-graph";
import { selectFactoryClaims } from "../src/shared/factory-tick";
import {
  ActorRef,
  type ActorRef as ActorRefValue,
} from "../src/shared/work-protocol";
import { taskItem } from "./helpers/task-fixtures";
import { seat } from "./helpers/physics-seats";

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

const ownedTask = (
  task: ReturnType<typeof taskItem>,
  actor: ActorRefValue,
) => ({
  ...task,
  claimedBy: actor.seatId,
});

const tasksNode = (
  id: string,
  items: CanvasDoc["nodes"][number]["ether"] extends infer E
    ? E extends { tasks?: { items: infer I } }
      ? I
      : never
    : never,
): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: {
    entity: { kind: "task" },
    tasks: { items: [...items] },
  },
});

describe("sinkGlance + attention", () => {
  it("splits queued / in-flight / needs-input; only working is in flight", () => {
    const actor = actorRef("worker", "1");
    const items = [
      taskItem("a", "one", "submitted"),
      ownedTask(taskItem("b", "two", "working"), actor),
      ownedTask(taskItem("c", "three", "input-required"), actor),
      taskItem("d", "four", "completed"),
    ];
    expect(sinkGlance(items)).toEqual({ queued: 1, inFlight: 1, needsInput: 1, total: 4 });
  });

  it("counts approval-gated and completed work for TaskScan", () => {
    const items = [
      taskItem("queued", "queue", "submitted"),
      taskItem("done", "done", "completed"),
      taskItem("failed", "failed", "failed"),
      { ...taskItem("gated", "gate", "submitted"), admission: "approval" as const },
    ];
    expect(taskScanCounts(items)).toEqual({ approval: 1, completed: 1 });
    // A board floor of approval gates every submitted task without an overlay.
    expect(
      taskScanCounts(
        [taskItem("floor", "f", "submitted")],
        { incoming: { admission: "approval" as const } },
      ),
    ).toEqual({ approval: 1, completed: 0 });
  });

  it("task sink fires on input-required; ice when empty", () => {
    const empty = tasksNode("t", []);
    expect(attentionOf(empty, undefined)).toBe("empty");

    const hot = tasksNode("t", [
      ownedTask(
        taskItem("i1", "x", "input-required"),
        actorRef("worker", "1"),
      ),
    ]);
    expect(attentionOf(hot, undefined)).toBe("fire");

    const calm = tasksNode("t", [taskItem("i1", "x", "submitted")]);
    expect(attentionOf(calm, undefined)).toBe("idle");
  });

  it("actor fire when phase-blocked else ice", () => {
    const actor = seat("a1", "actor");
    const actorIdentity = actorRef("a1", "1");
    const context = {
      canvasName: "c",
      resolveActorRef: resolverFor([actorIdentity]),
    };
    const graph = deriveExecutionGraph({
      nodes: [
        tasksNode("t", [
          ownedTask(
            taskItem("i1", "x", "input-required"),
            actorIdentity,
          ),
        ]),
        actor,
      ],
      edges: [
        {
          id: "e1",
          fromNode: "t",
          toNode: "a1",
          ether: { verb: "works" },
        },
      ],
    }, context);
    expect(graph.blocked.has("a1")).toBe(true);
    expect(attentionOf(actor, graph)).toBe("fire");
    expect(
      attentionOf(
        actor,
        deriveExecutionGraph({ nodes: [actor], edges: [] }, context),
      ),
    ).toBe("ice");
  });

  it("actor manual flags: attention fires, parked idles", () => {
    const flagged = (flags: ReadonlyArray<"blocker" | "parked" | "attention">) =>
      seat("a1", "actor", { flags });
    expect(attentionOf(flagged(["attention"]), undefined)).toBe("fire");
    expect(attentionOf(flagged(["parked"]), undefined)).toBe("idle");
  });

  it("compiled actor resolution fails closed on unresolved or ambiguous refs", () => {
    const actor = seat("a1", "actor");
    const exact = actorRef("a1", "1");
    expect(resolveCompiledActorRef(resolverFor([exact]), "c", actor)).toEqual(
      exact,
    );
    expect(resolveCompiledActorRef(resolverFor([]), "c", actor)).toBeUndefined();
    expect(
      resolveCompiledActorRef(
        resolverFor([exact, actorRef("a1", "2")]),
        "c",
        actor,
      ),
    ).toBeUndefined();
    expect(
      resolveCompiledActorRef(
        () => actorRef("another-node", "3"),
        "c",
        actor,
      ),
    ).toBeUndefined();
    expect(
      resolveCompiledActorRef(
        () => actorRef("sink", "4"),
        "c",
        seat("sink", "sink"),
      ),
    ).toBeUndefined();
  });
});

describe("selectFactoryClaims", () => {
  it("selects an exact sink-local task identity without mutating the projection", () => {
    const worker = actorRef("w1", "1");
    const doc: CanvasDoc = {
      nodes: [
        tasksNode("t", [taskItem("i1", "ship", "submitted")]),
        seat("w1", "actor", { label: "worker" }),
      ],
      edges: [{ id: "e1", fromNode: "t", toNode: "w1", ether: { verb: "works" } }],
    };
    const before = structuredClone(doc);
    const selected = selectFactoryClaims(
      doc,
      "c",
      resolverFor([worker]),
    );
    expect(selected).toEqual([
      {
        sink: { canvasName: "c", nodeId: "t" },
        task: {
          kind: "task",
          itemId: "i1",
          sink: { canvasName: "c", nodeId: "t" },
        },
        actor: worker,
      },
    ]);
    expect(doc).toEqual(before);
  });

  it("two edged seats are distinct workers — one claim each per tick", () => {
    const doc: CanvasDoc = {
      nodes: [
        tasksNode(
          "t",
          [taskItem("i1", "ship", "submitted"), taskItem("i2", "docs", "submitted")],
        ),
        seat("w1", "actor"),
        seat("w2", "actor"),
      ],
      edges: [
        { id: "e1", fromNode: "t", toNode: "w1", ether: { verb: "works" } },
        { id: "e2", fromNode: "t", toNode: "w2", ether: { verb: "works" } },
      ],
    };
    const w1 = actorRef("w1", "1");
    const w2 = actorRef("w2", "2");
    const selected = selectFactoryClaims(
      doc,
      "c",
      resolverFor([w1, w2]),
    );
    expect(new Set(selected.map((claim) => claim.actor.seatId))).toEqual(
      new Set([w1.seatId, w2.seatId]),
    );
  });

  it("skips submitted tasks with unsatisfied dependsOn", () => {
    const worker = actorRef("w1", "1");
    const blocked = {
      ...taskItem("i2", "after", "submitted"),
      dependsOn: ["i1"],
    };
    const doc: CanvasDoc = {
      nodes: [
        tasksNode(
          "t",
          [taskItem("i1", "first", "submitted"), blocked],
        ),
        seat("w1", "actor", { label: "worker" }),
      ],
      edges: [{ id: "e1", fromNode: "t", toNode: "w1", ether: { verb: "works" } }],
    };
    const selected = selectFactoryClaims(doc, "c", resolverFor([worker]));
    expect(selected.map((claim) => claim.task.itemId)).toEqual(["i1"]);

    const unlocked: CanvasDoc = {
      nodes: [
        tasksNode(
          "t",
          [
            { ...taskItem("i1", "first", "submitted"), state: "completed" },
            blocked,
          ],
        ),
        seat("w1", "actor", { label: "worker" }),
      ],
      edges: [{ id: "e1", fromNode: "t", toNode: "w1", ether: { verb: "works" } }],
    };
    const after = selectFactoryClaims(unlocked, "c", resolverFor([worker]));
    expect(after.map((claim) => claim.task.itemId)).toEqual(["i2"]);
  });

  it("keeps identical task IDs distinct by exact sink and selects deterministically", () => {
    const actorA = actorRef("actor-a", "1");
    const actorB = actorRef("actor-b", "2");
    const doc: CanvasDoc = {
      nodes: [
        tasksNode("sink-b", [taskItem("same-id", "second", "submitted")]),
        seat("actor-b", "actor"),
        tasksNode("sink-a", [taskItem("same-id", "first", "submitted")]),
        seat("actor-a", "actor"),
      ],
      edges: [
        { id: "edge-b", fromNode: "sink-b", toNode: "actor-b", ether: { verb: "works" } },
        { id: "edge-a", fromNode: "sink-a", toNode: "actor-a", ether: { verb: "works" } },
      ],
    };

    expect(
      selectFactoryClaims(doc, "c", resolverFor([actorA, actorB])),
    ).toEqual([
      {
        sink: { canvasName: "c", nodeId: "sink-a" },
        task: {
          kind: "task",
          itemId: "same-id",
          sink: { canvasName: "c", nodeId: "sink-a" },
        },
        actor: actorA,
      },
      {
        sink: { canvasName: "c", nodeId: "sink-b" },
        task: {
          kind: "task",
          itemId: "same-id",
          sink: { canvasName: "c", nodeId: "sink-b" },
        },
        actor: actorB,
      },
    ]);
  });

  it("fails closed on a duplicate task identity inside one sink", () => {
    const actor = actorRef("actor", "1");
    const doc: CanvasDoc = {
      nodes: [
        tasksNode("sink", [
          taskItem("duplicate", "first", "submitted"),
          taskItem("duplicate", "second", "submitted"),
        ]),
        seat("actor", "actor"),
      ],
      edges: [{ id: "edge", fromNode: "sink", toNode: "actor", ether: { verb: "works" } }],
    };

    expect(selectFactoryClaims(doc, "c", resolverFor([actor]))).toEqual([]);
  });

  // Holding `tasks.claim` is not the same as being in the labor pool: the
  // lower-id seat contributes — it may claim of its own accord — and the tick
  // still walks past it to the one that works the sink.
  it("skips a lower-id contributing actor for the one that works the sink", () => {
    const denied = actorRef("a-denied", "1");
    const admitted = actorRef("z-admitted", "2");
    const doc: CanvasDoc = {
      nodes: [
        tasksNode("t", [taskItem("i1", "ship", "submitted")]),
        seat("a-denied", "actor"),
        seat("z-admitted", "actor"),
      ],
      edges: [
        {
          id: "e-denied",
          fromNode: "a-denied",
          toNode: "t",
          ether: { verb: "contributes" },
        },
        {
          id: "e-admitted",
          fromNode: "t",
          toNode: "z-admitted",
          ether: { verb: "works" },
        },
      ],
    };

    const selected = selectFactoryClaims(
      doc,
      "c",
      resolverFor([denied, admitted]),
    );

    expect(selected).toEqual([
      {
        sink: { canvasName: "c", nodeId: "t" },
        task: {
          kind: "task",
          itemId: "i1",
          sink: { canvasName: "c", nodeId: "t" },
        },
        actor: admitted,
      },
    ]);
  });

  it("one executable seat gets no backlog through canvas aliases", () => {
    const doc: CanvasDoc = {
      nodes: [
        tasksNode(
          "t",
          [
            taskItem("i1", "ship", "submitted"),
            taskItem("i2", "docs", "submitted"),
          ],
        ),
        seat("w1", "actor"),
        seat("w1-alias", "actor"),
      ],
      edges: [
        { id: "e1", fromNode: "t", toNode: "w1", ether: { verb: "works" } },
        { id: "e2", fromNode: "t", toNode: "w1-alias", ether: { verb: "works" } },
      ],
    };
    const primary = actorRef("w1", "1");
    const alias = actorRef("w1-alias", "1");

    const selected = selectFactoryClaims(
      doc,
      "c",
      resolverFor([primary, alias]),
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]?.actor.seatId).toBe(primary.seatId);
  });

  it("does not claim through an unresolved or ambiguous actor reference", () => {
    const doc: CanvasDoc = {
      nodes: [
        tasksNode("t", [taskItem("i1", "ship", "submitted")]),
        seat("w1", "actor"),
      ],
      edges: [{ id: "e1", fromNode: "t", toNode: "w1", ether: { verb: "works" } }],
    };

    expect(selectFactoryClaims(doc, "c", resolverFor([]))).toEqual([]);
    expect(
      selectFactoryClaims(
        doc,
        "c",
        resolverFor([actorRef("w1", "1"), actorRef("w1", "2")]),
      ),
    ).toEqual([]);
  });

  it("honors seat occupancy observed outside this document", () => {
    const worker = actorRef("w1", "1");
    const doc: CanvasDoc = {
      nodes: [
        tasksNode("t", [taskItem("i1", "ship", "submitted")]),
        seat("w1", "actor"),
      ],
      edges: [{ id: "e1", fromNode: "t", toNode: "w1", ether: { verb: "works" } }],
    };

    const result = selectFactoryClaims(
      doc,
      "c",
      resolverFor([worker]),
      { busyActorSeatIds: new Set([worker.seatId]) },
    );

    expect(result).toEqual([]);
  });
});
