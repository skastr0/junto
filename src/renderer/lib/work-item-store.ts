import { observable } from "@legendapp/state";
import type { Task } from "@shared/work-model";
import type { WorkItemQuery, WorkSinkChanged } from "@shared/work-sinks";

type Api = {
  workItem(query: WorkItemQuery): Promise<Task | undefined>;
  onWorkSinkChanged(listener: (event: WorkSinkChanged) => void): () => void;
};

/** Exact row reads for visits and selected details, refreshed only by their sink. */
export const createWorkItemStore = (getApi: () => Api | undefined) => {
  const createEntry = (query: WorkItemQuery) => ({
    query, users: 0, dirty: false,
    state: observable({ item: undefined as Task | undefined, loading: false, error: "" }),
    flight: undefined as Promise<void> | undefined,
  });
  type Entry = ReturnType<typeof createEntry>;
  const entries = new Map<string, Entry>();
  let unsubscribe: (() => void) | undefined;
  const entryFor = (query: WorkItemQuery) => {
    const key = JSON.stringify([query.canvasName, query.nodeId, query.kind, query.itemId]);
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
          const item = await api.workItem(entry.query);
          if (entry.users > 0 && JSON.stringify(entry.state.item.peek()) !== JSON.stringify(item))
            entry.state.item.set(item);
          entry.state.error.set("");
        }
      } catch (error) {
        entry.state.error.set(error instanceof Error ? error.message : String(error));
      } finally { entry.state.loading.set(false); entry.flight = undefined; }
    })();
    return entry.flight;
  };
  return {
    state: (query: WorkItemQuery) => entryFor(query).state,
    retain: (query: WorkItemQuery) => {
      const entry = entryFor(query); entry.users += 1;
      if (!unsubscribe) unsubscribe = getApi()?.onWorkSinkChanged((event) => {
        for (const target of entries.values())
          if (target.users > 0 && target.query.canvasName === event.canvasName && target.query.nodeId === event.nodeId) void refresh(target);
      });
      if (entry.users === 1) void refresh(entry);
      return () => {
        entry.users -= 1;
        if (![...entries.values()].some((target) => target.users > 0)) { unsubscribe?.(); unsubscribe = undefined; }
      };
    },
  };
};
