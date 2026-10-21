import { useEffect } from "react";
import { use$ } from "@legendapp/state/react";
import type { WorkSinkKind } from "@shared/work-sinks";
import { getJuntoApi } from "./junto-api";
import { createWorkSinkStore } from "./work-sink-store";

export const workSinkStore = createWorkSinkStore(getJuntoApi);
export const useWorkSink = (kind: WorkSinkKind, canvasName: string, nodeId: string, enabled = true) => {
  const state = workSinkStore.state({ kind, canvasName, nodeId });
  useEffect(() => {
    if (!enabled || !canvasName) return;
    return workSinkStore.retain({ kind, canvasName, nodeId });
  }, [kind, canvasName, nodeId, enabled]);
  return { ...use$(state), loadMore: () => workSinkStore.loadMore({ kind, canvasName, nodeId }) };
};

const emptyArtifacts: ReadonlyArray<import("@shared/work-model").Artifact> = [];
export const useArtifactItems = (canvasName: string, nodeId: string) => {
  const sink = useWorkSink("artifacts", canvasName, nodeId);
  return { ...sink, items: sink.page.kind === "artifacts" ? sink.page.items : emptyArtifacts };
};
