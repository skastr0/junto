import { hookEvent, type HookSource } from "prism";
import {
  callWork,
  formatOnboardSummary,
} from "../tools/shared/work-client.ts";

export default {
  name: "session-start",
  description:
    "Onboard this worker to the Vellum factory at session start (seat, connected map, reachable ops).",
  event: hookEvent.sessionStart,
  handle: async (_event) => {
    const result = await callWork("onboard", {});
    if (result.ok) {
      return {
        decision: "continue" as const,
        systemMessage: formatOnboardSummary(result.data),
      };
    }
    const err = result.error;
    const msg = err
      ? `Vellum onboard failed (${err.type}): ${err.message}`
      : "Vellum onboard failed.";
    return {
      decision: "continue" as const,
      systemMessage: msg,
    };
  },
} satisfies HookSource;
