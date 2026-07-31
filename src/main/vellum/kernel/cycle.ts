// The kernel evaluation cycle. Watcher status, timer claim/nextFire, execution
// graph, flagOnUnsatisfied, and phase-mirror hooks live here. Region Pulse
// delivery (inject, arming, pulse log, delivery queue) is retired product —
// see state-schema retained tables; this module no longer delivers pulses.

import type { CanvasDoc, EdgePhase } from "@shared/canvas";
import {
  deriveExecutionGraph,
  type BlockedReason,
} from "@shared/execution-graph";
import {
  DEFAULT_STATION_HOST_ID,
  isNodeEligibleOnStation,
  isStationRole,
  resolveNodeHostId,
  type StationRole,
} from "@shared/station";
import type {
  SchedulerClaimInput,
  SchedulerClaimResult,
} from "../scheduler/repository";
import type { ActorRefResolver } from "@shared/attention";
import {
  detectPulses,
  purgeCanvasEdgeMemory,
  resetWatcherMemory,
  type WatcherStatus,
} from "./evaluate";
import { liveSeatBlocksForCanvas } from "../work/blocked-seat";
import type { SnapshotState } from "../../../shared/entities";

// --- frozen interface --------------------------------------------------------

export interface WatcherRuntimeState {
  status: "satisfied" | "pending" | "unknown";
  detail: string;
  lastFiredAt?: number;
}

/** Serializable per-canvas execution graph for renderer projection. */
export interface ExecutionSnapshot {
  readonly phaseByEdgeId: Record<string, EdgePhase>;
  readonly detailByEdgeId: Record<string, string>;
  readonly blocked: ReadonlyArray<string>;
  readonly blockedEdgeIds: ReadonlyArray<string>;
  readonly reasonsByNodeId: Record<string, ReadonlyArray<BlockedReason>>;
}

/** Local kernel hot-read shape (service owns the wire KernelSnapshot). */
export interface KernelSnapshot {
  canvases: Record<
    string,
    {
      watchers: Record<string, WatcherRuntimeState>;
      nextFire: Record<string, number>;
      execution?: ExecutionSnapshot;
    }
  >;
}

// --- injectable seams --------------------------------------------------------

export interface FlagWriterDeps {
  // canvasName is threaded in (not resolved from a node->canvas index) because
  // JSON Canvas node ids are document-local: the same id can legitimately exist
  // on two canvases. The evaluator always knows which canvas a fired node came
  // from, so it routes the write by (canvasName, nodeId) directly.
  readonly setFlag: (
    canvasName: string,
    nodeId: string,
    flag: string,
    enabled: boolean,
  ) => void;
}

// Level-driven mirror of derived edge phase into ether.kind for criteria
// edges so document projections expose the last live phase.
export interface PhaseMirrorDeps {
  readonly mirrorPhases: (
    canvasName: string,
    phaseByEdgeId: ReadonlyMap<string, EdgePhase>,
  ) => void;
}

export interface TimerSchedulerDeps {
  readonly claimInterval: (
    input: SchedulerClaimInput,
  ) => Promise<SchedulerClaimResult>;
  readonly reconcileHome: (
    homeStation: string,
    activeTimerKeys: ReadonlyArray<string>,
  ) => Promise<number>;
}

// --- module-level state ------------------------------------------------------

let docs: Map<string, CanvasDoc> = new Map();
let snapshots: SnapshotState = { bundles: [] };
let flagWriterDeps: FlagWriterDeps | undefined = undefined;
let phaseMirrorDeps: PhaseMirrorDeps | undefined = undefined;
let timerSchedulerDeps: TimerSchedulerDeps | undefined = undefined;
let resolveActorRef: ActorRefResolver = () => undefined;

export const __setDocsForTest = (docsMap: Map<string, CanvasDoc>): void => {
  docs = docsMap;
};

export const __setSnapshotsForTest = (state: SnapshotState): void => {
  snapshots = state;
};

export const setActorRefResolver = (resolver: ActorRefResolver): void => {
  resolveActorRef = resolver;
};

export const __setFlagWriterForTest = (deps: FlagWriterDeps | undefined): void => {
  flagWriterDeps = deps;
};

export const __setPhaseMirrorForTest = (deps: PhaseMirrorDeps | undefined): void => {
  phaseMirrorDeps = deps;
};

export const __setTimerSchedulerForTest = (
  deps: TimerSchedulerDeps | undefined,
): void => {
  timerSchedulerDeps = deps;
};

export const __resetKernelMemoryForTest = (): void => {
  docs = new Map();
  snapshots = { bundles: [] };
  flagWriterDeps = undefined;
  phaseMirrorDeps = undefined;
  timerSchedulerDeps = undefined;
  resolveActorRef = () => undefined;
  nextFire.clear();
  executionByCanvas.clear();
  resetWatcherMemory();
};

/** True when any criteria edge's mirrored kind/color differs from derived phase. */
export const criteriaPhasesNeedMirror = (
  doc: CanvasDoc,
  phaseByEdgeId: ReadonlyMap<string, EdgePhase>,
): boolean => {
  for (const edge of doc.edges) {
    if (!edge.ether?.criteria) continue;
    const phase = phaseByEdgeId.get(edge.id);
    if (phase === undefined) continue;
    if (edge.ether.kind !== phase) return true;
    // Stuck blocks crimson after demotion.
    if (phase !== "blocks" && edge.color === "1") return true;
    if (phase === "blocks" && edge.color !== "1") return true;
  }
  return false;
};

export const getKernelSnapshot = (): KernelSnapshot => {
  const canvases: Record<
    string,
    {
      watchers: Record<string, WatcherRuntimeState>;
      nextFire: Record<string, number>;
    }
  > = {};
  return { canvases };
};

// --- station scope (Command Center / Remote) ---------------------------------
// Host-scoped execution: this station only evaluates executable nodes stamped
// for its hostId. Role is user-selected (settings); never inferred.

/**
 * Runtime station scope. Doctrine fail-closed: unknown/empty role is "unset",
 * never inferred as Command Center. Unset refuses both CC authoring power and
 * Remote host-scoped execution fan-out that would assume a valid role.
 */
export type StationScopeRole = StationRole | "unset";

let stationHostId: string = DEFAULT_STATION_HOST_ID;
let stationRole: StationScopeRole = "unset";

export const __setStationScopeForTest = (input: {
  readonly hostId: string;
  readonly role: StationScopeRole;
}): void => {
  stationHostId = input.hostId;
  stationRole = input.role;
};

export const getStationScope = (): {
  readonly hostId: string;
  readonly role: StationScopeRole;
} => ({
  hostId: stationHostId,
  role: stationRole,
});

export const setStationScope = (input: {
  readonly hostId: string;
  readonly role: string;
}): void => {
  stationHostId =
    typeof input.hostId === "string" && input.hostId.length > 0
      ? input.hostId
      : DEFAULT_STATION_HOST_ID;
  // Fail closed: invalid or empty role is not Command Center (security doctrine).
  stationRole = isStationRole(input.role) ? input.role : "unset";
};

// --- flagOnUnsatisfied (level watchers only) ----------------------------------
// Mirrors the derived "unsatisfied" state into the blocker flag, writing
// only when the flag actually needs to change — never on every tick.
// Pure decision: does the blocker flag need to flip for this watcher read?
// A down/absent source reads "unknown" — which must NEVER mutate the document
// (the down-source invariant). So "unknown" always returns false (leave the
// existing flag untouched, neither raising nor clearing it on a transient
// blip); only a KNOWN read drives the flag — "pending" wants the blocker,
// "satisfied" wants it gone.
export const flagShouldToggle = (hasFlag: boolean, status: WatcherStatus): boolean => {
  if (status === "unknown") return false;
  return hasFlag !== (status === "pending");
};

const applyFlagOnUnsatisfied = (
  canvasName: string,
  doc: CanvasDoc,
  nodeId: string,
  flagOnUnsatisfied: boolean | undefined,
  status: WatcherStatus,
): void => {
  if (!flagOnUnsatisfied || !flagWriterDeps) return;
  const node = doc.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return;
  const hasFlag = node.ether?.flags?.includes("blocker") ?? false;
  if (flagShouldToggle(hasFlag, status)) {
    flagWriterDeps.setFlag(canvasName, nodeId, "blocker", status === "pending");
  }
};

// Per-canvas derived execution graphs (recomputed each evaluation cycle).
const executionByCanvas = new Map<string, ExecutionSnapshot>();

export const getExecutionByCanvas = (): ReadonlyMap<string, ExecutionSnapshot> =>
  executionByCanvas;

const snapshotFromGraph = (
  canvasName: string,
  doc: CanvasDoc,
): ExecutionSnapshot => {
  const graph = deriveExecutionGraph(doc, {
    canvasName,
    resolveActorRef,
    workBlockedSeats: liveSeatBlocksForCanvas(canvasName, doc),
  });
  const phaseByEdgeId: Record<string, EdgePhase> = {};
  const detailByEdgeId: Record<string, string> = {};
  for (const [id, phase] of graph.phaseByEdgeId) phaseByEdgeId[id] = phase;
  for (const [id, detail] of graph.detailByEdgeId) detailByEdgeId[id] = detail;
  const reasonsByNodeId: Record<string, ReadonlyArray<BlockedReason>> = {};
  for (const [id, reasons] of graph.reasonsByNodeId) reasonsByNodeId[id] = reasons;
  return {
    phaseByEdgeId,
    detailByEdgeId,
    blocked: Array.from(graph.blocked),
    blockedEdgeIds: Array.from(graph.blockedEdgeIds),
    reasonsByNodeId,
  };
};

// --- evaluation cycle (multi-canvas with per-canvas isolation) ---------------

// Watcher runtime state tracking (keyed by canvasName::nodeId)
const watchers = new Map<string, WatcherRuntimeState>();
// Next fire times for timers (keyed by canvasName::nodeId)
const nextFire = new Map<string, number>();

// Exported for tests: drive exactly one evaluation pass.
export const runEvaluationCycle = async (): Promise<void> => {
  // Evaluate each canvas with per-canvas isolation. Watchers read hermes
  // snapshots already held in module state (setSnapshots / adapter poll).
  for (const [canvasName, doc] of docs.entries()) {
    try {
      const execution = snapshotFromGraph(canvasName, doc);
      executionByCanvas.set(canvasName, execution);

      // Mirror derived phase into stored kind for criteria edges (offline
      // readability). Level-driven + idempotent — only writes when kind drifts.
      if (phaseMirrorDeps) {
        const phaseMap = new Map(
          Object.entries(execution.phaseByEdgeId) as Array<[string, EdgePhase]>,
        );
        if (criteriaPhasesNeedMirror(doc, phaseMap)) {
          phaseMirrorDeps.mirrorPhases(canvasName, phaseMap);
        }
      }

      for (const { nodeId, watch, result } of detectPulses(canvasName, doc, snapshots)) {
        const source = doc.nodes.find((node) => node.id === nodeId);
        // Host-scoped: this station only runs executable nodes assigned to it.
        if (source !== undefined && !isNodeEligibleOnStation(source, stationHostId)) {
          continue;
        }
        const watcherKey = `${canvasName}::${nodeId}`;
        const previous = watchers.get(watcherKey);
        // Region Pulse delivery is retired: rising-edge `fired` no longer
        // injects a seat prompt. Optionally preserve prior lastFiredAt if any
        // external path ever stamped it; product path leaves it unset.
        const nextRuntime: WatcherRuntimeState = {
          status: result.state.status,
          detail: result.state.detail,
          ...(previous?.lastFiredAt !== undefined
            ? { lastFiredAt: previous.lastFiredAt }
            : {}),
        };
        watchers.set(watcherKey, nextRuntime);

        applyFlagOnUnsatisfied(
          canvasName,
          doc,
          nodeId,
          watch.flagOnUnsatisfied,
          result.state.status,
        );
        // result.fired: evaluation status only — no pulse inject.
      }
    } catch (err) {
      // One bad doc never stalls the rest — swallow, mark degraded, continue
      console.error(`Kernel evaluation failed for canvas "${canvasName}":`, err);
    }
  }
};

// --- timer scheduling ----------------------------------------------------------
// EtherTimer.everyMinutes is Schema.Number at the document level — the
// schema validates SHAPE, not business range, and the UI editor's 5-minute
// floor is only a convenience. The main-side scheduler remains the authority
// and admits only a positive, finite interval.
export const isValidTimerInterval = (everyMinutes: number): boolean =>
  Number.isFinite(everyMinutes) &&
  everyMinutes > 0 &&
  Number.isSafeInteger(everyMinutes * 60_000);

export const checkTimers = async (
  nowEpochMs = Date.now(),
): Promise<void> => {
  const activeTimerKeys: string[] = [];
  for (const [canvasName, doc] of docs.entries()) {
    for (const node of doc.nodes) {
      if (
        node.type === "text" &&
        node.ether?.timer !== undefined &&
        isNodeEligibleOnStation(node, stationHostId)
      ) {
        activeTimerKeys.push(`${canvasName}::${node.id}`);
      }
    }
  }

  if (timerSchedulerDeps === undefined) {
    for (const key of activeTimerKeys) nextFire.delete(key);
    if (activeTimerKeys.length > 0) {
      console.error(
        "[kernel] durable timer scheduler unavailable — timers are disabled",
      );
    }
    return;
  }

  try {
    await timerSchedulerDeps.reconcileHome(
      stationHostId,
      activeTimerKeys,
    );
  } catch (error) {
    console.error(
      "[kernel] timer reconciliation failed — timers are disabled for this pass:",
      error,
    );
    return;
  }

  for (const [canvasName, doc] of docs.entries()) {
    for (const node of doc.nodes) {
      if (node.type !== "text") continue;
      const timer = node.ether?.timer;
      if (!timer) continue;
      if (!isNodeEligibleOnStation(node, stationHostId)) continue;
      const timerKey = `${canvasName}::${node.id}`;
      if (!isValidTimerInterval(timer.everyMinutes)) {
        // Invalid -> unknown-style no-op: never scheduled, never advances
        // (LAW: unknown never fires). Clear any stale schedule left over
        // from before an edit made it invalid.
        if (nextFire.has(timerKey)) nextFire.delete(timerKey);
        console.error(
          `[kernel] invalid timer everyMinutes (${timer.everyMinutes}) on ${timerKey} — disabled until fixed`,
        );
        continue;
      }
      try {
        const decision = await timerSchedulerDeps.claimInterval({
          timerKey,
          localStationId: stationHostId,
          homeStationIds: [resolveNodeHostId(node)],
          nowEpochMs,
          everyMinutes: timer.everyMinutes,
        });
        if (decision._tag === "Ineligible") {
          nextFire.delete(timerKey);
          console.error(
            `[kernel] timer ${timerKey} is ineligible (${decision.reason})`,
          );
          continue;
        }
        if (decision._tag === "Initialized") {
          nextFire.set(timerKey, decision.state.nextDueAtEpochMs);
          continue;
        }
        if (decision._tag === "NotDue") {
          nextFire.set(timerKey, decision.state.nextDueAtEpochMs);
          continue;
        }

        // Due: claim advanced nextFire only — no pulse inject on fire.
        nextFire.set(timerKey, decision.nextState.nextDueAtEpochMs);
      } catch (error) {
        nextFire.delete(timerKey);
        console.error(
          `[kernel] timer claim failed for ${timerKey} — disabled for this pass:`,
          error,
        );
      }
    }
  }
};

// --- utility exports (for tests) -----------------------------------------------

export const setDocs = (docsMap: Map<string, CanvasDoc>): void => {
  docs = docsMap;
};

export const getWatchers = (): Map<string, WatcherRuntimeState> => {
  return new Map(watchers);
};

export const getNextFire = (): Map<string, number> => {
  return new Map(nextFire);
};

// Drops the DERIVED namespaced state for a canvas that's gone from authority
// (deleted or renamed) — watchers/nextFire/edge-detection/execution memory,
// keyed `${canvasName}::${id}`. Arming/pulse product state is retired.
export const purgeCanvasMemory = (canvasName: string): void => {
  const prefix = `${canvasName}::`;
  for (const key of watchers.keys()) if (key.startsWith(prefix)) watchers.delete(key);
  for (const key of nextFire.keys()) if (key.startsWith(prefix)) nextFire.delete(key);
  executionByCanvas.delete(canvasName);
  // evaluate.ts's edge-detection memory (seenLevelStatus) is namespaced the
  // same way and grows unbounded across the app's lifetime otherwise —
  // purge it here too so a deleted canvas's baselines don't outlive the canvas.
  purgeCanvasEdgeMemory(canvasName);
};

// Splits a `${canvasName}::${id}` namespaced key. Canvas names are [a-z0-9-]
// and node ids never contain "::", so the first occurrence is the boundary.
const splitNamespacedKey = (key: string): readonly [canvasName: string, id: string] | undefined => {
  const idx = key.indexOf("::");
  if (idx < 0) return undefined;
  return [key.slice(0, idx), key.slice(idx + 2)];
};

// Per-cycle reconcile for canvases that STILL exist but whose watcher/timer
// nodes changed underneath us: a node deleted, or its ether.watch / ether.timer
// removed, leaves a stale `${canvasName}::${nodeId}` entry in watchers/nextFire
// that would otherwise project into the snapshot forever (purgeCanvasMemory
// only fires on whole-canvas deletion, never on an in-place node edit). Drops
// exactly those entries whose owning canvas IS hydrated but no longer carries a
// matching watch/timer. Entries for a canvas that is NOT hydrated are left
// alone (that is purgeCanvasMemory's job, on delete).
export const reconcileLiveCanvasMemory = (): void => {
  const hasWatch = (canvasName: string, nodeId: string): boolean => {
    const doc = docs.get(canvasName);
    if (!doc) return false; // canvas not hydrated — leave to purgeCanvasMemory
    return doc.nodes.some(
      (node) =>
        node.id === nodeId && node.type === "text" && node.ether?.watch !== undefined,
    );
  };
  const hasTimer = (canvasName: string, nodeId: string): boolean => {
    const doc = docs.get(canvasName);
    if (!doc) return false;
    return doc.nodes.some(
      (node) =>
        node.id === nodeId && node.type === "text" && node.ether?.timer !== undefined,
    );
  };
  for (const key of [...watchers.keys()]) {
    const split = splitNamespacedKey(key);
    if (!split || !docs.has(split[0])) continue;
    if (!hasWatch(split[0], split[1])) watchers.delete(key);
  }
  for (const key of [...nextFire.keys()]) {
    const split = splitNamespacedKey(key);
    if (!split || !docs.has(split[0])) continue;
    if (!hasTimer(split[0], split[1])) nextFire.delete(key);
  }
};
