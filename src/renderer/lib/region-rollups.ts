import { useEffect, useRef, useState } from "react";
import type { RegionRollup } from "@shared/region-rollup";
import { use$ } from "@legendapp/state/react";
import { state$ } from "./state";
import { kernel$ } from "./kernel-view";
import { chatState$ } from "./chat-state";

// Coarse poll of window.vellum.regionRollups. Spec: poll on canvas / snapshots
// / kernel changes and chat open/close + permission request/answer — never
// raw onChatEvent per chunk (debounce ~300ms if chat is in the dep set),
// never setInterval. Unknown canvas name rejects; quiet the bar.

const DEBOUNCE_MS = 300;

const chatCoarseKey = (chat: Record<string, { status?: string; pendingPermission?: { requestId?: string } }>): string =>
  Object.entries(chat)
    .map(([key, slot]) => `${key}:${slot?.status ?? ""}:${slot?.pendingPermission?.requestId ?? ""}`)
    .sort()
    .join("|");

export function useRegionRollups(): ReadonlyArray<RegionRollup> {
  const canvasName = use$(state$.canvasName);
  const docVersion = use$(state$.docVersion);
  const snapshots = use$(state$.snapshots);
  const executionRev = use$(kernel$.executionRev);
  const chat = use$(chatState$) as Record<string, { status?: string; pendingPermission?: { requestId?: string } }>;
  const chatKey = chatCoarseKey(chat ?? {});

  const [rollups, setRollups] = useState<ReadonlyArray<RegionRollup>>([]);
  const genRef = useRef(0);

  useEffect(() => {
    if (!canvasName || !window.vellum?.regionRollups) {
      setRollups([]);
      return;
    }
    const api = window.vellum;
    if (!api?.regionRollups) {
      setRollups([]);
      return;
    }
    const gen = ++genRef.current;
    const timer = window.setTimeout(() => {
      void api
        .regionRollups(canvasName)
        .then((next) => {
          if (gen !== genRef.current) return;
          setRollups(next);
        })
        .catch(() => {
          if (gen !== genRef.current) return;
          setRollups([]);
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [canvasName, docVersion, snapshots, executionRev, chatKey]);

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
