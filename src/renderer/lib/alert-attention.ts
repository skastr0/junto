/**
 * Wire: live seat and region states → rising edges → the attention sounds.
 *
 * Pure model lives in alert-queue.ts. This module collects what is present
 * (blocked, wanting input, finished and unread, working), observes it, and
 * sounds each rise: a subject getting more urgent than it was. Stepping to
 * the next agent is the shared urgency order's (lib/urgency-step.ts).
 */

import { observe } from "@legendapp/state";
import { useEffect, useRef } from "react";
import type { Node, Seat, Terminal } from "@shared/model";
import type { RegionRollup } from "@shared/region-rollup";
import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import {
  agentSeat$,
  presentationForSeat,
} from "./agent-seat-state";
import {
  alertId,
  compareAlerts,
  emptyAlertQueue,
  observeSignals,
  type AlertGroup,
  type AlertQueue,
  type AlertSignal,
} from "./alert-queue";
import { AlertKind } from "@shared/wire/urgency";
import { playCue } from "./sound";
import { alertCue } from "./sound/director";
import { state$ } from "./state";
import { modelStore } from "./use-model";

/**
 * Keep the more urgent of two signals for one subject: the alert view of the
 * urgency ladder decides both this and the rise test.
 */
const keepMoreUrgent = (byId: Map<string, AlertSignal>, signal: AlertSignal): void => {
  const previous = byId.get(signal.id);
  if (previous !== undefined && compareAlerts(previous.kind, signal.kind) <= 0) return;
  byId.set(signal.id, signal);
};

const signalFor = (nodeId: string, kind: AlertGroup): AlertSignal => ({
  id: alertId.node(nodeId),
  kind,
  subjectKey: nodeId,
});

const severityToAlertKind = (
  severity: RegionRollup["members"][number]["severity"],
): AlertGroup | undefined => {
  if (severity === "blocked") return AlertKind.group.blocked;
  if (severity === "attention") return AlertKind.group.attention;
  if (severity === "working") return AlertKind.group.working;
  // Finished work still waiting to be read, for region members as for
  // freestanding seats.
  if (severity === "ready") return AlertKind.group.ready;
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
  nodes: ReadonlyArray<Node>,
  seats: Readonly<Record<string, AgentSeatStateEvent | undefined>>,
  needsLookByBindingId: Readonly<Record<string, boolean | undefined>>,
): ReadonlyArray<AlertSignal> => {
  const byId = new Map<string, AlertSignal>();
  for (const node of nodes) {
    if (node.kind !== "agent" && node.kind !== "terminal") continue;
    const bindingId = node.bindingId;
    const presentation = presentationForSeat(seats[bindingId]?.state, needsLookByBindingId[bindingId] === true);
    const kind: AlertGroup | undefined =
      presentation === "done"
        ? AlertKind.group.ready
        : presentation === "attention"
          ? AlertKind.group.attention
          : presentation === "working"
            ? AlertKind.group.working
            : undefined;
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
    const cue = alertCue(item.kind);
    if (cue !== undefined) playCue(cue, { subject: item.subjectKey });
  }
};

/**
 * Seats with a binding whose latest state is unknown (booting, restarting,
 * reconnecting): nothing is known about them right now.
 */
export const heldSeatSignalIds = (
  nodes: ReadonlyArray<Node>,
  seats: Readonly<Record<string, AgentSeatStateEvent | undefined>>,
): ReadonlySet<string> => {
  const held = new Set<string>();
  for (const node of nodes) {
    if (node.kind !== "agent" && node.kind !== "terminal") continue;
    if (seats[node.bindingId]?.state === "unknown") held.add(alertId.node(node.id));
  }
  return held;
};

const liveSeatNodes = (): ReadonlyArray<Seat | Terminal> =>
  Object.values(modelStore.canvas$(state$.canvasName.peek()).nodes.peek())
    .filter((node): node is Seat | Terminal => node.kind === "agent" || node.kind === "terminal");

const observeLive = (signals: ReadonlyArray<AlertSignal>): void => {
  const seats = agentSeat$.byBindingId.peek() as Record<string, AgentSeatStateEvent | undefined>;
  observeAlertSignals(collectLiveAlertSignals(signals), {
    settled: agentSeat$.hydrated.peek() && modelStore.canvas$(state$.canvasName.peek()).status.peek() === "open",
    scope: state$.canvasName.peek(),
    held: heldSeatSignalIds(liveSeatNodes(), seats),
  });
};

const collectLiveAlertSignals = (
  signals: ReadonlyArray<AlertSignal>,
): ReadonlyArray<AlertSignal> => {
  const nodes = liveSeatNodes();
  const seats = agentSeat$.byBindingId.peek() as Record<
    string,
    AgentSeatStateEvent | undefined
  >;
  const needsLook = agentSeat$.needsLookByBindingId.peek() as Record<
    string,
    boolean | undefined
  >;
  return mergeAlertSignals(
    signals,
    collectReadyWorkingSignals(nodes, seats, needsLook),
  );
};

/**
 * Mount in RTS chrome: follow the live planes and sound each rise. Rollups
 * come from the parent (already computed for chips); seat states come from
 * the live stores, so a freestanding seat is heard too.
 */
export function useAlertAttention(rollups: ReadonlyArray<RegionRollup>): void {
  useAlertSignals(collectAlertSignals(rollups));
}

export function useAlertSignals(signals: ReadonlyArray<AlertSignal> | (() => ReadonlyArray<AlertSignal>)): void {
  const signalsRef = useRef(signals);
  signalsRef.current = signals;
  const readSignals = () => typeof signalsRef.current === "function" ? signalsRef.current() : signalsRef.current;
  useEffect(() => {
    // This hook performs sounds only. Observe its inputs without committing
    // React chrome for a seat timestamp, movement or unchanged signal.
    const stop = observe(() => {
      const canvas = state$.canvasName.get();
      const model = modelStore.canvas$(canvas);
      model.status.get();
      const nodes = model.nodes.get();
      for (const node of Object.values(nodes)) {
        if (node.kind !== "agent" && node.kind !== "terminal") continue;
        agentSeat$.byBindingId[node.bindingId].state.get();
        agentSeat$.needsLookByBindingId[node.bindingId].get();
      }
      agentSeat$.hydrated.get();
      observeLive(readSignals());
    });
    return () => { stop(); resetAlertQueue(); };
  }, []);

  // Re-observe when rollups or the seat plane change without wiping baseline.
  useEffect(() => {
    observeLive(readSignals());
  }, [signals]);
}
