import { TASKS_ENABLED } from "@shared/features";
import type { Task } from "@shared/work-model";
import type { WorkOpResult } from "@shared/ipc";
import { runCanvasAuthoringOperation } from "./canvas-editor-flush";
import { applyWorkCanvasWrite } from "./mutations";
import { getVellumCommandApi } from "./vellum-api";

/** Operator release: one WorkService transition atomically requeues + unclaims. */
export const releaseTaskToQueue = async (
  canvas: string,
  sinkNodeId: string,
  taskId: string,
): Promise<WorkOpResult<Task> | undefined> => {
  // The tasks surface is gated: refuse here so no caller can reach a missing
  // preload API or a work op this build does not serve.
  if (!TASKS_ENABLED) {
    return {
      ok: false,
      code: "invalid",
      message: "Tasks are disabled in this build.",
    };
  }
  const api = getVellumCommandApi();
  if (!api) {
    return {
      ok: false,
      code: "invalid",
      message: "Work service is unavailable.",
    };
  }
  return runCanvasAuthoringOperation(async () => {
    const result = await api.workTaskTransition(
      canvas,
      sinkNodeId,
      taskId,
      "submitted",
    );
    if (result.ok) applyWorkCanvasWrite(canvas, result.doc, result.revision);
    return result;
  });
};
