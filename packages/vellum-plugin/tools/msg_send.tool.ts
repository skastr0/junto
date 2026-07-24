import type { ToolSource } from "prism";
import {
  MsgSendInput,
  WorkCommandResult,
  type MsgSendInput as MsgSendInputType,
} from "../schemas/tool-schemas.ts";
import { callWork } from "./shared/work-client.ts";

export default {
  name: "msg_send",
  description:
    "Send an agent message to a connected message target (optional taskId thread).",
  input: MsgSendInput,
  output: WorkCommandResult,
  handle(input) {
    const args = input as MsgSendInputType;
    return callWork("msg.send", {
      target: args.target,
      text: args.text,
      ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
    });
  },
} satisfies ToolSource;
