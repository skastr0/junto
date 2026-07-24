import type { ToolSource } from "prism";
import { EmptyInput, WorkCommandResult } from "../schemas/tool-schemas.ts";
import { callWork } from "./shared/work-client.ts";

export default {
  name: "onboard",
  description:
    "Orient this worker on the Vellum factory floor: seat, role, connected targets, and reachable ops. Call at session start and after compaction.",
  input: EmptyInput,
  output: WorkCommandResult,
  handle() {
    return callWork("onboard", {});
  },
} satisfies ToolSource;
