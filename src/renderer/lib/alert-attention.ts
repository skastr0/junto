/**
 * Wire: rising-edge alert queue → SFX + Space/` cycle → focusNodeId.
 *
 * Pure model lives in alert-queue.ts. This module collects actionable region
 * member signals, observes the queue, plays SFX on rise, and cycles focus.
 */

import { useEffect, useRef } from "react";
import type { RegionRollup } from "@shared/region-rollup";
import {
  alertId,
  cycleNext,
  emptyAlertQueue,
  observeSignals,
  resolveFocusNodeId,
  type AlertItem,
  type AlertQueue,
  type AlertSignal,
} from "./alert-queue";
import { playAlert } from "./sfx";
import { state$ } from "./state";

const TYPING_SURFACE_SELECTOR =
  "input, textarea, [contenteditable='true'], .xterm, .xterm-helper-textarea, .native-terminal-surface, .herdr-xterm, .herdr-terminal-panel, [data-terminal-surface]";

/**
 * Surfaces where Space must type, not cycle alerts.
 * Includes xterm (native + herdr display) — the helper textarea is a real
 * <textarea>, but focus can also land on .xterm chrome / host wrappers.
 * Uses duck-typed `closest` so node unit tests can stub without DOM globals.
 */
export const isTypingSurface = (target: EventTarget | null): boolean => {
  if (!target || typeof (target as { closest?: unknown }).closest !== "function") return false;
  return Boolean((target as Element).closest(TYPING_SURFACE_SELECTOR));
};

/** Pure gate for the Space/` alert cycle — exported for regression tests. */
export const shouldCycleAlertOnKey = (
  event: Pick<
    KeyboardEvent,
    "repeat" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "key" | "code" | "target"
  >,
): boolean => {
  if (event.repeat) return false;
  // Shift+Space is ordinary typing (Caps Lock + Shift for lowercase then space).
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  const isCycleKey =
    event.key === " " ||
    event.key === "Spacebar" ||
    event.code === "Space" ||
    event.key === "`" ||
    event.code === "Backquote";
  if (!isCycleKey) return false;
  if (isTypingSurface(event.target)) return false;
  return true;
};

/** Build one stable, actionable signal per non-idle region member. */
export const collectAlertSignals = (
  rollups: ReadonlyArray<RegionRollup>,
): ReadonlyArray<AlertSignal> => {
  const byId = new Map<string, AlertSignal>();

  const push = (signal: AlertSignal): void => {
    const previous = byId.get(signal.id);
    if (previous !== undefined && (previous.level ?? 0) >= (signal.level ?? 0)) return;
    byId.set(signal.id, signal);
  };

  // A node can be a member of overlapping regions. Its highest severity wins.
  for (const rollup of rollups) {
    for (const member of rollup.members) {
      const level = member.severity === "blocked" ? 2 : member.severity === "attention" ? 1 : 0;
      if (level === 0) continue;
      push({
        id: alertId.node(member.nodeId),
        kind: level === 2 ? "blocked" : "attention",
        subjectKey: member.nodeId,
        nodeId: member.nodeId,
        label: member.label,
        level,
      });
    }
  }

  return [...byId.values()];
};

let queue: AlertQueue = emptyAlertQueue();

/** Clear baseline + items (unmount / tests). Next observe re-baselines. */
export const resetAlertQueue = (): void => {
  queue = emptyAlertQueue();
};

const focusAlertItem = (item: AlertItem | undefined): void => {
  const nodeId = resolveFocusNodeId(item);
  if (!nodeId) return;
  if (!state$.doc.peek().nodes.some((n) => n.id === nodeId)) return;
  state$.selectedNodeId.set(nodeId);
  state$.selectedNodeIds.set([nodeId]);
  state$.selectedEdgeId.set("");
  state$.focusNodeId.set(nodeId);
};

/** Observe live signals; play rising-edge SFX. */
export const observeAlertSignals = (signals: ReadonlyArray<AlertSignal>): void => {
  const result = observeSignals(queue, signals);
  queue = result.queue;
  for (const item of result.risen) {
    playAlert(item.kind === "blocked" ? "blocked" : "attention");
  }
};

/** Space / backtick: next alert → focus + cycle SFX. */
export const cycleAlertFocus = (): boolean => {
  const result = cycleNext(queue);
  queue = result.queue;
  if (!result.item) return false;
  playAlert("cycle");
  focusAlertItem(result.item);
  return true;
};

/**
 * Mount in RTS chrome: subscribe live planes, observe queue, bind Space / `.
 * Rollups come from the parent (already computed for chips).
 */
export function useAlertAttention(rollups: ReadonlyArray<RegionRollup>): void {
  const rollupsRef = useRef(rollups);
  rollupsRef.current = rollups;

  useEffect(() => {
    observeAlertSignals(collectAlertSignals(rollupsRef.current));

    return () => {
      // Full unmount of RTS chrome only. Must NOT run when `rollups` identity
      // changes — parent re-creates the array every fuse and a wipe re-baselines
      // the queue so Space goes dead after the rise you just heard.
      resetAlertQueue();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rollups via ref; see comment above
  }, []);

  // Re-observe when rollups change without tearing down subscriptions/baseline.
  useEffect(() => {
    observeAlertSignals(collectAlertSignals(rollupsRef.current));
  }, [rollups]);

  // Hotkey: Space or backtick. Capture phase so Space isn't eaten by focused
  // RF nodes / RTS buttons (those match [role=button] and previously no-op'd).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!shouldCycleAlertOnKey(event)) return;
      if (queue.items.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      cycleAlertFocus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
