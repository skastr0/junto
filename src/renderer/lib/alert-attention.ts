/**
 * Wire: rising-edge alert queue → SFX + Space/` cycle → focusNodeId.
 *
 * Pure model lives in alert-queue.ts. This module collects cycle targets
 * (notifications → ready/complete → working), observes the queue, plays SFX
 * on notification rises only, and cycles focus.
 */

import { use$ } from "@legendapp/state/react";
import { useEffect, useRef } from "react";
import type { CanvasNode } from "@shared/canvas";
import type { RegionRollup } from "@shared/region-rollup";
import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import {
  agentSeat$,
  bindingIdForNode,
  presentationForSeat,
} from "./agent-seat-state";
import {
  alertId,
  alertKindHasRiseSfx,
  cycleNext,
  emptyAlertQueue,
  observeSignals,
  resolveFocusNodeId,
  type AlertItem,
  type AlertKind,
  type AlertQueue,
  type AlertSignal,
} from "./alert-queue";
import { herdr$ } from "./herdr-state";
import { nodeTitle } from "./presentation";
import { playAlert } from "./sfx";
import { selectNode, state$ } from "./state";

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

/** Severity ladder for cycle kinds — higher wins when the same node appears twice. */
const KIND_LEVEL: Readonly<Record<AlertKind, number>> = {
  blocked: 4,
  attention: 3,
  ready: 2,
  working: 1,
};

const severityToCycleKind = (
  severity: RegionRollup["members"][number]["severity"],
): AlertKind | undefined => {
  if (severity === "blocked") return "blocked";
  if (severity === "attention") return "attention";
  if (severity === "working") return "working";
  // Region members now carry the same ready tier freestanding seats already
  // cycled on: finished work still waiting to be read.
  if (severity === "ready") return "ready";
  return undefined;
};

/** Build one stable, actionable signal per cycle-worthy region member. */
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
      const kind = severityToCycleKind(member.severity);
      if (!kind) continue;
      push({
        id: alertId.node(member.nodeId),
        kind,
        subjectKey: member.nodeId,
        nodeId: member.nodeId,
        label: member.label,
        level: KIND_LEVEL[kind],
      });
    }
  }

  return [...byId.values()];
};

/**
 * Canvas-wide cycle targets from managed seats, herdr, and authorial flags.
 *
 * Region rollups only cover group members — freestanding agents outside every
 * region still need Space/` to land on them (parity with the notify strip).
 * Emits ready / working / attention (not graph-blocked; that stays on rollups
 * + notify freestanding).
 */
export const collectReadyWorkingSignals = (
  nodes: ReadonlyArray<CanvasNode>,
  seats: Readonly<Record<string, AgentSeatStateEvent | undefined>>,
  needsLookByBindingId: Readonly<Record<string, boolean | undefined>>,
  herdrMetaByNodeId: Readonly<
    Record<
      string,
      | {
          readonly meta?: { readonly agentStatus?: string };
          readonly pendingSeen?: boolean;
        }
      | undefined
    >
  >,
): ReadonlyArray<AlertSignal> => {
  const byId = new Map<string, AlertSignal>();
  const push = (signal: AlertSignal): void => {
    const previous = byId.get(signal.id);
    if (previous !== undefined && (previous.level ?? 0) >= (signal.level ?? 0)) return;
    byId.set(signal.id, signal);
  };

  for (const node of nodes) {
    const label = nodeTitle(node);
    const bindingId = bindingIdForNode(node);
    if (bindingId) {
      const event = seats[bindingId];
      const presentation = presentationForSeat(
        event?.state,
        needsLookByBindingId[bindingId] === true,
      );
      if (presentation === "done") {
        push({
          id: alertId.node(node.id),
          kind: "ready",
          subjectKey: node.id,
          nodeId: node.id,
          label,
          level: KIND_LEVEL.ready,
        });
      } else if (presentation === "attention") {
        // Needs-input freestanding seats — not only region members.
        push({
          id: alertId.node(node.id),
          kind: "attention",
          subjectKey: node.id,
          nodeId: node.id,
          label,
          level: KIND_LEVEL.attention,
        });
      } else if (presentation === "working") {
        push({
          id: alertId.node(node.id),
          kind: "working",
          subjectKey: node.id,
          nodeId: node.id,
          label,
          level: KIND_LEVEL.working,
        });
      }
    }

    // Authorial flag:attention (furniture / non-seat nodes) still cycles.
    if (node.ether?.flags?.includes("attention") === true) {
      push({
        id: alertId.node(node.id),
        kind: "attention",
        subjectKey: node.id,
        nodeId: node.id,
        label,
        level: KIND_LEVEL.attention,
      });
    }

    const herdr = herdrMetaByNodeId[node.id];
    if (!herdr) continue;
    const status = herdr.meta?.agentStatus;
    if (status === "done" && herdr.pendingSeen !== true) {
      push({
        id: alertId.node(node.id),
        kind: "ready",
        subjectKey: node.id,
        nodeId: node.id,
        label,
        level: KIND_LEVEL.ready,
      });
    } else if (status === "blocked") {
      push({
        id: alertId.node(node.id),
        kind: "blocked",
        subjectKey: node.id,
        nodeId: node.id,
        label,
        level: KIND_LEVEL.blocked,
      });
    } else if (status === "attention") {
      push({
        id: alertId.node(node.id),
        kind: "attention",
        subjectKey: node.id,
        nodeId: node.id,
        label,
        level: KIND_LEVEL.attention,
      });
    } else if (status === "working") {
      push({
        id: alertId.node(node.id),
        kind: "working",
        subjectKey: node.id,
        nodeId: node.id,
        label,
        level: KIND_LEVEL.working,
      });
    }
  }

  return [...byId.values()];
};

/** Merge rollup + ready/working signals; worst kind wins per node. */
export const mergeCycleSignals = (
  ...groups: ReadonlyArray<ReadonlyArray<AlertSignal>>
): ReadonlyArray<AlertSignal> => {
  const byId = new Map<string, AlertSignal>();
  for (const group of groups) {
    for (const signal of group) {
      const previous = byId.get(signal.id);
      if (previous !== undefined && (previous.level ?? 0) >= (signal.level ?? 0)) continue;
      byId.set(signal.id, signal);
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
  selectNode(nodeId);
  state$.focusNodeId.set(nodeId);
};

/** Observe live signals; play rising-edge SFX for notifications only. */
export const observeAlertSignals = (signals: ReadonlyArray<AlertSignal>): void => {
  const result = observeSignals(queue, signals);
  queue = result.queue;
  for (const item of result.risen) {
    if (!alertKindHasRiseSfx(item.kind)) continue;
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

const collectLiveCycleSignals = (
  rollups: ReadonlyArray<RegionRollup>,
): ReadonlyArray<AlertSignal> => {
  const nodes = state$.doc.peek().nodes;
  const seats = agentSeat$.byBindingId.peek() as Record<
    string,
    AgentSeatStateEvent | undefined
  >;
  const needsLook = agentSeat$.needsLookByBindingId.peek() as Record<
    string,
    boolean | undefined
  >;
  const herdrMeta = herdr$.metaByNodeId.peek() as Record<
    string,
    | {
        readonly meta?: { readonly agentStatus?: string };
        readonly pendingSeen?: boolean;
      }
    | undefined
  >;
  return mergeCycleSignals(
    collectAlertSignals(rollups),
    collectReadyWorkingSignals(nodes, seats, needsLook, herdrMeta ?? {}),
  );
};

/**
 * Mount in RTS chrome: subscribe live planes, observe queue, bind Space / `.
 * Rollups come from the parent (already computed for chips). Ready/working
 * seats and herdr done come from live stores so completes enter the tour.
 */
export function useAlertAttention(rollups: ReadonlyArray<RegionRollup>): void {
  const rollupsRef = useRef(rollups);
  rollupsRef.current = rollups;
  // Re-run observe when seats / herdr / doc identity change (ready+working).
  const seatByBinding = use$(agentSeat$.byBindingId);
  const needsLookByBinding = use$(agentSeat$.needsLookByBindingId);
  const herdrMetaByNodeId = use$(herdr$.metaByNodeId);
  const docNodes = use$(state$.doc.nodes);

  useEffect(() => {
    observeAlertSignals(collectLiveCycleSignals(rollupsRef.current));

    return () => {
      // Full unmount of RTS chrome only. Must NOT run when `rollups` identity
      // changes — parent re-creates the array every fuse and a wipe re-baselines
      // the queue so Space goes dead after the rise you just heard.
      resetAlertQueue();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rollups via ref; see comment above
  }, []);

  // Re-observe when rollups or seat/herdr planes change without wiping baseline.
  useEffect(() => {
    observeAlertSignals(collectLiveCycleSignals(rollupsRef.current));
  }, [rollups, seatByBinding, needsLookByBinding, herdrMetaByNodeId, docNodes]);

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
