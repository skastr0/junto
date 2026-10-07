import { observable } from "@legendapp/state";
import type { WorkAttentionQuery, WorkLaneRow, WorkSinkChanged } from "@shared/work-sinks";
import type { Task } from "@shared/work-model";
import type { WorkRead } from "@shared/work-read";

type PolicyApi = {
  workTaskPolicy(query: WorkAttentionQuery): Promise<ReadonlyArray<WorkLaneRow>>;
  onWorkSinkChanged(listener: (event: WorkSinkChanged) => void): () => void;
};
const emptyItems: ReadonlyArray<Task> = [];
export const taskPolicyRead = (rows: ReadonlyArray<WorkLaneRow>): WorkRead => {
  const byNode = new Map<string, Task[]>();
  for (const row of rows) {
    const items = byNode.get(row.nodeId) ?? [];
    items.push(row.item); byNode.set(row.nodeId, items);
  }
  return {
    itemsOf: (node) => byNode.get(node) ?? emptyItems,
    taskAt: (node, id) => byNode.get(node)?.find((item) => item.id === id),
  };
};

/** Retained by task dependency surfaces; content pages and mail are separate. */
export const createWorkTaskPolicyStore = (getApi: () => PolicyApi | undefined) => {
  const entries = new Map<string, ReturnType<typeof createEntry>>();
  let unsubscribe: (() => void) | undefined;
  const createEntry = (canvasName: string) => ({ canvasName, users: 0,
    state: observable({ rows: [] as ReadonlyArray<WorkLaneRow>, loading: false, error: "" }),
    pending: new Set<string | undefined>(), flight: undefined as Promise<void> | undefined,
  });
  type Entry = ReturnType<typeof createEntry>;
  const entryFor = (canvasName: string) => {
    let entry = entries.get(canvasName);
    if (!entry) { entry = createEntry(canvasName); entries.set(canvasName, entry); }
    return entry;
  };
  const refresh = (entry: Entry, nodeId?: string) => {
    entry.pending.add(nodeId);
    if (entry.flight) return entry.flight;
    entry.flight = (async () => {
      await Promise.resolve();
      entry.state.loading.set(true);
      try {
        while (entry.pending.size && entry.users > 0) {
          const api = getApi();
          if (!api) return;
          const targets = entry.pending.has(undefined) ? [undefined] : [...entry.pending];
          entry.pending.clear();
          for (const node of targets) {
            const rows = await api.workTaskPolicy({ canvasName: entry.canvasName, ...(node === undefined ? {} : { nodeId: node }) });
            if (entry.users === 0) continue;
            entry.state.rows.set(node === undefined ? rows : [
              ...entry.state.rows.peek().filter((row) => row.nodeId !== node), ...rows,
            ]);
          }
          entry.state.error.set("");
        }
      } catch (error) { entry.state.error.set(error instanceof Error ? error.message : String(error)); }
      finally { entry.state.loading.set(false); entry.flight = undefined; }
    })();
    return entry.flight;
  };
  return {
    state: (canvasName: string) => entryFor(canvasName).state,
    retain: (canvasName: string) => {
      const entry = entryFor(canvasName); entry.users += 1;
      if (!unsubscribe) unsubscribe = getApi()?.onWorkSinkChanged((event) => {
        const target = entries.get(event.canvasName);
        if (target && target.users > 0) void refresh(target, event.nodeId);
      });
      if (entry.users === 1) void refresh(entry);
      return () => {
        entry.users -= 1;
        if (![...entries.values()].some((target) => target.users > 0)) { unsubscribe?.(); unsubscribe = undefined; }
      };
    },
  };
};
