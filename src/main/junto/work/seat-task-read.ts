// The open task each seat on a canvas holds, read from the task store for
// main's readers (the kernel's execution graph, the digest, the overseer's
// picture). It is the index the renderer's seat cards read (`seatTasks$`),
// built by the same `buildSeatTaskIndex` over the same views in the same
// order, so the ring and the card never drift.

import { Context, Effect } from "effect";
import type { Canvas } from "@shared/model/canvas";
import { buildSeatTaskIndex, type SeatTask } from "@shared/seat-task-index";
import { OPEN_TASK_STATES, taskNodeId, type TaskView } from "@shared/task-model";
import type { TaskPersistenceError, TaskRepository } from "./task-repository";

/** Every open task of a canvas: a seat holds at most one. */
const OPEN_TASK_LIMIT = 10_000;

/** Oldest first, as the renderer's `tasksSource().all` reads them: the first a seat holds wins. */
const byCreated = (a: TaskView, b: TaskView): number => a.createdAt - b.createdAt;

export const readSeatTaskIndex = (
  tasks: Pick<Context.Service.Shape<typeof TaskRepository>, "list">,
  canvas: Canvas,
): Effect.Effect<Record<string, SeatTask>, TaskPersistenceError> =>
  Effect.gen(function* () {
    const nodeIds = [...canvas.nodes.values()].filter((node) => node.kind === "task").map((node) => taskNodeId(node.id));
    if (nodeIds.length === 0) return {};
    const { tasks: views } = yield* tasks.list(canvas.name, { nodeIds, states: OPEN_TASK_STATES, limit: OPEN_TASK_LIMIT });
    return buildSeatTaskIndex([...views].sort(byCreated));
  });
