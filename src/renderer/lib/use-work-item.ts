import { useEffect, useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import type { WorkItemQuery } from "@shared/work-sinks";
import { getJuntoApi } from "./junto-api";
import { createWorkItemStore } from "./work-item-store";

export const workItemStore = createWorkItemStore(getJuntoApi);

export const useWorkItems = (inputs: ReadonlyArray<WorkItemQuery>) => {
  const key = JSON.stringify(inputs);
  const queries = useMemo(() => inputs, [key]);
  useEffect(() => {
    const releases = queries.filter((query) => query.canvasName).map((query) => workItemStore.retain(query));
    return () => { for (const release of releases) release(); };
  }, [queries]);
  return use$(() => queries.map((query) => ({ query, ...workItemStore.state(query).get() })));
};
