import { useEffect } from "react";
import { use$ } from "@legendapp/state/react";
import { useRtsValue } from "./rts-selection";
import type { RegionRollup } from "@shared/region-rollup";
import { agentSeat$, workSurfaceFromSeat } from "./agent-seat-state";
import { state$ } from "./state";
import { createChatChromeStore, type ChatChromeApi } from "./chat-chrome-store";
import { getJuntoApi } from "./junto-api";
import { modelStore } from "./use-model";
import { workAttentionStore } from "./use-work-sink";
import { createRegionRollupStore } from "./region-rollup-store";

const emptyItems: ReadonlyArray<import("@shared/work-model").Task> = [];
export const chatChromeStore = createChatChromeStore(() => getJuntoApi() as unknown as ChatChromeApi | undefined);
export const regionRollupStore = createRegionRollupStore({
  model: modelStore,
  actorRefs: () => state$.actorRefs.get(),
  items: (canvas, id) => (workAttentionStore.state(canvas).itemsByNodeId[id].get() as typeof emptyItems | undefined) ?? emptyItems,
  agentActivity: (key) => ({ permissionPending: chatChromeStore.state.byAgentKey[key].permissionPending.get() === true }),
  surface: (bindingId) => {
    agentSeat$.byBindingId[bindingId].state.get();
    return workSurfaceFromSeat(
      agentSeat$.byBindingId[bindingId].peek(),
      agentSeat$.needsLookByBindingId[bindingId].get() === true,
    );
  },
});

export function useRegionRollups<T = ReadonlyArray<RegionRollup>>(
  select: (rows: ReadonlyArray<RegionRollup>) => T = rows => rows as T,
): T {
  const canvasName = use$(state$.canvasName);
  const state = regionRollupStore.state(canvasName);
  useEffect(() => {
    if (!canvasName) return;
    // Hydrate permissions and subscribe independently of any ChatView mount.
    const releaseChat = chatChromeStore.retain();
    const releaseAttention = workAttentionStore.retain(canvasName);
    const releaseRollups = regionRollupStore.retain(canvasName);
    return () => { releaseRollups(); releaseAttention(); releaseChat(); };
  }, [canvasName]);
  return useRtsValue(() => select(state.regionIds.get().flatMap((id) => {
    const rollup = state.byRegionId[id].get();
    return rollup ? [rollup] : [];
  })));
}

/**
 * Fully controlled hotbar: keep only assigned ids that still exist.
 * Never auto-appends regions or other nodes — empty default stays empty
 * until the operator assigns via ⌘1–9 or the slot cue.
 */
export function pruneSlotOrder(
  order: ReadonlyArray<string>,
  liveNodeIds: ReadonlyArray<string>,
): string[] {
  const live = new Set(liveNodeIds);
  return order.filter((id) => live.has(id)).slice(0, 9);
}

/** @deprecated Use pruneSlotOrder — kept name for a short migration window. */
export function mergeSlotOrder(
  order: ReadonlyArray<string>,
  liveNodeIds: ReadonlyArray<string>,
): string[] {
  return pruneSlotOrder(order, liveNodeIds);
}

/** Place `nodeId` into slot index (0–8), shifting others. Any canvas node. */
export function assignSlot(
  order: ReadonlyArray<string>,
  nodeId: string,
  slotIndex: number,
): string[] {
  const next = order.filter((id) => id !== nodeId);
  const clamped = Math.max(0, Math.min(8, slotIndex));
  next.splice(clamped, 0, nodeId);
  return next.slice(0, 9);
}

/** Remove `nodeId` from the hotbar order (unassign). */
export function clearSlot(
  order: ReadonlyArray<string>,
  nodeId: string,
): string[] {
  return order.filter((id) => id !== nodeId);
}
