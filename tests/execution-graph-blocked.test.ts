/**
 * The blocked mark is a seat's: a seat is blocked when it is the assignee of a
 * task waiting for input, on any task node of the canvas. Wires carry none of
 * it, and a task in review or still working blocks no one.
 */
import { describe, expect, it } from "vitest";
import type { Task, TaskState } from "../src/shared/work-model";
import { executionGraphContextFromActorRefs } from "../src/shared/graph";
import { deriveExecutionGraph, executionGraphFromSnapshot, type BlockedReason } from "../src/shared/execution-graph";
import { impactCone, rankStoppageSeeds, waitingOnPath } from "../src/shared/impact";
import { actorRefFixture } from "./helpers/actor-ref-fixtures";
import { canvasOf, seat, taskBoard, wire } from "./support/model-nodes";

const CANVAS = "factory";
const atlas = actorRefFixture("atlas", CANVAS).seatId;
const borealis = actorRefFixture("borealis", CANVAS).seatId;

const task = (id: string, state: TaskState, claimedBy?: typeof atlas, stateSince?: string): Task => ({
  id,
  state,
  history: [],
  ...(claimedBy === undefined ? {} : { claimedBy }),
  ...(stateSince === undefined ? {} : { stateSince }),
});

// No wire between any seat and any task node: reach, not wiring, is the law.
const canvas = canvasOf([seat("atlas"), seat("borealis", { x: 300 }), seat("cygnus", { x: 600 }), taskBoard("board", { x: 900 }), taskBoard("other", { x: 1200 })], [], CANVAS);

const graphOf = (byNode: Readonly<Record<string, ReadonlyArray<Task>>>) =>
  deriveExecutionGraph(
    canvas,
    executionGraphContextFromActorRefs(
      CANVAS,
      [actorRefFixture("atlas", CANVAS), actorRefFixture("borealis", CANVAS), actorRefFixture("cygnus", CANVAS)],
      (nodeId) => byNode[nodeId] ?? [],
    ),
  );

describe("a seat is blocked by the task it is the assignee of", () => {
  it("blocks the assignee of a task waiting for input, with no wire to its node", () => {
    const graph = graphOf({ board: [task("t1", "input-required", atlas, "2026-10-21T10:00:00.000Z")] });
    expect([...graph.blocked]).toEqual(["atlas"]);
    expect(graph.reasonsByNodeId.get("atlas")).toEqual([
      { kind: "task", taskNodeId: "board", taskId: "t1", detail: "needs input - t1", since: Date.parse("2026-10-21T10:00:00.000Z") },
    ]);
  });

  it.each<TaskState>(["submitted", "working", "completed", "canceled"])("a task in %s blocks no one", (state) => {
    expect(graphOf({ board: [task("t1", state, atlas)] }).blocked.size).toBe(0);
  });

  it("an unassigned task, or one whose assignee is not a seat here, blocks no one", () => {
    const stranger = actorRefFixture("stranger", "elsewhere").seatId;
    const graph = graphOf({ board: [task("t1", "input-required"), task("t2", "input-required", stranger)] });
    expect(graph.blocked.size).toBe(0);
  });

  it("collects every waiting task a seat holds, across task nodes", () => {
    const graph = graphOf({
      board: [task("t1", "input-required", atlas), task("t2", "input-required", borealis)],
      other: [task("t3", "input-required", atlas)],
    });
    expect([...graph.blocked].sort()).toEqual(["atlas", "borealis"]);
    expect(graph.reasonsByNodeId.get("atlas")?.map((reason) => reason.taskId)).toEqual(["t1", "t3"]);
  });

  it("a wire between a seat and a task node changes nothing", () => {
    const wired = canvasOf([...canvas.nodes.values()], [wire("e1", "cygnus", "board", "contributes")], CANVAS);
    const graph = deriveExecutionGraph(
      wired,
      executionGraphContextFromActorRefs(CANVAS, [actorRefFixture("atlas", CANVAS), actorRefFixture("cygnus", CANVAS)], (nodeId) =>
        nodeId === "board" ? [task("t1", "input-required", atlas)] : [],
      ),
    );
    expect([...graph.blocked]).toEqual(["atlas"]);
  });

  it("travels as a snapshot and comes back the same", () => {
    const graph = graphOf({ board: [task("t1", "input-required", atlas)] });
    const back = executionGraphFromSnapshot({
      blocked: [...graph.blocked],
      reasonsByNodeId: Object.fromEntries(graph.reasonsByNodeId),
    });
    expect(back).toEqual(graph);
  });

  it("names only task reasons", () => {
    // @ts-expect-error a wire is never a reason: the edge reason is gone
    const edge: BlockedReason = { kind: "edge", edgeId: "e1", fromNodeId: "board", detail: "" };
    expect(edge.kind).toBe("edge");
  });
});

describe("the stoppage cone is the task node and the seats it holds", () => {
  const graph = graphOf({
    board: [task("t1", "input-required", atlas), task("t2", "input-required", borealis)],
    other: [task("t3", "input-required", atlas)],
  });

  it("from a task node: that node and its held seats, no wires", () => {
    const cone = impactCone(canvas, graph, "board");
    expect([...cone.nodeIds].sort()).toEqual(["atlas", "board", "borealis"]);
    expect(cone.edgeIds.size).toBe(0);
    expect(cone.seedReasons.map((reason) => reason.taskId)).toEqual(["t1", "t2"]);
  });

  it("from a seat: every node holding it, and their seats", () => {
    expect([...impactCone(canvas, graph, "atlas").nodeIds].sort()).toEqual(["atlas", "board", "borealis", "other"]);
    expect(impactCone(canvas, graph, "cygnus").nodeIds.size).toBe(0);
  });

  it("waiting-on walks a seat to the task node holding it", () => {
    const path = waitingOnPath(canvas, graph, "borealis");
    expect(path.hops.map((hop) => [hop.nodeId, hop.role])).toEqual([["borealis", "blocked"], ["board", "generator"]]);
  });

  it("ranks task nodes by the seats they hold", () => {
    const ranked = rankStoppageSeeds(canvas, graph, (nodeId) =>
      nodeId === "board" ? [task("t1", "input-required", atlas), task("t2", "input-required", borealis)] : nodeId === "other" ? [task("t3", "input-required", atlas)] : [],
    );
    expect(ranked.map((row) => [row.seedNodeId, row.seedBrief, row.stops])).toEqual([["board", "2 tasks", 3], ["other", "1 task", 2]]);
  });
});
