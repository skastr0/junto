import { batch, observable } from "@legendapp/state";
import type { Task } from "@shared/work-model";
import type { WorkAttentionQuery, WorkSinkChanged } from "@shared/work-sinks";
import type { WorkAttentionSnapshot, WorkSinkGlance } from "@shared/work-attention";

type AttentionApi = {
  workAttention(query: WorkAttentionQuery): Promise<WorkAttentionSnapshot>;
  onWorkSinkChanged(listener: (event: WorkSinkChanged) => void): () => void;
};

/** One listener and one initial compact read per retained canvas. */
export const createWorkAttentionStore = (getApi: () => AttentionApi | undefined) => {
  const createEntry = (canvasName: string) => ({
    canvasName, users: 0,
    state: observable({
      byNodeId: {} as Record<string, WorkSinkGlance | undefined>,
      itemsByNodeId: {} as Record<string, ReadonlyArray<Task> | undefined>,
      claimItemsByNodeId: {} as Record<string, ReadonlyArray<Task> | undefined>,
      loading: false, error: "",
    }),
    pending: new Set<string | undefined>(),
    flight: undefined as Promise<void> | undefined,
  });
  type Entry = ReturnType<typeof createEntry>;
  const entries = new Map<string, Entry>();
  let unsubscribe: (() => void) | undefined;
  const entryFor = (canvasName: string) => {
    let entry = entries.get(canvasName);
    if (!entry) { entry = createEntry(canvasName); entries.set(canvasName, entry); }
    return entry;
  };
  const publish = (entry: Entry, snapshot: WorkAttentionSnapshot, nodeId?: string) => {
    const glances = new Map(snapshot.glances.map((glance) => [glance.nodeId, glance]));
    const items = new Map<string, Task[]>();
    const claims = new Map<string, Task[]>();
    for (const row of snapshot.items) {
      const lane = items.get(row.nodeId) ?? [];
      lane.push(row.item); items.set(row.nodeId, lane);
      if (row.kind === "task") {
        const held = claims.get(row.nodeId) ?? [];
        held.push(row.item); claims.set(row.nodeId, held);
      }
    }
    const keys = nodeId === undefined
      ? new Set([...Object.keys(entry.state.byNodeId.peek()), ...Object.keys(entry.state.itemsByNodeId.peek()), ...glances.keys(), ...items.keys()])
      : new Set([nodeId]);
    batch(() => {
      for (const key of keys) {
        const glance = glances.get(key);
        const previous = entry.state.byNodeId[key].peek();
        if (JSON.stringify(previous) !== JSON.stringify(glance)) entry.state.byNodeId[key].set(glance);
        const nextClaims = claims.get(key);
        if (JSON.stringify(entry.state.claimItemsByNodeId[key].peek()) !== JSON.stringify(nextClaims)) entry.state.claimItemsByNodeId[key].set(nextClaims);
        const nextItems = items.get(key);
        if (JSON.stringify(entry.state.itemsByNodeId[key].peek()) !== JSON.stringify(nextItems)) entry.state.itemsByNodeId[key].set(nextItems);
      }
    });
  };
  const refresh = (entry: Entry, nodeId?: string): Promise<void> => {
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
          for (const target of targets) {
            const snapshot = await api.workAttention({ canvasName: entry.canvasName, ...(target === undefined ? {} : { nodeId: target }) });
            if (entry.users > 0) publish(entry, snapshot, target);
          }
          entry.state.error.set("");
        }
      } catch (error) {
        entry.state.error.set(error instanceof Error ? error.message : String(error));
      } finally {
        entry.state.loading.set(false); entry.flight = undefined;
      }
    })();
    return entry.flight;
  };
  return {
    state: (canvasName: string) => entryFor(canvasName).state,
    retain: (canvasName: string) => {
      const entry = entryFor(canvasName);
      entry.users += 1;
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
