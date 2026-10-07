import { describe, expect, it } from "vitest";
import { boardRemovalWarnings, removalPolicy, wireRemovalWarnings } from "../src/renderer/lib/deletion-impact";
import { taskPolicyRead } from "../src/renderer/lib/work-task-policy-store";
import { canvasOf, seat, taskBoard, wire } from "./support/model-nodes";

// What removing a wire does to tasks on their way, asked of the model canvas.

const boards = [
  taskBoard("a", { name: "Build" as never }),
  taskBoard("b", { name: "Review" as never }),
  taskBoard("c", { name: "Ship" as never }),
  seat("worker"),
];
const ab = wire("ab", "a", "b", "feeds");
const ac = wire("ac", "a", "c", "feeds");
const mail = wire("mail", "worker", "a", "contributes");
const canvas = canvasOf(boards, [ab, ac, mail]);
const noWork = taskPolicyRead([]);

describe("removing wires from the model canvas", () => {
  it("says when a board loses its last Next board, and not when one remains", () => {
    expect(wireRemovalWarnings(canvas, [ab], noWork)).toEqual([]);
    expect(wireRemovalWarnings(canvas, [ab, ac], noWork)).toEqual([
      "This removes “Build”’s last Next board, so tasks will complete here.",
    ]);
  });

  it("says nothing for a wire that carries no task path, or whose board goes too", () => {
    expect(wireRemovalWarnings(canvas, [mail], noWork)).toEqual([]);
    expect(wireRemovalWarnings(canvas, [ab, ac], noWork, new Set(["a"]))).toEqual([]);
  });

  it("says nothing of a board that holds no live task and no visit names", () => {
    expect(boardRemovalWarnings(canvas, new Set(["a", "worker"]), noWork)).toEqual([]);
    expect(boardRemovalWarnings(canvas, new Set(["worker"]), noWork)).toEqual([]);
  });

  it("reads the task policy only when a task path or a task board is going", () => {
    // No path and no board: answered at once, with nothing read.
    expect(removalPolicy("factory", canvas, new Set(), [mail])).not.toBeInstanceOf(Promise);
    expect(removalPolicy("factory", canvas, new Set(["worker"]), [])).not.toBeInstanceOf(Promise);
  });
});
