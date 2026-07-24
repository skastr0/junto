import type { ToolSource } from "prism";
import {
  MsgListInput,
  WorkCommandResult,
  type MsgListInput as MsgListInputType,
} from "../schemas/tool-schemas.ts";
import { callWork } from "./shared/work-client.ts";

export default {
  name: "msg_list",
  description:
    "List messages on a connected message target (optionally scoped to a taskId).",
  input: MsgListInput,
  output: WorkCommandResult,
  handle(input) {
    const args = input as MsgListInputType;
    return callWork("msg.list", {
      target: args.target,
      ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
    });
  },
} satisfies ToolSource;
