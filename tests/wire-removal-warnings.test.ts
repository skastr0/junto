import { describe, expect, it } from "vitest";
import { boardRemovalWarnings, openTasksOf, removalTasks, seatRemovalWarnings, wireRemovalWarnings } from "../src/renderer/lib/deletion-impact";
import { canvasOf, seat, taskBoard, wire } from "./support/model-nodes";
import { taskView } from "./support/seat-tasks";

// What removing a wire does to tasks on their way, asked of the model canvas.

const boards = [
  taskBoard("a", { name: "Build" as never }),
  taskBoard("b", { name: "Review" as never }),
  taskBoard("c", { name: "Ship" as never }),
  seat("worker"),
];
const ab = wire("ab", "a", "b", "flows");
const ac = wire("ac", "a", "c", "flows");
const mail = wire("mail", "worker", "a", "messages");
const canvas = canvasOf(boards, [ab, ac, mail]);
const noWork = openTasksOf([]);

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

  it("counts the open tasks a removed board holds, and the closed ones not at all", () => {
    const tasksOf = openTasksOf([
      taskView("a", { current: { state: "working" } }),
      taskView("a", { current: { state: "in-review" } }),
      taskView("a", { current: { state: "done" } }),
      taskView("b", { current: { state: "canceled" } }),
    ]);
    expect(boardRemovalWarnings(canvas, new Set(["a"]), tasksOf)).toEqual(["“Build” holds 2 live tasks."]);
    expect(boardRemovalWarnings(canvas, new Set(["b"]), tasksOf)).toEqual([]);
  });

  it("says which open tasks on the earlier board lose a Next board", () => {
    const tasksOf = openTasksOf([taskView("a", { current: { state: "backlog" } }), taskView("b", { current: { state: "working" } })]);
    expect(wireRemovalWarnings(canvas, [ab], tasksOf)).toEqual([
      "“Build” has 1 live task that will lose “Review” as its Next board.",
    ]);
  });

  it("says nothing of a board that holds no live task", () => {
    expect(boardRemovalWarnings(canvas, new Set(["a", "worker"]), noWork)).toEqual([]);
    expect(boardRemovalWarnings(canvas, new Set(["worker"]), noWork)).toEqual([]);
  });

  it("reads the tasks only when a task path, a task board or a seat is going", () => {
    // No path, no board and no seat: answered at once, with nothing read.
    expect(removalTasks("factory", canvas, new Set(), [mail])).not.toBeInstanceOf(Promise);
    expect(removalTasks("factory", canvas, new Set(["worker"]), [])).toBeInstanceOf(Promise);
  });

  it("names the open tasks a removed seat holds, which go back to the backlog", () => {
    const tasksOf = openTasksOf([
      { ...taskView("a", { title: "fix tabs", current: { state: "working", assignee: "worker" as never } }), number: 42 as never },
      taskView("b", { title: "old", current: { state: "done", assignee: "worker" as never } }),
    ]);
    expect(seatRemovalWarnings(canvas, new Set(["worker"]), tasksOf)).toEqual([
      "“worker” holds #42 fix tabs; it goes back to the backlog.",
    ]);
    // The board goes too: its own warning counts the task.
    expect(seatRemovalWarnings(canvas, new Set(["worker", "a"]), tasksOf)).toEqual([]);
    expect(seatRemovalWarnings(canvas, new Set(["b"]), tasksOf)).toEqual([]);
  });

  it("lists three or more held tasks with commas, and the last after and", () => {
    const held = (title: string) => taskView("a", { title, current: { state: "working", assignee: "worker" as never } });
    expect(seatRemovalWarnings(canvas, new Set(["worker"]), openTasksOf([held("one"), held("two"), held("three")]))).toEqual([
      "“worker” holds one, two and three; they go back to the backlog.",
    ]);
  });
});
