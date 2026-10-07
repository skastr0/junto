import { observable } from "@legendapp/state";
import type { WorkActorQuery, WorkActorPage, WorkSinkChanged } from "@shared/work-sinks";

type Query = Pick<WorkActorQuery, "canvasName" | "seatId" | "kind">;
type Api = {
  workActorPage(query: WorkActorQuery): Promise<WorkActorPage>;
  onWorkSinkChanged(listener: (event: WorkSinkChanged) => void): () => void;
};
const emptyPage = (kind: Query["kind"]): WorkActorPage => ({ kind, items: [] });

/** A seat ledger retains bounded pages; scoped changes rebase its loaded depth. */
export const createWorkActorStore = (getApi: () => Api | undefined) => {
  const createEntry = (query: Query) => ({
    query, users: 0, dirty: false, depth: 1,
    state: observable({ page: emptyPage(query.kind), loading: false, error: "" }),
    flight: undefined as Promise<void> | undefined,
  });
  type Entry = ReturnType<typeof createEntry>;
  const entries = new Map<string, Entry>();
  let unsubscribe: (() => void) | undefined;
  const entryFor = (query: Query) => {
    const key = JSON.stringify([query.canvasName, query.seatId, query.kind]);
    let entry = entries.get(key);
    if (!entry) { entry = createEntry(query); entries.set(key, entry); }
    return entry;
  };
  const refresh = (entry: Entry): Promise<void> => {
    entry.dirty = true;
    if (entry.flight) return entry.flight;
    entry.flight = (async () => {
      await Promise.resolve();
      entry.state.loading.set(true);
      try {
        while (entry.dirty && entry.users > 0) {
          entry.dirty = false;
          const api = getApi();
          if (!api) return;
          const pages: WorkActorPage[] = [];
          let cursor: Pick<WorkActorQuery, "beforeId" | "beforeNodeId"> = {};
          for (let index = 0; index < entry.depth; index += 1) {
            const page = await api.workActorPage({ ...entry.query, ...cursor });
            if (page.kind !== entry.query.kind) throw new Error("Work response kind differs from the requested kind");
            pages.push(page);
            if (page.nextBeforeId === undefined) break;
            cursor = { beforeId: page.nextBeforeId, beforeNodeId: page.nextBeforeNodeId };
          }
          const tail = pages.at(-1);
          const page = {
            kind: entry.query.kind, items: pages.reduce<Array<WorkActorPage["items"][number]>>((items, page) => { items.push(...page.items); return items; }, []),
            ...(tail?.nextBeforeId === undefined ? {} : { nextBeforeId: tail.nextBeforeId, nextBeforeNodeId: tail.nextBeforeNodeId }),
          } as WorkActorPage;
          if (entry.users > 0) entry.state.page.set(page);
          entry.state.error.set("");
        }
      } catch (error) {
        entry.state.error.set(error instanceof Error ? error.message : String(error));
      } finally { entry.state.loading.set(false); entry.flight = undefined; }
    })();
    return entry.flight;
  };
  return {
    state: (query: Query) => entryFor(query).state,
    retain: (query: Query) => {
      const entry = entryFor(query); entry.users += 1;
      if (!unsubscribe) unsubscribe = getApi()?.onWorkSinkChanged((event) => {
        for (const target of entries.values())
          if (target.users > 0 && target.query.canvasName === event.canvasName) void refresh(target);
      });
      if (entry.users === 1) void refresh(entry);
      return () => {
        entry.users -= 1;
        if (![...entries.values()].some((target) => target.users > 0)) { unsubscribe?.(); unsubscribe = undefined; }
      };
    },
    loadMore: async (query: Query) => {
      const entry = entryFor(query);
      if (entry.flight) await entry.flight;
      if (entry.users === 0 || entry.state.page.peek().nextBeforeId === undefined) return;
      entry.depth += 1;
      await refresh(entry);
    },
  };
};
