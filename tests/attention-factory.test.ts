import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  attentionOf,
  resolveCompiledActorRef,
  sinkGlance,
  type ActorRefResolver,
} from "../src/shared/attention";
import { deriveExecutionGraph } from "../src/shared/execution-graph";
import { factoryClaimTick } from "../src/shared/factory-tick";
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
  workRole?: string,
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
    ...(workRole ? { workRole } : {}),
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
          ether: { criteria: { mode: "tasks" } },
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

describe("factoryClaimTick", () => {
  it("role-matched free actor claims submitted task", () => {
    const worker = actorRef("w1", "1");
    const doc: CanvasDoc = {
      nodes: [
        tasksNode("t", [taskItem("i1", "ship", "submitted")], "builder"),
        {
          ...seat("w1", "actor", { label: "worker" }),
          ether: {
            ...seat("w1", "actor").ether,
            workRole: "builder",
          },
        },
      ],
      edges: [{ id: "e1", fromNode: "t", toNode: "w1" }],
    };
    const { doc: next, claimed } = factoryClaimTick(
      doc,
      "c",
      resolverFor([worker]),
    );
    // Claim identity is the seat, never the shared role tag.
    expect(claimed).toEqual([{ taskId: "i1", actor: worker }]);
    const task = next.nodes
      .find((n) => n.id === "t")
      ?.ether?.tasks?.items.find((t) => t.id === "i1");
    expect(task?.state).toBe("working");
    expect(task?.claimedBy).toBe(worker.seatId);
  });

  it("two seats sharing a role are distinct workers — one claim each per tick", () => {
    const withRole = (id: string) => ({
      ...seat(id, "actor"),
      ether: { ...seat(id, "actor").ether, workRole: "builder" },
    });
    const doc: CanvasDoc = {
      nodes: [
        tasksNode(
          "t",
          [taskItem("i1", "ship", "submitted"), taskItem("i2", "docs", "submitted")],
          "builder",
        ),
        withRole("w1"),
        withRole("w2"),
      ],
      edges: [
        { id: "e1", fromNode: "t", toNode: "w1" },
        { id: "e2", fromNode: "t", toNode: "w2" },
      ],
    };
    const w1 = actorRef("w1", "1");
    const w2 = actorRef("w2", "2");
    const { claimed } = factoryClaimTick(
      doc,
      "c",
      resolverFor([w1, w2]),
    );
    expect(new Set(claimed.map((claim) => claim.actor.seatId))).toEqual(
      new Set([w1.seatId, w2.seatId]),
    );
  });

  it("one executable seat gets no backlog through canvas aliases", () => {
    const withRole = (id: string) => ({
      ...seat(id, "actor"),
      ether: { ...seat(id, "actor").ether, workRole: "builder" },
    });
    const doc: CanvasDoc = {
      nodes: [
        tasksNode(
          "t",
          [
            taskItem("i1", "ship", "submitted"),
            taskItem("i2", "docs", "submitted"),
          ],
          "builder",
        ),
        withRole("w1"),
        withRole("w1-alias"),
      ],
      edges: [
        { id: "e1", fromNode: "t", toNode: "w1" },
        { id: "e2", fromNode: "t", toNode: "w1-alias" },
      ],
    };
    const primary = actorRef("w1", "1");
    const alias = actorRef("w1-alias", "1");

    const { claimed } = factoryClaimTick(
      doc,
      "c",
      resolverFor([primary, alias]),
    );

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.actor.seatId).toBe(primary.seatId);
  });

  it("does not claim when roles mismatch", () => {
    const doc: CanvasDoc = {
      nodes: [
        tasksNode("t", [taskItem("i1", "ship", "submitted")], "builder"),
        {
          ...seat("w1", "actor"),
          ether: { ...seat("w1", "actor").ether, workRole: "reviewer" },
        },
      ],
      edges: [{ id: "e1", fromNode: "t", toNode: "w1" }],
    };
    const { claimed } = factoryClaimTick(
      doc,
      "c",
      resolverFor([actorRef("w1", "1")]),
    );
    expect(claimed).toEqual([]);
  });

  it("does not claim through an unresolved or ambiguous actor reference", () => {
    const doc: CanvasDoc = {
      nodes: [
        tasksNode("t", [taskItem("i1", "ship", "submitted")]),
        seat("w1", "actor"),
      ],
      edges: [{ id: "e1", fromNode: "t", toNode: "w1" }],
    };

    expect(factoryClaimTick(doc, "c", resolverFor([])).claimed).toEqual([]);
    expect(
      factoryClaimTick(
        doc,
        "c",
        resolverFor([actorRef("w1", "1"), actorRef("w1", "2")]),
      ).claimed,
    ).toEqual([]);
  });

  it("honors seat occupancy observed outside this document", () => {
    const worker = actorRef("w1", "1");
    const doc: CanvasDoc = {
      nodes: [
        tasksNode("t", [taskItem("i1", "ship", "submitted")]),
        seat("w1", "actor"),
      ],
      edges: [{ id: "e1", fromNode: "t", toNode: "w1" }],
    };

    const result = factoryClaimTick(
      doc,
      "c",
      resolverFor([worker]),
      undefined,
      { busyActorSeatIds: new Set([worker.seatId]) },
    );

    expect(result.claimed).toEqual([]);
  });
});
