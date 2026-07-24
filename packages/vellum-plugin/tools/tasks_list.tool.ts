import type { ToolSource } from "prism";
import {
  TasksListInput,
  WorkCommandResult,
  type TasksListInput as TasksListInputType,
} from "../schemas/tool-schemas.ts";
import { callWork } from "./shared/work-client.ts";

export default {
  name: "tasks_list",
  description:
    "List tasks on a connected tasks sink. Pass target as the tasks node id from onboard.connected.",
  input: TasksListInput,
  output: WorkCommandResult,
  handle(input) {
    const args = input as TasksListInputType;
    return callWork("tasks.list", { target: args.target });
  },
} satisfies ToolSource;
