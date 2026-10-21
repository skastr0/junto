/**
 * Main reads the open task each seat holds from the task store, and builds the
 * index the renderer's seat cards build, over the same views in the same order.
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/model";
import { mintItemId } from "../src/shared/resource-command";
import { OPEN_TASK_STATES, seatNodeId, taskNodeId, type TaskState, type TaskView } from "../src/shared/task-model";
import type { TaskListQuery } from "../src/main/junto/work/task-repository";
import { readSeatTaskIndex } from "../src/main/junto/work/seat-task-read";
import { canvasOf, note, seat, taskBoard } from "./support/model-nodes";

const ada = seatNodeId(asNodeId("ada"));

const view = (title: string, state: TaskState, createdAt: number): TaskView =>
  ({
    taskId: mintItemId(),
    title,
    current: { state, node: taskNodeId(asNodeId("board")), assignee: ada, epoch: 0, reviewers: [], stamps: [] },
    layers: [],
    dependsOn: [],
    createdAt,
    updatedAt: createdAt,
  }) as unknown as TaskView;

const storeOf = (views: ReadonlyArray<TaskView>) => {
  const queries: TaskListQuery[] = [];
  return {
    queries,
    tasks: {
      list: (_canvas: string, query: TaskListQuery) => {
        queries.push(query);
        return Effect.succeed({ tasks: views, more: false });
      },
    },
  };
};

describe("main's read of the task each seat holds", () => {
  it("asks for the open tasks of the canvas's task nodes, and the first created wins", async () => {
    // Newest change first, as the store lists them; the index reads oldest first.
    const store = storeOf([view("later", "input-required", 20), view("first", "working", 10)]);
    const index = await Effect.runPromise(readSeatTaskIndex(store.tasks, canvasOf([seat("ada"), taskBoard("board"), note("memo", "memo")])));
    expect(store.queries).toEqual([{ nodeIds: ["board"], states: OPEN_TASK_STATES, limit: 10_000 }]);
    expect(index.ada).toMatchObject({ title: "first", state: "working", blocked: false });
  });

  it("does not read the store for a canvas with no task node", async () => {
    const store = storeOf([]);
    expect(await Effect.runPromise(readSeatTaskIndex(store.tasks, canvasOf([seat("ada")])))).toEqual({});
    expect(store.queries).toEqual([]);
  });
});
