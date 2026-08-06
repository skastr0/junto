import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import { executionGraphContextFromActorRefs } from "@shared/graph";
import type { MemberSeverity, RegionRollup } from "@shared/region-rollup";
import { deriveRegionRollups } from "@shared/region-rollup";
import { use$ } from "@legendapp/state/react";
import { agentSeat$, terminalStatusByNodeIdFromSeats } from "./agent-seat-state";
import { state$ } from "./state";
import { kernel$ } from "./kernel-view";
import { chatCoarse$ } from "./chat-state";
import { herdr$ } from "./herdr-state";
import { viewportBusy$ } from "./viewport-busy";

// Coarse poll of window.vellumCommand.regionRollups for main-process graph enrichment.
// Client always re-derives with herdr$ meta + chat activity so chips match
// HerdrCard/inspector (same status source). Live IPC never blanks herdr.

const DEBOUNCE_MS = 300;

const SEVERITY_RANK: Readonly<Record<MemberSeverity, number>> = {
  blocked: 0,
  attention: 1,
  working: 2,
  parked: 3,
  idle: 4,
};

const chatCoarseKey = (
  chat: Record<string, { status?: string; pendingPermissionId?: string; turnBusy?: boolean }>,
): string =>
  Object.entries(chat)
    .map(([key, slot]) => `${key}:${slot?.status ?? ""}:${slot?.pendingPermissionId ?? ""}:${slot?.turnBusy ? 1 : 0}`)
    .sort()
    .join("|");

const herdrCoarseKey = (
  meta: Record<string, { status?: string; meta?: { agentStatus?: string } }>,
  mirrors: Record<string, { fresh?: boolean; lastSyncAt?: number }>,
): string => {
  const metaPart = Object.entries(meta)
    .map(([id, slot]) => `${id}:${slot?.status ?? ""}:${slot?.meta?.agentStatus ?? ""}`)
    .sort()
    .join("|");
  const mirrorPart = Object.entries(mirrors)
    .map(([host, m]) => `${host}:${m?.fresh ? 1 : 0}:${m?.lastSyncAt ?? 0}`)
    .sort()
    .join("|");
  return `${metaPart}#${mirrorPart}`;
};

/**
 * Per-region, per-member: keep the worse severity between `client` (herdr/chat)
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
    const counts = { total: members.length, blocked: 0, attention: 0, working: 0 };
    for (const m of members) {
      if (m.severity === "blocked") counts.blocked += 1;
      else if (m.severity === "attention") counts.attention += 1;
      else if (m.severity === "working") counts.working += 1;
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

export function useRegionRollups(): ReadonlyArray<RegionRollup> {
  const canvasName = use$(state$.canvasName);
  const doc = use$(state$.doc);
  const actorRefs = use$(state$.actorRefs);
  const docVersion = use$(state$.docVersion);
  const docEpoch = use$(state$.docEpoch);
  const snapshots = use$(state$.snapshots);
  const executionRev = use$(kernel$.executionRev);
  // Coarse chat only — streaming tokens never reach this subscriber.
  const chat = use$(chatCoarse$) as Record<
    string,
    { status?: string; pendingPermissionId?: string; turnBusy?: boolean }
  >;
  const chatKey = chatCoarseKey(chat ?? {});
  const herdrMeta = use$(herdr$.metaByNodeId) as Record<
    string,
    { status?: string; meta?: { agentStatus?: string } }
  >;
  const herdrMirrors = use$(herdr$.mirrorByHost) as Record<string, { fresh?: boolean; lastSyncAt?: number }>;
  const herdrKey = herdrCoarseKey(herdrMeta ?? {}, herdrMirrors ?? {});

  // ACP chat plane for hermes agent nodes (keyed by agent key).
  const agentActivity = useMemo(() => {
    const m = new Map<string, { sessionLive?: boolean; permissionPending?: boolean }>();
    for (const [key, slot] of Object.entries(chat ?? {})) {
      m.set(key, {
        sessionLive: slot.status === "live" || slot.status === "connecting" || slot.turnBusy === true,
        permissionPending: slot.pendingPermissionId !== undefined,
      });
    }
    return m;
  }, [chatKey]);

  // Managed-terminal seat state (bindingId → event) for native terminal nodes.
  const seatByBinding = use$(agentSeat$.byBindingId) as Record<
    string,
    { state?: string; at?: number } | undefined
  >;
  const needsLookByBinding = use$(agentSeat$.needsLookByBindingId) as Record<
    string,
    boolean | undefined
  >;
  const seatKey = useMemo(
    () =>
      Object.entries(seatByBinding ?? {})
        .map(([id, e]) => `${id}:${e?.state ?? ""}:${e?.at ?? 0}`)
        .sort()
        .join("|"),
    [seatByBinding],
  );
  const needsLookKey = useMemo(
    () =>
      Object.entries(needsLookByBinding ?? {})
        .map(([id, value]) => `${id}:${value === true ? 1 : 0}`)
        .sort()
        .join("|"),
    [needsLookByBinding],
  );
  const terminalStatusByNodeId = useMemo(
    () =>
      terminalStatusByNodeIdFromSeats(
        doc?.nodes ?? [],
        agentSeat$.byBindingId.peek() as Record<string, AgentSeatStateEvent | undefined>,
        agentSeat$.needsLookByBindingId.peek() as Record<string, boolean | undefined>,
      ),
    // seatKey captures state changes; docVersion/docEpoch capture node binds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docVersion, docEpoch, seatKey, needsLookKey],
  );
  const vacantSeatNodeIds = useMemo(
    () =>
      new Set(
        [...terminalStatusByNodeId.entries()]
          .filter(([, activity]) => activity.session === "exited")
          .map(([nodeId]) => nodeId),
      ),
    [terminalStatusByNodeId],
  );

  // Client derive — always has herdr/chat/flags/seat; no IPC required for those.
  const client = useMemo(
    () =>
      deriveRegionRollups({
        doc,
        ...executionGraphContextFromActorRefs(canvasName, actorRefs),
        agentActivity,
        terminalStatusByNodeId,
      }),
    // docVersion/docEpoch bound doc identity; herdr/chat/seat via maps above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [actorRefs, docVersion, docEpoch, canvasName, herdrKey, agentActivity, terminalStatusByNodeId],
  );

  const [live, setLive] = useState<ReadonlyArray<RegionRollup>>([]);
  const genRef = useRef(0);

  useEffect(() => {
    if (!canvasName || !window.vellumCommand?.regionRollups) {
      setLive([]);
      return;
    }
    const api = window.vellumCommand;
    if (!api?.regionRollups) {
      setLive([]);
      return;
    }
    const gen = ++genRef.current;
    const timer = window.setTimeout(() => {
      // Apply after pan freezes so setState does not fight the compositor.
      const apply = (next: ReadonlyArray<RegionRollup>) => {
        if (gen !== genRef.current) return;
        if (viewportBusy$.peek()) {
          const off = viewportBusy$.onChange(() => {
            if (viewportBusy$.peek()) return;
            off();
            if (gen !== genRef.current) return;
            setLive(next);
          });
          return;
        }
        setLive(next);
      };
      void api
        .regionRollups(canvasName)
        .then(apply)
        .catch(() => {
          if (gen !== genRef.current) return;
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [canvasName, docEpoch, snapshots, executionRev, chatKey, herdrKey]);

  useEffect(() => {
    if (canvasName) return;
    setLive([]);
  }, [canvasName]);

  // Fuse: live can win on graph severity; client always contributes herdr/chat.
  return useMemo(
    () => fuseRegionRollups(client, live, vacantSeatNodeIds),
    [client, live, vacantSeatNodeIds],
  );
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
