/**
 * Wire: live seat and region states → rising edges → the attention sounds.
 *
 * Pure model lives in alert-queue.ts. This module collects what is present
 * (blocked, wanting input, finished and unread, working), observes it, and
 * sounds each rise: a subject getting more urgent than it was. Stepping to
 * the next agent is the shared urgency order's (lib/urgency-step.ts).
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
  emptyAlertQueue,
  observeSignals,
  type AlertKind,
  type AlertQueue,
  type AlertSignal,
} from "./alert-queue";
import { SEAT_URGENCY, type SeatUrgency } from "./seat-line";
import { playCue } from "./sound";
import { ALERT_CUE } from "./sound/director";
import { state$ } from "./state";

/**
 * How urgent each kind is, on the one table every surface reads: the rise
 * test and "which of two states wins for one node" both come from it.
 */
export const ALERT_URGENCY: Readonly<Record<AlertKind, SeatUrgency>> = {
  blocked: SEAT_URGENCY.blocked,
  attention: SEAT_URGENCY.waiting,
  ready: SEAT_URGENCY.review,
  working: SEAT_URGENCY.working,
};

/** Keep the more urgent of two signals for one subject. */
const keepMoreUrgent = (byId: Map<string, AlertSignal>, signal: AlertSignal): void => {
  const previous = byId.get(signal.id);
  if (previous !== undefined && previous.urgency <= signal.urgency) return;
  byId.set(signal.id, signal);
};

const signalFor = (nodeId: string, kind: AlertKind): AlertSignal => ({
  id: alertId.node(nodeId),
  kind,
  subjectKey: nodeId,
  urgency: ALERT_URGENCY[kind],
});

const severityToAlertKind = (
  severity: RegionRollup["members"][number]["severity"],
): AlertKind | undefined => {
  if (severity === "blocked") return "blocked";
  if (severity === "attention") return "attention";
  if (severity === "working") return "working";
  // Finished work still waiting to be read, for region members as for
  // freestanding seats.
  if (severity === "ready") return "ready";
  return undefined;
};

/** One signal per region member that is blocked, wants input, is finished and unread, or is working. */
export const collectAlertSignals = (
  rollups: ReadonlyArray<RegionRollup>,
): ReadonlyArray<AlertSignal> => {
  const byId = new Map<string, AlertSignal>();
  // A node can be a member of overlapping regions: its most urgent state wins.
  for (const rollup of rollups) {
    for (const member of rollup.members) {
      const kind = severityToAlertKind(member.severity);
      if (kind) keepMoreUrgent(byId, signalFor(member.nodeId, kind));
    }
  }
  return [...byId.values()];
};

/**
 * The same for managed seats anywhere on the canvas: region rollups only
 * cover region members, and a freestanding agent is heard too.
 */
export const collectReadyWorkingSignals = (
  nodes: ReadonlyArray<CanvasNode>,
  seats: Readonly<Record<string, AgentSeatStateEvent | undefined>>,
  needsLookByBindingId: Readonly<Record<string, boolean | undefined>>,
): ReadonlyArray<AlertSignal> => {
  const byId = new Map<string, AlertSignal>();
  for (const node of nodes) {
    const bindingId = bindingIdForNode(node);
    if (!bindingId) continue;
    const presentation = presentationForSeat(seats[bindingId]?.state, needsLookByBindingId[bindingId] === true);
    const kind: AlertKind | undefined =
      presentation === "done" ? "ready" : presentation === "attention" ? "attention" : presentation === "working" ? "working" : undefined;
    if (kind) keepMoreUrgent(byId, signalFor(node.id, kind));
  }
  return [...byId.values()];
};

/** Merge signal groups; the most urgent state wins per node. */
export const mergeAlertSignals = (
  ...groups: ReadonlyArray<ReadonlyArray<AlertSignal>>
): ReadonlyArray<AlertSignal> => {
  const byId = new Map<string, AlertSignal>();
  for (const group of groups) for (const signal of group) keepMoreUrgent(byId, signal);
  return [...byId.values()];
};

let queue: AlertQueue = emptyAlertQueue();
/** The canvas the queue's baseline was taken on. */
let queueScope: string | undefined;

/** Clear the baseline (unmount, tests). The next observe re-baselines. */
export const resetAlertQueue = (): void => {
  queue = emptyAlertQueue();
  queueScope = undefined;
};

export type AlertObserveContext = {
  /**
   * The seat states behind these signals have loaded. Before that, seats
   * "appearing" is the load, not news: nothing is heard, and the baseline is
   * taken on the first observe after it.
   */
  readonly settled?: boolean;
  /** The canvas. Another canvas's seats are new to the eye, not new events. */
  readonly scope?: string;
  /** Subjects whose state is unknown right now; they keep their last level. */
  readonly held?: ReadonlySet<string>;
};

/**
 * Observe live signals; every rise is heard (the mixer keeps it calm). A rise
 * is a subject getting more urgent than it was: a state re-sent unchanged, a
 * seat coming back from a gap where it was, a reload, or a canvas switch is
 * not one.
 */
export const observeAlertSignals = (
  signals: ReadonlyArray<AlertSignal>,
  context: AlertObserveContext = {},
): void => {
  if (context.scope !== undefined && context.scope !== queueScope) {
    queue = emptyAlertQueue();
    queueScope = context.scope;
  }
  if (context.settled === false) {
    queue = emptyAlertQueue();
    return;
  }
  const result = observeSignals(queue, signals, context.held);
  queue = result.queue;
  for (const item of result.risen) {
    playCue(ALERT_CUE[item.kind], { subject: item.subjectKey });
  }
};

/**
 * Seats with a binding whose latest state is unknown (booting, restarting,
 * reconnecting): nothing is known about them right now.
 */
export const heldSeatSignalIds = (
  nodes: ReadonlyArray<CanvasNode>,
  seats: Readonly<Record<string, AgentSeatStateEvent | undefined>>,
): ReadonlySet<string> => {
  const held = new Set<string>();
  for (const node of nodes) {
    const bindingId = bindingIdForNode(node);
    if (bindingId && seats[bindingId]?.state === "unknown") held.add(alertId.node(node.id));
  }
  return held;
};

const observeLive = (rollups: ReadonlyArray<RegionRollup>): void => {
  const seats = agentSeat$.byBindingId.peek() as Record<string, AgentSeatStateEvent | undefined>;
  observeAlertSignals(collectLiveAlertSignals(rollups), {
    settled: agentSeat$.hydrated.peek(),
    scope: state$.canvasName.peek(),
    held: heldSeatSignalIds(state$.doc.peek().nodes, seats),
  });
};

/** Changes whenever any seat's needs-look flag does (the operator looked). */
const needsLookKey = (needsLook: Readonly<Record<string, boolean | undefined>>): string =>
  Object.entries(needsLook)
    .filter(([, value]) => value === true)
    .map(([bindingId]) => bindingId)
    .sort()
    .join("|");

const collectLiveAlertSignals = (
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
  return mergeAlertSignals(
    collectAlertSignals(rollups),
    collectReadyWorkingSignals(nodes, seats, needsLook),
  );
};

/**
 * Mount in RTS chrome: follow the live planes and sound each rise. Rollups
 * come from the parent (already computed for chips); seat states come from
 * the live stores, so a freestanding seat is heard too.
 */
export function useAlertAttention(rollups: ReadonlyArray<RegionRollup>): void {
  const rollupsRef = useRef(rollups);
  rollupsRef.current = rollups;
  // Re-run observe when a seat changes, the operator looks at one, the seats
  // load, or the canvas does. The seat stores mutate in place, so their
  // object identity never changes: follow the apply counter and a key.
  const seatRev = use$(agentSeat$.rev);
  const lookKey = use$(() => needsLookKey(agentSeat$.needsLookByBindingId.get()));
  const hydrated = use$(agentSeat$.hydrated);
  const canvasName = use$(state$.canvasName);
  const docNodes = use$(state$.doc.nodes);

  useEffect(() => {
    observeLive(rollupsRef.current);

    return () => {
      // Full unmount of RTS chrome only. Must NOT run when `rollups` identity
      // changes: the parent re-creates the array every fuse, and a wipe would
      // re-baseline, so the next real rise would go unheard.
      resetAlertQueue();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rollups via ref; see comment above
  }, []);

  // Re-observe when rollups or the seat plane change without wiping baseline.
  useEffect(() => {
    observeLive(rollupsRef.current);
  }, [rollups, seatRev, lookKey, hydrated, canvasName, docNodes]);
}
