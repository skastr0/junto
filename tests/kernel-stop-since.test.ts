/**
 * A stop reason says when the stop began: the kernel cycle projects it from
 * the work items' stateSince, so the operator's "blocked since" is the true
 * time and not when a window first saw it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Task } from "../src/shared/work-model";
import { executionGraphContextFromActorRefs } from "../src/shared/graph";
import { deriveExecutionGraph, earliestStateSince } from "../src/shared/execution-graph";
import {
  __resetKernelMemoryForTest,
  __setWorldsForTest,
  getExecutionByCanvas,
  runEvaluationCycle,
  setActorRefResolver,
} from "../src/main/junto/kernel/cycle";
import { actorRefFixture } from "./helpers/actor-ref-fixtures";
import { canvasOf, seat, taskBoard, wire, worldOf } from "./support/model-nodes";

const CANVAS = "stops";
const FIRST = "2026-08-12T12:03:00.000Z";
const LATER = "2026-08-12T12:40:00.000Z";
const seatId = actorRefFixture("atlas", CANVAS).seatId;

const waiting = (id: string, stateSince?: string): Task => ({
  id,
  state: "input-required",
  claimedBy: seatId,
  history: [],
  ...(stateSince === undefined ? {} : { stateSince }),
});

const canvas = canvasOf(
  [seat("atlas"), taskBoard("board", { x: 400 })],
  [wire("e1", "atlas", "board", "contributes")],
  CANVAS,
);
const context = (items: ReadonlyArray<Task>) =>
  executionGraphContextFromActorRefs(CANVAS, [actorRefFixture("atlas", CANVAS)], (nodeId) =>
    nodeId === "board" ? items : [],
  );

describe("stop reasons carry when the stop began", () => {
  beforeEach(() => __resetKernelMemoryForTest());
  afterEach(() => __resetKernelMemoryForTest());

  it("the kernel cycle projects the earliest waiting item's time onto the blocked seat", async () => {
    const items = [waiting("t-later", LATER), waiting("t-first", FIRST)];
    setActorRefResolver(context(items).resolveActorRef);
    __setWorldsForTest(new Map([[CANVAS, worldOf(canvas, { tasks: new Map([["board", items]]) })]]));
    await runEvaluationCycle();
    const execution = getExecutionByCanvas().get(CANVAS);
    expect(execution?.blocked).toEqual(["atlas"]);
    expect(execution?.reasonsByNodeId.atlas).toEqual([
      expect.objectContaining({ kind: "edge", edgeId: "e1", fromNodeId: "board", since: Date.parse(FIRST) }),
    ]);
  });

  it("a waiting item with no recorded time yields a reason with no time", () => {
    const graph = deriveExecutionGraph(canvas, context([waiting("t-unstamped")]));
    const [reason] = graph.reasonsByNodeId.get("atlas") ?? [];
    expect(reason).toMatchObject({ kind: "edge", edgeId: "e1" });
    expect(reason && "since" in reason).toBe(false);
  });

  it("earliestStateSince ignores items with no readable time", () => {
    expect(earliestStateSince([{ stateSince: LATER }, {}, { stateSince: "not a date" }, { stateSince: FIRST }])).toBe(Date.parse(FIRST));
    expect(earliestStateSince([{}])).toBeUndefined();
  });
});
