import { useEffect, useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import { getJuntoApi } from "./junto-api";
import { createWorkTaskPolicyStore, taskPolicyRead } from "./work-task-policy-store";

export const workTaskPolicyStore = createWorkTaskPolicyStore(getJuntoApi);
export const useCanvasTaskPolicy = (canvasName: string) => {
  const state = workTaskPolicyStore.state(canvasName);
  useEffect(() => {
    if (canvasName) return workTaskPolicyStore.retain(canvasName);
  }, [canvasName]);
  const rows = use$(state.rows);
  return useMemo(() => taskPolicyRead(rows), [rows]);
};

/** Deletion warnings read current policy at the operator's gesture. */
export const readTaskPolicy = async (canvasName: string) => {
  const api = getJuntoApi();
  if (!api) throw new Error("Junto is unavailable; task deletion consequences could not be read.");
  return taskPolicyRead(await api.workTaskPolicy({ canvasName }));
};
