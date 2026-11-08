import { useEffect, useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import { getJuntoApi } from "./junto-api";
import { createWorkMailStore } from "./work-mail-store";

export const workMailStore = createWorkMailStore(getJuntoApi);
export const useWorkMail = (canvasName: string, nodeId: string, enabled = true) => {
  const state = workMailStore.state(canvasName, nodeId);
  useEffect(() => {
    if (!enabled || !canvasName) return;
    return workMailStore.retain(canvasName, nodeId);
  }, [canvasName, nodeId, enabled]);
  const mail = use$(state);
  return { ...mail, loadMore: () => workMailStore.loadMore(canvasName, nodeId) };
};

export const useWorkspaceMail = (canvasName: string, nodeIds: ReadonlyArray<string>) => {
  const idsKey = JSON.stringify(nodeIds);
  const ids = useMemo(() => JSON.parse(idsKey) as string[], [idsKey]);
  useEffect(() => {
    if (!canvasName) return;
    const releases = ids.map((id) => workMailStore.retain(canvasName, id));
    return () => { for (const release of releases) release(); };
  }, [canvasName, ids]);
  return use$(() => Object.fromEntries(ids.map((id) => [id, workMailStore.state(canvasName, id).items.get().map((item) => item.message)])));
};
