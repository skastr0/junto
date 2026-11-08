/**
 * The blocked mark is a seat's: a seat is blocked when a task it holds, on
 * any task node of the canvas, waits for input. It reads the seat task index
 * the seat cards read (seat-task-index.ts). Wires carry none of it, and a task
 * in review or still working blocks no one.
 */
import { describe, expect, it } from "vitest";
import type { OpenTaskState } from "../src/shared/task-model";
import { executionGraphContextFromActorRefs } from "../src/shared/graph";
import {
  deriveExecutionGraph,
  executionGraphFromSnapshot,
  type BlockedReason,
  type ExecutionGraphContext,
  type SeatTaskIndex,
} from "../src/shared/execution-graph";
import { impactCone, rankStoppageSeeds, waitingOnPath } from "../src/shared/impact";
import { actorRefFixture } from "./helpers/actor-ref-fixtures";
import { canvasOf, note, seat, taskBoard, wire } from "./support/model-nodes";
import { heldTask } from "./support/seat-tasks";

const CANVAS = "factory";

// No wire between any seat and any task node: reach, not wiring, is the law.
const canvas = canvasOf([seat("atlas"), seat("borealis", { x: 300 }), seat("cygnus", { x: 600 }), taskBoard("board", { x: 900 }), taskBoard("other", { x: 1200 }), note("memo", "memo", { x: 1500 })], [], CANVAS);

const graphOf = (heldBy: SeatTaskIndex, on = canvas) =>
  deriveExecutionGraph(on, executionGraphContextFromActorRefs(CANVAS, [actorRefFixture("atlas", CANVAS)], heldBy));

describe("a seat is blocked by the task it holds", () => {
  it("blocks the seat whose task waits for input, with no wire to its node", () => {
    const held = heldTask("board", { title: "approve delivery", since: Date.parse("2026-10-21T10:00:00.000Z") });
    const graph = graphOf({ atlas: held });
    expect([...graph.blocked]).toEqual(["atlas"]);
    expect(graph.reasonsByNodeId.get("atlas")).toEqual([
      { kind: "task", taskNodeId: "board", taskId: held.taskId, detail: "needs input - #1 approve delivery", since: Date.parse("2026-10-21T10:00:00.000Z") },
    ]);
  });

  it("a seat holding several tasks gives one reason per task waiting for input, and none for the rest", () => {
    const waiting = heldTask("board", { title: "approve delivery" });
    const later = heldTask("other", { title: "pick a board" });
    const working = heldTask("board", { state: "working", title: "ship it" });
    const graph = graphOf({ atlas: { ...waiting, tasks: [waiting, later, working] } });
    expect([...graph.blocked]).toEqual(["atlas"]);
    expect(graph.reasonsByNodeId.get("atlas")?.map((reason) => [reason.taskNodeId, reason.taskId])).toEqual([
      ["board", waiting.taskId],
      ["other", later.taskId],
    ]);
  });

  it.each<OpenTaskState>(["assigned", "working", "in-review"])("a task %s blocks no one", (state) => {
    expect(graphOf({ atlas: heldTask("board", { state }) }).blocked.size).toBe(0);
  });

  it("carries no time until the task domain records when the state began", () => {
    const [reason] = graphOf({ atlas: heldTask("board") }).reasonsByNodeId.get("atlas") ?? [];
    expect(reason && "since" in reason).toBe(false);
  });

  it("a held task keyed by a node that is not a seat on this canvas blocks no one", () => {
    expect(graphOf({ stranger: heldTask("board"), memo: heldTask("board"), board: heldTask("board") }).blocked.size).toBe(0);
  });

  it("a wire between a seat and a task node changes nothing", () => {
    const wired = canvasOf([...canvas.nodes.values()], [wire("e1", "cygnus", "board", "messages")], CANVAS);
    expect([...graphOf({ atlas: heldTask("board") }, wired).blocked]).toEqual(["atlas"]);
  });

  it("travels as a snapshot and comes back the same", () => {
    const graph = graphOf({ atlas: heldTask("board") });
    const back = executionGraphFromSnapshot({
      blocked: [...graph.blocked],
      reasonsByNodeId: Object.fromEntries(graph.reasonsByNodeId),
    });
    expect(back).toEqual(graph);
  });

  it("names only task reasons, and reads the seat task index, not work rows", () => {
    // @ts-expect-error a wire is never a reason: the edge reason is gone
    const edge: BlockedReason = { kind: "edge", edgeId: "e1", fromNodeId: "board", detail: "" };
    expect(edge.kind).toBe("edge");
    // @ts-expect-error the context holds the seat task index; legacy work rows are gone
    const legacy: ExecutionGraphContext = { canvasName: CANVAS, resolveActorRef: () => undefined, itemsOf: () => [] };
    expect(legacy.canvasName).toBe(CANVAS);
  });
});

describe("the stoppage cone is the task node and the seats it holds", () => {
  const graph = graphOf({
    atlas: heldTask("board"),
    borealis: heldTask("board"),
    cygnus: heldTask("other"),
  });

  it("from a task node: that node and its held seats, no wires", () => {
    const cone = impactCone(canvas, graph, "board");
    expect([...cone.nodeIds].sort()).toEqual(["atlas", "board", "borealis"]);
    expect(cone.edgeIds.size).toBe(0);
    expect(cone.seedReasons).toHaveLength(2);
  });

  it("from a seat: the node holding it, and that node's seats", () => {
    expect([...impactCone(canvas, graph, "atlas").nodeIds].sort()).toEqual(["atlas", "board", "borealis"]);
    expect([...impactCone(canvas, graph, "cygnus").nodeIds].sort()).toEqual(["cygnus", "other"]);
  });

  it("waiting-on walks a seat to the task node holding it", () => {
    const path = waitingOnPath(canvas, graph, "borealis");
    expect(path.hops.map((hop) => [hop.nodeId, hop.role])).toEqual([["borealis", "blocked"], ["board", "generator"]]);
  });

  it("ranks task nodes by the seats they hold", () => {
    expect(rankStoppageSeeds(canvas, graph).map((row) => [row.seedNodeId, row.seedBrief, row.stops])).toEqual([["board", "2 tasks", 3], ["other", "1 task", 2]]);
  });
});
