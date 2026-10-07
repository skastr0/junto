import { useMemo } from "react";
import { emptySinkGlance } from "@shared/work-attention";
import { createWorkAttentionStore } from "./work-attention-store";
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

const emptyTasks: ReadonlyArray<import("@shared/work-model").Task> = [];
const emptyArtifacts: ReadonlyArray<import("@shared/work-model").Artifact> = [];
const emptyTopics: ReadonlyArray<import("@shared/work-model").BoardGlanceTopic> = [];
export const useTaskItems = (canvasName: string, nodeId: string) => {
  const sink = useWorkSink("task", canvasName, nodeId);
  return { ...sink, items: sink.page.kind === "task" ? sink.page.items : emptyTasks };
};
export const useRequestItems = (canvasName: string, nodeId: string) => {
  const sink = useWorkSink("requests", canvasName, nodeId);
  return { ...sink, items: sink.page.kind === "requests" ? sink.page.items : emptyTasks };
};
export const useArtifactItems = (canvasName: string, nodeId: string) => {
  const sink = useWorkSink("artifacts", canvasName, nodeId);
  return { ...sink, items: sink.page.kind === "artifacts" ? sink.page.items : emptyArtifacts };
};
export const useBoardTopics = (canvasName: string, nodeId: string) => {
  const sink = useWorkSink("board", canvasName, nodeId);
  return { ...sink, topics: sink.page.kind === "board" ? sink.page.items : emptyTopics };
};

export const workAttentionStore = createWorkAttentionStore(getJuntoApi);

/** Complete card attention plus compact claim rows, independent of page depth. */
export const useSinkAttention = (canvasName: string, nodeId: string, enabled = true) => {
  const state = workAttentionStore.state(canvasName);
  useEffect(() => {
    if (enabled && canvasName) return workAttentionStore.retain(canvasName);
  }, [canvasName, enabled]);
  const fallback = useMemo(() => emptySinkGlance(nodeId), [nodeId]);
  const glance = use$(state.byNodeId[nodeId]) ?? fallback;
  const items = use$(state.itemsByNodeId[nodeId]) ?? emptyTasks;
  return { ...glance, items };
};

/** The execution graph takes compact complete claim rows, never content pages. */
export const useCanvasWorkItems = (canvasName: string) => {
  const state = workAttentionStore.state(canvasName);
  useEffect(() => {
    if (canvasName) return workAttentionStore.retain(canvasName);
  }, [canvasName]);
  const items = use$(state.itemsByNodeId);
  return useMemo(() => (nodeId: string) => items[nodeId] ?? emptyTasks, [items]);
};
