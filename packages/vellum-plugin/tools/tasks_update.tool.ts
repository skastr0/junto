import type { ToolSource } from "prism";
import {
  TasksUpdateInput,
  WorkCommandResult,
  type TasksUpdateInput as TasksUpdateInputType,
} from "../schemas/tool-schemas.ts";
import { callWork } from "./shared/work-client.ts";

export default {
  name: "tasks_update",
  description:
    "Transition a task state (working, input-required, completed, failed, …). Use input-required when blocked on human input.",
  input: TasksUpdateInput,
  output: WorkCommandResult,
  handle(input) {
    const args = input as TasksUpdateInputType;
    return callWork("tasks.update", {
      target: args.target,
      task: args.task,
      state: args.state,
      ...(args.note !== undefined ? { note: args.note } : {}),
    });
  },
} satisfies ToolSource;
