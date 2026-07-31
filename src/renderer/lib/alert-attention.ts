/**
 * Wire: rising-edge alert queue → SFX + Space/` cycle → focusNodeId.
 *
 * Pure model lives in alert-queue.ts. This module collects live signals from
 * region rollups, chat permissions, and herdr done; observes the queue; plays
 * playAlert on rise; and cycles focus.
 */

import { useEffect, useRef } from "react";
import type { CanvasDoc } from "@shared/canvas";
import type { SnapshotState } from "@shared/entities";
import type { RegionRollup } from "@shared/region-rollup";
import {
  alertId,
  cycleNext,
  emptyAlertQueue,
  observeSignals,
  regionIdFromOrphanKey,
  resolveFocusNodeId,
  type AlertItem,
  type AlertQueue,
  type AlertSignal,
} from "./alert-queue";
import { chatCoarse$ } from "./chat-state";
import { herdr$ } from "./herdr-state";
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

const agentNodeId = (doc: CanvasDoc, agentKey: string): string | undefined => {
  for (const node of doc.nodes) {
    if (node.ether?.entity?.kind === "agent" && node.ether.entity.name === agentKey) {
      return node.id;
    }
  }
  return undefined;
};

const nodeExists = (doc: CanvasDoc, nodeId: string | undefined): string | undefined => {
  if (!nodeId) return undefined;
  return doc.nodes.some((n) => n.id === nodeId) ? nodeId : undefined;
};

/** Build the current signal set from live planes (pure given inputs). */
export const collectAlertSignals = (input: {
  readonly doc: CanvasDoc;
  readonly rollups: ReadonlyArray<RegionRollup>;
  readonly chat: Record<string, { pendingPermissionId?: string; pendingPermission?: { requestId?: string } } | undefined>;
  readonly herdrMeta: Record<string, { meta?: { agentStatus?: string } } | undefined>;
  readonly snapshots: SnapshotState;
  readonly orphans: ReadonlyArray<string>;
}): ReadonlyArray<AlertSignal> => {
  const { doc, rollups, chat, herdrMeta, snapshots, orphans } = input;
  const out: AlertSignal[] = [];
  const seen = new Set<string>();

  const push = (signal: AlertSignal): void => {
    if (seen.has(signal.id)) return;
    seen.add(signal.id);
    out.push(signal);
  };

  // blocked: region member severity becomes blocked
  for (const rollup of rollups) {
    for (const member of rollup.members) {
      if (member.severity !== "blocked") continue;
      push({
        id: alertId.blocked(member.nodeId),
        kind: "blocked",
        subjectKey: member.nodeId,
        nodeId: member.nodeId,
        label: member.label,
      });
    }
  }

  // permission: chat pendingPermission appears (coarse projection preferred)
  for (const [agentKey, slot] of Object.entries(chat)) {
    if (!slot?.pendingPermissionId && !slot?.pendingPermission) continue;
    push({
      id: alertId.permission(agentKey),
      kind: "permission",
      subjectKey: agentKey,
      nodeId: agentNodeId(doc, agentKey),
      label: agentKey,
    });
  }

  // herdr-done: agentStatus becomes "done"
  for (const [nodeId, cache] of Object.entries(herdrMeta)) {
    const status = cache?.meta?.agentStatus?.toLowerCase();
    if (status !== "done") continue;
    push({
      id: alertId.herdrDone(nodeId),
      kind: "herdr-done",
      subjectKey: nodeId,
      nodeId: nodeExists(doc, nodeId),
      label: nodeId,
    });
  }

  // orphan: kernel orphaned arms
  for (const key of orphans) {
    const regionId = regionIdFromOrphanKey(key);
    push({
      id: alertId.orphan(key),
      kind: "orphan",
      subjectKey: key,
      nodeId: nodeExists(doc, regionId),
      label: key,
    });
  }

  return out;
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
    playAlert(item.kind);
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
    const run = (): void => {
      const signals = collectAlertSignals({
        doc: state$.doc.peek(),
        rollups: rollupsRef.current,
        chat: chatCoarse$.peek() as Record<string, { pendingPermissionId?: string } | undefined>,
        herdrMeta: herdr$.metaByNodeId.peek() as Record<
          string,
          { meta?: { agentStatus?: string } } | undefined
        >,
        snapshots: state$.snapshots.peek(),
        orphans: [],
      });
      observeAlertSignals(signals);
    };

    run();

    const offs = [
      chatCoarse$.onChange(() => run()),
      herdr$.metaByNodeId.onChange(() => run()),
      state$.snapshots.onChange(() => run()),
      state$.docVersion.onChange(() => run()),
    ];

    return () => {
      for (const off of offs) off();
      // Full unmount of RTS chrome only. Must NOT run when `rollups` identity
      // changes — parent re-creates the array every fuse and a wipe re-baselines
      // the queue so Space goes dead after the rise you just heard.
      resetAlertQueue();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rollups via ref; see comment above
  }, []);

  // Re-observe when rollups change without tearing down subscriptions/baseline.
  useEffect(() => {
    const signals = collectAlertSignals({
      doc: state$.doc.peek(),
      rollups: rollupsRef.current,
      chat: chatCoarse$.peek() as Record<string, { pendingPermissionId?: string } | undefined>,
      herdrMeta: herdr$.metaByNodeId.peek() as Record<
        string,
        { meta?: { agentStatus?: string } } | undefined
      >,
      snapshots: state$.snapshots.peek(),
      orphans: [],
    });
    observeAlertSignals(signals);
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
