import type { Task } from "@shared/work-model";
import type { WorkOpResult } from "@shared/ipc";
import { runCanvasAuthoringOperation } from "./canvas-editor-flush";
import { applyWorkCanvasWrite } from "./mutations";
import { getVellumApi } from "./vellum-api";

/** Operator release: one WorkService transition atomically requeues + unclaims. */
export const releaseTaskToQueue = async (
  canvas: string,
  sinkNodeId: string,
  taskId: string,
): Promise<WorkOpResult<Task> | undefined> => {
  const api = getVellumApi();
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
