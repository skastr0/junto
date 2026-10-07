import { useEffect, useMemo } from "react";
import { observable, observe } from "@legendapp/state";
import type { MemberSeverity, RegionRollup } from "@shared/region-rollup";
import { agentSeat$, workSurfaceFromSeat } from "./agent-seat-state";
import { state$ } from "./state";
import { kernel$ } from "./kernel-view";
import { chatCoarse$ } from "./chat-state";
import { modelStore } from "./use-model";
import { workAttentionStore } from "./use-work-sink";
import { createRegionRollupStore } from "./region-rollup-store";
import { useRtsValue } from "./rts-selection";
import { use$ } from "@legendapp/state/react";

const DEBOUNCE_MS = 300;

const SEVERITY_RANK: Readonly<Record<MemberSeverity, number>> = {
  blocked: 0,
  attention: 1,
  working: 2,
  ready: 3,
  idle: 4,
};

const chatCoarseKey = (
  chat: Record<string, { status?: string; pendingPermissionId?: string; turnBusy?: boolean }>,
): string =>
  Object.entries(chat)
    .map(([key, slot]) => `${key}:${slot?.status ?? ""}:${slot?.pendingPermissionId ?? ""}:${slot?.turnBusy ? 1 : 0}`)
    .sort()
    .join("|");


/**
 * Per-region, per-member: keep the worse severity between `client` (seat/chat)
 * and `live` (main IPC graph). Region severity/counts recomputed.
 */
export const fuseRegionRollups = (
  client: ReadonlyArray<RegionRollup>,
  live: ReadonlyArray<RegionRollup>,
  clientAuthoritativeNodeIds: ReadonlySet<string> = new Set(),
): ReadonlyArray<RegionRollup> => {
  if (live.length === 0) return client;
  if (client.length === 0) return live;

  const liveById = new Map(live.map((r) => [r.regionId, r] as const));
  const clientById = new Map(client.map((r) => [r.regionId, r] as const));
  const ids = new Set([...liveById.keys(), ...clientById.keys()]);

  const out: RegionRollup[] = [];
  for (const id of ids) {
    const a = clientById.get(id);
    const b = liveById.get(id);
    if (!a) {
      out.push(b!);
      continue;
    }
    if (!b) {
      out.push(a);
      continue;
    }
    const bMembers = new Map(b.members.map((m) => [m.nodeId, m] as const));
    const members = a.members.map((am) => {
      const bm = bMembers.get(am.nodeId);
      if (!bm) return am;
      // A host-local lifecycle tombstone is newer and more specific than a
      // cached main rollup. Never preserve activity from its dead generation.
      if (clientAuthoritativeNodeIds.has(am.nodeId)) return am;
      // Client seat plane is live on the renderer. A quiet client seat must not
      // lose to a lagging main rollup still carrying attention/working — that
      // desync paints "needs input" / hotkeys amber while the seat is idle.
      if (
        (am.severity === "idle" || am.severity === "ready") &&
        (bm.severity === "attention" || bm.severity === "working")
      ) {
        return am;
      }
      return SEVERITY_RANK[am.severity] <= SEVERITY_RANK[bm.severity] ? am : bm;
    });
    // Members only on live (shouldn't happen often) — append.
    const aIds = new Set(a.members.map((m) => m.nodeId));
    for (const bm of b.members) {
      if (!aIds.has(bm.nodeId)) members.push(bm);
    }
    members.sort(
      (x, y) =>
        SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] ||
        x.label.localeCompare(y.label),
    );
    const counts = { total: members.length, blocked: 0, attention: 0, working: 0, ready: 0 };
    for (const m of members) {
      if (m.severity === "blocked") counts.blocked += 1;
      else if (m.severity === "attention") counts.attention += 1;
      else if (m.severity === "working") counts.working += 1;
      else if (m.severity === "ready") counts.ready += 1;
    }
    out.push({
      regionId: a.regionId,
      label: a.label || b.label,
      severity: members[0]?.severity ?? "idle",
      counts,
      members,
    });
  }
  // Preserve document order from client (cold shell order).
  const order = client.map((r) => r.regionId);
  out.sort((x, y) => {
    const ix = order.indexOf(x.regionId);
    const iy = order.indexOf(y.regionId);
    if (ix === -1 && iy === -1) return 0;
    if (ix === -1) return 1;
    if (iy === -1) return -1;
    return ix - iy;
  });
  return out;
};

const localRollups = createRegionRollupStore({
  model: modelStore,
  actorRefs: () => state$.actorRefs.get(),
  items: (canvas, id) => (workAttentionStore.state(canvas).itemsByNodeId[id].get() ?? []) as ReadonlyArray<import("@shared/work-model").Task>,
  agentActivity: key => {
    const slot = chatCoarse$[key].get();
    return {
      sessionLive: slot?.status === "live" || slot?.status === "connecting" || slot?.turnBusy === true,
      permissionPending: slot?.pendingPermissionId !== undefined,
    };
  },
  surface: binding => workSurfaceFromSeat(agentSeat$.byBindingId[binding].get(), agentSeat$.needsLookByBindingId[binding].get() === true),
});

export function useRegionRollups<T = ReadonlyArray<RegionRollup>>(
  select: (rows: ReadonlyArray<RegionRollup>) => T = rows => rows as T,
): T {
  const canvasName = use$(state$.canvasName);
  const live = useMemo(() => observable<ReadonlyArray<RegionRollup>>([]), [canvasName]);
  useEffect(() => {
    if (!canvasName) return;
    const releaseAttention = workAttentionStore.retain(canvasName);
    const releaseLocal = localRollups.retain(canvasName);
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Main still supplies permission state after reload until ChatChrome lands.
    // Keep that bridge outside React: unchanged rollups must not commit chrome.
    const stop = observe(() => {
      modelStore.canvas$(canvasName).seq.get();
      state$.snapshots.get(); kernel$.executionRev.get();
      chatCoarseKey(chatCoarse$.get());
      const current = ++generation;
      clearTimeout(timer);
      const api = typeof window === "undefined" ? undefined : window.junto;
      if (!api?.regionRollups) return;
      timer = setTimeout(() => {
        void api.regionRollups(canvasName).then(next => {
          if (current === generation && JSON.stringify(live.peek()) !== JSON.stringify(next)) live.set(next);
        }).catch(() => {});
      }, DEBOUNCE_MS);
    });
    return () => { ++generation; clearTimeout(timer); stop(); releaseLocal(); releaseAttention(); };
  }, [canvasName, live]);

  return useRtsValue(() => {
    const state = localRollups.state(canvasName);
    const client = state.regionIds.get().map(id => state.byRegionId[id].get()).filter((row): row is RegionRollup => !!row);
    const vacant = new Set<string>();
    for (const row of client) for (const member of row.members) {
      const node = modelStore.node$(canvasName, member.nodeId).peek();
      if (node?.kind === "agent" || node?.kind === "terminal") {
        if (workSurfaceFromSeat(agentSeat$.byBindingId[node.bindingId].get(), agentSeat$.needsLookByBindingId[node.bindingId].get() === true)?.session === "exited") vacant.add(node.id);
      }
    }
    return select(fuseRegionRollups(client, live.get(), vacant));
  });
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
