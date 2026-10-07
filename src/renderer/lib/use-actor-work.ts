import { useEffect, useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import type { ActorSeatId } from "@shared/actor-seat";
import type { WorkActorQuery, WorkSinkQuery } from "@shared/work-sinks";
import { getJuntoApi } from "./junto-api";
import { createWorkActorStore } from "./work-actor-store";
import { workAttentionStore, workSinkStore } from "./use-work-sink";

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

/** Board peer pages are independently retained and observed by sink. */
export const usePeerBoards = (canvasName: string, nodeIds: ReadonlyArray<string>) => {
  const key = JSON.stringify(nodeIds);
  const queries = useMemo(() => nodeIds.map((nodeId): WorkSinkQuery => ({ canvasName, nodeId, kind: "board" })),
    // nodeIds is represented by its stable value, not its array identity.
    [canvasName, key]);
  useEffect(() => {
    if (!canvasName) return;
    const releases = queries.map((query) => workSinkStore.retain(query));
    return () => { for (const release of releases) release(); };
  }, [queries, canvasName]);
  const pages = use$(() => queries.map((query) => ({ query, ...workSinkStore.state(query).get() })));
  return {
    boards: pages.flatMap(({ query, page }) => page.kind === "board"
      ? [{ nodeId: query.nodeId, board: { topics: page.items } }] : []),
    hasMore: pages.some(({ page }) => "nextBeforeId" in page && page.nextBeforeId !== undefined),
    loading: pages.some((page) => page.loading),
    error: pages.find((page) => page.error)?.error ?? "",
    loadMore: async () => { await Promise.all(queries.map((query) => workSinkStore.loadMore(query))); },
  };
};
