/**
 * Wire: rising-edge alert queue → SFX + Space/` cycle → focusNodeId.
 *
 * Pure model lives in alert-queue.ts. This module collects live signals from
 * region rollups, chat permissions, herdr done, booth pending, and kernel
 * orphans; observes the queue; plays playAlert on rise; and cycles focus.
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
import { chatState$ } from "./chat-state";
import { herdr$ } from "./herdr-state";
import { kernel$ } from "./kernel-view";
import { playAlert } from "./sfx";
import { state$ } from "./state";

const isTextEditing = (target: EventTarget | null): boolean =>
  target instanceof Element && Boolean(target.closest("input, textarea, [contenteditable='true']"));

const agentNodeId = (doc: CanvasDoc, agentKey: string): string | undefined => {
  for (const node of doc.nodes) {
    if (node.ether?.entity?.kind === "agent" && node.ether.entity.name === agentKey) {
      return node.id;
    }
  }
  return undefined;
};

/** Prefer project node whose entity.name is the booth/tower key. */
const boothNodeId = (doc: CanvasDoc, projectKey: string): string | undefined => {
  for (const node of doc.nodes) {
    const entity = node.ether?.entity;
    if (!entity?.name) continue;
    if (entity.name === projectKey) return node.id;
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
  readonly chat: Record<string, { pendingPermission?: { requestId?: string } } | undefined>;
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

  // permission: chat pendingPermission appears
  for (const [agentKey, slot] of Object.entries(chat)) {
    if (!slot?.pendingPermission) continue;
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

  // booth-review: pending_review > 0 (level = count for re-rise on increase)
  const boothBundle = snapshots.bundles.find((b) => b.source === "booth" && b.ok);
  if (boothBundle) {
    for (const entity of boothBundle.entities) {
      const pending = entity.stats.pending_review;
      if (typeof pending !== "number" || pending <= 0) continue;
      push({
        id: alertId.boothReview(entity.key),
        kind: "booth-review",
        subjectKey: entity.key,
        nodeId: boothNodeId(doc, entity.key),
        label: entity.title || entity.key,
        level: pending,
      });
    }
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
        chat: chatState$.peek() as Record<string, { pendingPermission?: { requestId?: string } } | undefined>,
        herdrMeta: herdr$.metaByNodeId.peek() as Record<
          string,
          { meta?: { agentStatus?: string } } | undefined
        >,
        snapshots: state$.snapshots.peek(),
        orphans: (kernel$.orphaned.peek() as ReadonlyArray<string> | undefined) ?? [],
      });
      observeAlertSignals(signals);
    };

    run();

    const offs = [
      chatState$.onChange(() => run()),
      herdr$.metaByNodeId.onChange(() => run()),
      kernel$.orphaned.onChange(() => run()),
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
      chat: chatState$.peek() as Record<string, { pendingPermission?: { requestId?: string } } | undefined>,
      herdrMeta: herdr$.metaByNodeId.peek() as Record<
        string,
        { meta?: { agentStatus?: string } } | undefined
      >,
      snapshots: state$.snapshots.peek(),
      orphans: (kernel$.orphaned.peek() as ReadonlyArray<string> | undefined) ?? [],
    });
    observeAlertSignals(signals);
  }, [rollups]);

  // Hotkey: Space or backtick, never while text-editing / key-repeat thrash.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== " " && event.key !== "`") return;
      if (isTextEditing(event.target)) return;
      // Don't steal Space when a button/role receives it for activation.
      if (
        event.target instanceof Element &&
        event.target.closest("button, [role='button'], a, select, summary")
      ) {
        return;
      }
      if (queue.items.length === 0) return;
      event.preventDefault();
      cycleAlertFocus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
