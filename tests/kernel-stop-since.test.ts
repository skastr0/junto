/**
 * A stop reason says when the stop began: the kernel cycle projects it from
 * the held task's `since`, so the operator's "blocked since" is the true time
 * and not when a window first saw it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { earliestStateSince } from "../src/shared/execution-graph";
import {
  __resetKernelMemoryForTest,
  __setWorldsForTest,
  getExecutionByCanvas,
  runEvaluationCycle,
} from "../src/main/junto/kernel/cycle";
import { canvasOf, seat, taskBoard, worldOf } from "./support/model-nodes";
import { heldTask } from "./support/seat-tasks";

const CANVAS = "stops";
const FIRST = "2026-08-12T12:03:00.000Z";
const LATER = "2026-08-12T12:40:00.000Z";

const canvas = canvasOf(
  [seat("atlas"), taskBoard("board", { x: 400 })],
  [],
  CANVAS,
);

describe("stop reasons carry when the stop began", () => {
  beforeEach(() => __resetKernelMemoryForTest());
  afterEach(() => __resetKernelMemoryForTest());

  it("the kernel cycle projects the held task's time onto the blocked seat", async () => {
    const held = heldTask("board", { since: Date.parse(FIRST) });
    __setWorldsForTest(new Map([[CANVAS, worldOf(canvas, {}, { atlas: held })]]));
    await runEvaluationCycle();
    const execution = getExecutionByCanvas().get(CANVAS);
    expect(execution?.blocked).toEqual(["atlas"]);
    expect(execution?.reasonsByNodeId.atlas).toEqual([
      expect.objectContaining({ kind: "task", taskNodeId: "board", taskId: held.taskId, since: Date.parse(FIRST) }),
    ]);
  });

  it("a held task with no recorded time yields a reason with no time", async () => {
    __setWorldsForTest(new Map([[CANVAS, worldOf(canvas, {}, { atlas: heldTask("board") })]]));
    await runEvaluationCycle();
    const [reason] = getExecutionByCanvas().get(CANVAS)?.reasonsByNodeId.atlas ?? [];
    expect(reason).toMatchObject({ kind: "task", taskNodeId: "board" });
    expect(reason && "since" in reason).toBe(false);
  });

  it("earliestStateSince ignores items with no readable time", () => {
    expect(earliestStateSince([{ stateSince: LATER }, {}, { stateSince: "not a date" }, { stateSince: FIRST }])).toBe(Date.parse(FIRST));
    expect(earliestStateSince([{}])).toBeUndefined();
  });
});
