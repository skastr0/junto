import type { Task, TaskState } from "../../src/shared/canvas";

/** Minimal task for tests — brief is history[0] first text line. */
export const taskItem = (
  id: string,
  brief: string,
  state: TaskState = "submitted",
): Task => ({
  id,
  state,
  history: [
    {
      messageId: `${id}-m0`,
      role: "user",
      parts: [{ kind: "text", text: brief }],
      taskId: id,
      contextId: "test",
    },
  ],
});

/** Stamp a worker claim the way workTaskClaim does (metadata.claimedBy). */
export const claimed = (task: Task, by: string): Task => ({
  ...task,
  metadata: { ...(task.metadata ?? {}), claimedBy: by },
});
