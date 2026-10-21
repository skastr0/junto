import { useEffect, useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import type { ActorSeatId } from "@shared/actor-seat";
import type { WorkActorQuery } from "@shared/work-sinks";
import { getJuntoApi } from "./junto-api";
import { createWorkActorStore } from "./work-actor-store";
import { workAttentionStore } from "./use-work-sink";

export const workActorStore = createWorkActorStore(getJuntoApi);

export const useActorPage = (
  kind: WorkActorQuery["kind"], canvasName: string, seatId: ActorSeatId | undefined,
) => {
  const query = useMemo(() => ({ kind, canvasName, seatId: seatId ?? "" as ActorSeatId }), [kind, canvasName, seatId]);
  const state = workActorStore.state(query);
  useEffect(() => {
    if (canvasName && seatId) return workActorStore.retain(query);
  }, [query, canvasName, seatId]);
  return { ...use$(state), loadMore: () => workActorStore.loadMore(query) };
};

export const useAttentionRows = (canvasName: string) => {
  const state = workAttentionStore.state(canvasName);
  useEffect(() => {
    if (canvasName) return workAttentionStore.retain(canvasName);
  }, [canvasName]);
  const items = use$(state.claimItemsByNodeId);
  return useMemo(() => Object.entries(items).flatMap(([nodeId, tasks]) =>
    (tasks ?? []).map((item) => ({ nodeId, item }))), [items]);
};
