import { useEffect, useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import type { ActorSeatId } from "@shared/actor-seat";
import type { WorkActorQuery } from "@shared/work-sinks";
import { getJuntoApi } from "./junto-api";
import { createWorkActorStore } from "./work-actor-store";

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
