import type { A2ATask, TaskState } from "../../src/shared/canvas";

/** Minimal A2A task for tests — brief is history[0] first text line. */
export const a2aTask = (
  id: string,
  brief: string,
  state: TaskState = "submitted",
): A2ATask => ({
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
