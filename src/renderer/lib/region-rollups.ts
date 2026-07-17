import { useEffect, useRef, useState } from "react";
import type { RegionRollup } from "@shared/region-rollup";
import { use$ } from "@legendapp/state/react";
import { state$ } from "./state";
import { kernel$ } from "./kernel-view";
import { chatState$ } from "./chat-state";
import { herdr$ } from "./herdr-state";

// Coarse poll of window.vellum.regionRollups. Poll on canvas / snapshots /
// kernel / chat open-close+permission / herdr meta changes. Never setInterval;
// never raw onChatEvent per chunk (chatKey is status+permission only).

const DEBOUNCE_MS = 300;

const chatCoarseKey = (chat: Record<string, { status?: string; pendingPermission?: { requestId?: string } }>): string =>
  Object.entries(chat)
    .map(([key, slot]) => `${key}:${slot?.status ?? ""}:${slot?.pendingPermission?.requestId ?? ""}`)
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

export function useRegionRollups(): ReadonlyArray<RegionRollup> {
  const canvasName = use$(state$.canvasName);
  const docEpoch = use$(state$.docEpoch);
  const snapshots = use$(state$.snapshots);
  const executionRev = use$(kernel$.executionRev);
  const chat = use$(chatState$) as Record<string, { status?: string; pendingPermission?: { requestId?: string } }>;
  const chatKey = chatCoarseKey(chat ?? {});
  const herdrMeta = use$(herdr$.metaByNodeId) as Record<string, { status?: string; meta?: { agentStatus?: string } }>;
  const herdrMirrors = use$(herdr$.mirrorByHost) as Record<string, { fresh?: boolean; lastSyncAt?: number }>;
  const herdrKey = herdrCoarseKey(herdrMeta ?? {}, herdrMirrors ?? {});

  const [rollups, setRollups] = useState<ReadonlyArray<RegionRollup>>([]);
  const genRef = useRef(0);

  useEffect(() => {
    if (!canvasName || !window.vellum?.regionRollups) return;
    const api = window.vellum;
    if (!api?.regionRollups) return;
    const gen = ++genRef.current;
    const timer = window.setTimeout(() => {
      void api
        .regionRollups(canvasName)
        .then((next) => {
          if (gen !== genRef.current) return;
          setRollups(next);
        })
        .catch(() => {
          // Transient IPC / unknown name: hold last successful payload.
          if (gen !== genRef.current) return;
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [canvasName, docEpoch, snapshots, executionRev, chatKey, herdrKey]);

  useEffect(() => {
    if (canvasName) return;
    setRollups([]);
  }, [canvasName]);

  return rollups;
}

/** Merge live region ids into a presentational 1–9 slot order. */
export function mergeSlotOrder(
  order: ReadonlyArray<string>,
  regionIds: ReadonlyArray<string>,
): string[] {
  const live = new Set(regionIds);
  const kept = order.filter((id) => live.has(id));
  const keptSet = new Set(kept);
  const appended = regionIds.filter((id) => !keptSet.has(id));
  return [...kept, ...appended].slice(0, 9);
}

/** Place `regionId` into slot index (0–8), shifting others. */
export function assignSlot(
  order: ReadonlyArray<string>,
  regionId: string,
  slotIndex: number,
): string[] {
  const next = order.filter((id) => id !== regionId);
  const clamped = Math.max(0, Math.min(8, slotIndex));
  next.splice(clamped, 0, regionId);
  return next.slice(0, 9);
}
