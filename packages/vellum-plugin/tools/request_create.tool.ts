import type { ToolSource } from "prism";
import {
  RequestCreateInput,
  WorkCommandResult,
  type RequestCreateInput as RequestCreateInputType,
} from "../schemas/tool-schemas.ts";
import { callWork } from "./shared/work-client.ts";

export default {
  name: "request_create",
  description:
    "Open a request on a connected requests sink when blocked on human input or approval. Requests generate stoppage on the worker seat.",
  input: RequestCreateInput,
  output: WorkCommandResult,
  handle(input) {
    const args = input as RequestCreateInputType;
    return callWork("request.create", {
      target: args.target,
      brief: args.brief,
      ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
    });
  },
} satisfies ToolSource;
