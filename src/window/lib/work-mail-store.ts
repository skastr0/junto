import { observable } from "@legendapp/state";
import type { WorkMailChanged, WorkMailPage, WorkMailQuery } from "@shared/work-mail";

type MailApi = {
  workMailPage(query: WorkMailQuery): Promise<WorkMailPage>;
  onWorkMailChanged(listener: (event: WorkMailChanged) => void): () => void;
};
export const createWorkMailStore = (getApi: () => MailApi | undefined) => {
  const entries = new Map<string, ReturnType<typeof createEntry>>();
  let unsubscribe: (() => void) | undefined;
  const createEntry = (canvasName: string, nodeId: string) => ({
    state: observable({ items: [] as WorkMailPage["items"], nextBeforePosition: undefined as number | undefined, loading: false, error: "" }),
    canvasName, nodeId, users: 0, dirty: false,
    pages: new Map<number | undefined, WorkMailPage>(),
    flight: undefined as Promise<void> | undefined,
  });
  type Entry = ReturnType<typeof createEntry>;
  const publish = (entry: Entry) => {
    const items = new Map<string, WorkMailPage["items"][number]>();
    for (const page of entry.pages.values()) for (const item of page.items) items.set(item.message.messageId, item);
    entry.state.items.set([...items.values()].sort((a, b) => b.position - a.position));
    entry.state.nextBeforePosition.set([...entry.pages.values()].at(-1)?.nextBeforePosition);
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
          const depth = Math.max(1, entry.pages.size);
          const pages = new Map<number | undefined, WorkMailPage>();
          let beforePosition: number | undefined;
          for (let index = 0; index < depth; index += 1) {
            const page = await api.workMailPage({ canvasName: entry.canvasName, nodeId: entry.nodeId,
              ...(beforePosition === undefined ? {} : { beforePosition }) });
            pages.set(beforePosition, page);
            beforePosition = page.nextBeforePosition;
            if (beforePosition === undefined) break;
          }
          entry.pages = pages;
          publish(entry);
          entry.state.error.set("");
        }
      } catch (error) {
        entry.state.error.set(error instanceof Error ? error.message : String(error));
      } finally {
        entry.state.loading.set(false);
        entry.flight = undefined;
      }
    })();
    return entry.flight;
  };
  const entryFor = (canvasName: string, nodeId: string) => {
    const key = JSON.stringify([canvasName, nodeId]);
    let entry = entries.get(key);
    if (!entry) { entry = createEntry(canvasName, nodeId); entries.set(key, entry); }
    return entry;
  };
  return {
    state: (canvasName: string, nodeId: string) => entryFor(canvasName, nodeId).state,
    retain: (canvasName: string, nodeId: string) => {
      const entry = entryFor(canvasName, nodeId);
      entry.users += 1;
      if (!unsubscribe) unsubscribe = getApi()?.onWorkMailChanged((event) => {
        const target = entries.get(JSON.stringify([event.canvasName, event.nodeId]));
        if (target && target.users > 0) void refresh(target);
      });
      void refresh(entry);
      return () => {
        entry.users -= 1;
        if (![...entries.values()].some((value) => value.users > 0)) { unsubscribe?.(); unsubscribe = undefined; }
      };
    },
    loadMore: async (canvasName: string, nodeId: string) => {
      const entry = entryFor(canvasName, nodeId);
      if (entry.flight) await entry.flight;
      const before = entry.state.nextBeforePosition.peek();
      if (before === undefined || entry.users === 0) return;
      entry.pages.set(before, { items: [] });
      await refresh(entry);
    },
  };
};
