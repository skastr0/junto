import { observable } from "@legendapp/state";
import type { WorkSinkChanged, WorkSinkKind, WorkSinkPage, WorkSinkQuery } from "@shared/work-sinks";

type SinkApi = {
  workSinkPage(query: WorkSinkQuery): Promise<WorkSinkPage>;
  onWorkSinkChanged(listener: (event: WorkSinkChanged) => void): () => void;
};
const emptyPage = (kind: WorkSinkKind): WorkSinkPage => kind === "pad" ? { kind } : { kind, items: [] };
const itemId = (item: Exclude<WorkSinkPage, { kind: "pad" }>["items"][number]) =>
  "id" in item ? item.id : "artifactId" in item ? item.artifactId : item.topicId;

const mergePages = (kind: WorkSinkKind, pages: ReadonlyArray<WorkSinkPage>): WorkSinkPage => {
  if (kind === "pad") return pages.at(-1) ?? emptyPage(kind);
  const rows = new Map<string, Exclude<WorkSinkPage, { kind: "pad" }>["items"][number]>();
  for (const page of pages) if (page.kind !== "pad") for (const item of page.items) rows.set(itemId(item), item);
  const tail = pages.at(-1);
  const next = tail && "nextBeforeId" in tail ? tail.nextBeforeId : undefined;
  const items = [...rows.values()].sort((a, b) => itemId(a) < itemId(b) ? 1 : itemId(a) > itemId(b) ? -1 : 0);
  // Pages are admitted under a single kind key; merging preserves that item's schema.
  return { kind, items, ...(next === undefined ? {} : { nextBeforeId: next }) } as WorkSinkPage;
};

export const createWorkSinkStore = (getApi: () => SinkApi | undefined) => {
  const entries = new Map<string, ReturnType<typeof createEntry>>();
  let unsubscribe: (() => void) | undefined;
  const createEntry = (query: Pick<WorkSinkQuery, "canvasName" | "nodeId" | "kind">) => ({
    query, users: 0, dirty: false,
    state: observable({ page: emptyPage(query.kind), loading: false, error: "" }),
    pages: new Map<string | undefined, WorkSinkPage>(),
    flight: undefined as Promise<void> | undefined,
  });
  type Entry = ReturnType<typeof createEntry>;
  const entryFor = (query: Entry["query"]) => {
    const key = JSON.stringify([query.canvasName, query.nodeId, query.kind]);
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
          const depth = Math.max(1, entry.pages.size);
          const pages = new Map<string | undefined, WorkSinkPage>();
          let beforeId: string | undefined;
          for (let index = 0; index < depth; index += 1) {
            const page = await api.workSinkPage({ ...entry.query, ...(beforeId === undefined ? {} : { beforeId }) });
            if (page.kind !== entry.query.kind) throw new Error("Work response kind differs from the requested kind");
            pages.set(beforeId, page);
            beforeId = "nextBeforeId" in page ? page.nextBeforeId : undefined;
            if (beforeId === undefined) break;
          }
          entry.pages = pages;
          entry.state.page.set(mergePages(entry.query.kind, [...entry.pages.values()]));
          entry.state.error.set("");
        }
      } catch (error) {
        entry.state.error.set(error instanceof Error ? error.message : String(error));
      } finally { entry.state.loading.set(false); entry.flight = undefined; }
    })();
    return entry.flight;
  };
  return {
    state: (query: Entry["query"]) => entryFor(query).state,
    retain: (query: Entry["query"]) => {
      const entry = entryFor(query); entry.users += 1;
      if (!unsubscribe) unsubscribe = getApi()?.onWorkSinkChanged((event) => {
        for (const target of entries.values()) if (target.users > 0 && target.query.canvasName === event.canvasName && target.query.nodeId === event.nodeId) void refresh(target);
      });
      void refresh(entry);
      return () => {
        entry.users -= 1;
        if (![...entries.values()].some((value) => value.users > 0)) { unsubscribe?.(); unsubscribe = undefined; }
      };
    },
    loadMore: async (query: Entry["query"]) => {
      const entry = entryFor(query);
      if (entry.flight) await entry.flight;
      const current = entry.state.page.peek();
      if (current.kind === "pad" || current.nextBeforeId === undefined || entry.users === 0) return;
      entry.pages.set(current.nextBeforeId, emptyPage(query.kind));
      await refresh(entry);
    },
  };
};
