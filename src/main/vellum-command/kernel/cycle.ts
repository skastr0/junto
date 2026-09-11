// The kernel evaluation cycle. Gauge/relay status, cron claim/nextFire,
// scheduler edge effects, execution graph, and flagOnUnsatisfied live here.
// Region pulse inject is retired — effects are compiled from the edge's verb
// (enqueues / wakes / flags), never geometry fan-out. Edge phase is derived on
// every read and never mirrored back into the document, so the cycle has no
// phase to write.

import type { CanvasDoc, EdgePhase, EtherFlag } from "@shared/canvas";
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
import type { IntervalTimerState } from "@shared/scheduler-policy";
import type { ActorRefResolver } from "@shared/attention";
import {
  detectPulses,
  evaluateWatcherLevel,
  purgeCanvasEdgeMemory,
  resetWatcherMemory,
  type WatcherStatus,
} from "./evaluate";
import {
  collectWatchEdgesInto,
  combineWatchEvaluations,
  evaluateWatchWhen,
  NO_WATCH_YET_DETAIL,
  type PageLoadStatus,
} from "@shared/scheduler-effects";
import { isValidCronExpression, nextCronOccurrence } from "@shared/cron-expression";
import { applySchedulerFire } from "./effects";
import { liveSeatBlocksForCanvas } from "../work/blocked-seat";
import type { SnapshotState } from "../../../shared/entities";
import {
  CRON_ENABLED,
  RELAY_ENABLED,
  schedulerFeatureEnabled,
} from "@shared/features";

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
      flagOverrides: RuntimeFlagOverrides;
      execution?: ExecutionSnapshot;
    }
  >;
}

// --- injectable seams --------------------------------------------------------

export type RuntimeFlagOverrides = Record<
  string,
  Partial<Record<EtherFlag, boolean>>
>;

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

export interface TimerSchedulerDeps {
  readonly claimInterval: (
    input: SchedulerClaimInput,
  ) => Promise<SchedulerClaimResult>;
  readonly claimExpression: (input: {
    readonly homeStation: string;
    readonly timerKey: string;
    readonly scheduleId: string;
    readonly dueAtEpochMs: number;
    readonly nextDueAtEpochMs: number;
    readonly nowEpochMs: number;
  }) => Promise<
    | { readonly _tag: "Claimed"; readonly dueAtEpochMs: number; readonly nextDueAtEpochMs: number }
    | { readonly _tag: "Duplicate" }
    | { readonly _tag: "Ineligible"; readonly reason: string }
  >;
  readonly reconcileHome: (
    homeStation: string,
    activeTimerKeys: ReadonlyArray<string>,
  ) => Promise<number>;
  /** Read-only cursor for paused / non-automating canvases (no fire claim). */
  readonly readIntervalState: (
    homeStation: string,
    timerKey: string,
  ) => Promise<IntervalTimerState | undefined>;
}

/**
 * When false: sensors still project status/nextFire for UI, but must not
 * consume rising-edge memory or durable cron firing slots, and must not apply
 * effects. Wired from pause plane + station role.
 */
export interface AutomationGateDeps {
  readonly canAutomateCanvas: (canvasName: string) => boolean;
  readonly canApplyFlagEffects: () => boolean;
}

/**
 * Thin main→kernel page readiness map. Keys are `${canvasName}::${nodeId}`
 * (see pageLoadMapKey). Built from live browser sessions (onLoadOk/onLoadFail).
 */
export interface PageLoadDeps {
  readonly snapshot: () => ReadonlyMap<string, PageLoadStatus>;
}

// --- module-level state ------------------------------------------------------

let docs: Map<string, CanvasDoc> = new Map();
let snapshots: SnapshotState = { bundles: [] };
let flagWriterDeps: FlagWriterDeps | undefined = undefined;
let timerSchedulerDeps: TimerSchedulerDeps | undefined = undefined;
let automationGateDeps: AutomationGateDeps | undefined = undefined;
let pageLoadDeps: PageLoadDeps | undefined = undefined;
let resolveActorRef: ActorRefResolver = () => undefined;
const runtimeFlagOverrides = new Map<
  string,
  Map<string, Map<EtherFlag, boolean>>
>();

const canAutomateCanvas = (canvasName: string): boolean =>
  automationGateDeps?.canAutomateCanvas(canvasName) ?? false;

const canApplyFlagEffects = (): boolean =>
  automationGateDeps?.canApplyFlagEffects() ?? false;

export const __setDocsForTest = (docsMap: Map<string, CanvasDoc>): void => {
  docs = docsMap;
  reconcileRuntimeFlagOverrides(docsMap);
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

export const __setTimerSchedulerForTest = (
  deps: TimerSchedulerDeps | undefined,
): void => {
  timerSchedulerDeps = deps;
};

export const __setAutomationGateForTest = (
  deps: AutomationGateDeps | undefined,
): void => {
  automationGateDeps = deps;
};

/** Production + test injection for the live browser page load map. */
export const __setPageLoadForTest = (deps: PageLoadDeps | undefined): void => {
  pageLoadDeps = deps;
};

export const setPageLoadDeps = (deps: PageLoadDeps | undefined): void => {
  pageLoadDeps = deps;
};

export const __resetKernelMemoryForTest = (): void => {
  docs = new Map();
  snapshots = { bundles: [] };
  flagWriterDeps = undefined;
  timerSchedulerDeps = undefined;
  automationGateDeps = undefined;
  pageLoadDeps = undefined;
  resolveActorRef = () => undefined;
  runtimeFlagOverrides.clear();
  nextFire.clear();
  executionByCanvas.clear();
  resetWatcherMemory();
};

const flagsWithOverrides = (
  authored: ReadonlyArray<EtherFlag>,
  overrides: ReadonlyMap<EtherFlag, boolean> | undefined,
): ReadonlyArray<EtherFlag> => {
  if (overrides === undefined || overrides.size === 0) return authored;
  const effective = new Set(authored);
  for (const [flag, enabled] of overrides) {
    if (enabled) effective.add(flag);
    else effective.delete(flag);
  }
  return [...effective];
};

/**
 * Pure document flag write — same truth as renderer toggleFlag / setFlagForNodes.
 * Used by scheduler set_flag and flagOnUnsatisfied on Command Center.
 * Returns the input doc unchanged when the target node is missing.
 */
export const applyNodeFlag = (
  doc: CanvasDoc,
  nodeId: string,
  flag: EtherFlag,
  enabled: boolean,
): CanvasDoc => {
  if (!doc.nodes.some((node) => node.id === nodeId)) return doc;
  return {
    ...doc,
    nodes: doc.nodes.map((node) => {
      if (node.id !== nodeId) return node;
      const flags = new Set<EtherFlag>(node.ether?.flags ?? []);
      if (enabled) flags.add(flag);
      else flags.delete(flag);
      const nextFlags = [...flags];
      const ether = { ...(node.ether ?? {}) };
      if (nextFlags.length === 0) delete ether.flags;
      else ether.flags = nextFlags;
      if (Object.keys(ether).length > 0) return { ...node, ether };
      const { ether: _drop, ...withoutEther } = node;
      return withoutEther;
    }),
  };
};

/** Runtime scheduler state projected over authorial intent, never persisted. */
export const projectRuntimeFlags = (
  canvasName: string,
  doc: CanvasDoc,
): CanvasDoc => {
  const byNode = runtimeFlagOverrides.get(canvasName);
  if (byNode === undefined || byNode.size === 0) return doc;
  return {
    ...doc,
    nodes: doc.nodes.map((node) => {
      const overrides = byNode.get(node.id);
      if (overrides === undefined || overrides.size === 0) return node;
      const flags = flagsWithOverrides(node.ether?.flags ?? [], overrides);
      const ether = { ...(node.ether ?? {}) };
      if (flags.length === 0) delete ether.flags;
      else ether.flags = flags;
      if (Object.keys(ether).length > 0) return { ...node, ether };
      const { ether: _drop, ...withoutEther } = node;
      return withoutEther;
    }),
  };
};

/**
 * Process-local flag projection for mid-cycle eval before durable resync.
 * Product truth for set_flag is applyNodeFlag + CanvasesService.mutate; this
 * stays available so the evaluation loop can see the write in the same tick.
 */
export const setRuntimeFlag = (
  canvasName: string,
  nodeId: string,
  flag: EtherFlag,
  enabled: boolean,
): boolean => {
  const doc = docs.get(canvasName);
  if (doc === undefined || !doc.nodes.some((node) => node.id === nodeId)) {
    return false;
  }
  let byNode = runtimeFlagOverrides.get(canvasName);
  if (byNode === undefined) {
    byNode = new Map();
    runtimeFlagOverrides.set(canvasName, byNode);
  }
  let overrides = byNode.get(nodeId);
  if (overrides === undefined) {
    overrides = new Map();
    byNode.set(nodeId, overrides);
  }
  overrides.set(flag, enabled);
  return true;
};

/** Drop one process-local override so durable document flags are sole truth. */
export const clearRuntimeFlag = (
  canvasName: string,
  nodeId: string,
  flag: EtherFlag,
): void => {
  const byNode = runtimeFlagOverrides.get(canvasName);
  if (byNode === undefined) return;
  const overrides = byNode.get(nodeId);
  if (overrides === undefined) return;
  overrides.delete(flag);
  if (overrides.size === 0) byNode.delete(nodeId);
  if (byNode.size === 0) runtimeFlagOverrides.delete(canvasName);
};

export const getRuntimeFlagOverrides = (
  canvasName: string,
): RuntimeFlagOverrides => {
  const result: RuntimeFlagOverrides = {};
  for (const [nodeId, overrides] of runtimeFlagOverrides.get(canvasName) ?? []) {
    result[nodeId] = Object.fromEntries(overrides);
  }
  return result;
};

const reconcileRuntimeFlagOverrides = (
  documents: ReadonlyMap<string, CanvasDoc>,
): void => {
  for (const [canvasName, byNode] of runtimeFlagOverrides) {
    const doc = documents.get(canvasName);
    if (doc === undefined) {
      runtimeFlagOverrides.delete(canvasName);
      continue;
    }
    const nodeIds = new Set(doc.nodes.map((node) => node.id));
    for (const nodeId of byNode.keys()) {
      if (!nodeIds.has(nodeId)) byNode.delete(nodeId);
    }
    if (byNode.size === 0) runtimeFlagOverrides.delete(canvasName);
  }
};

export const getKernelSnapshot = (): KernelSnapshot => {
  const canvases: Record<
    string,
    {
      watchers: Record<string, WatcherRuntimeState>;
      nextFire: Record<string, number>;
      flagOverrides: RuntimeFlagOverrides;
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
      const effectiveDoc = projectRuntimeFlags(canvasName, doc);
      const execution = snapshotFromGraph(canvasName, effectiveDoc);
      executionByCanvas.set(canvasName, execution);

      const automate = canAutomateCanvas(canvasName);
      if (RELAY_ENABLED) for (const { nodeId, watch, result } of detectPulses(canvasName, effectiveDoc, snapshots, {
        consumeEdge: automate,
      })) {
        const source = effectiveDoc.nodes.find((node) => node.id === nodeId);
        // Host-scoped: this station only runs executable nodes assigned to it.
        if (source !== undefined && !isNodeEligibleOnStation(source, stationHostId)) {
          continue;
        }
        const watcherKey = `${canvasName}::${nodeId}`;
        const previous = watchers.get(watcherKey);
        const nextRuntime: WatcherRuntimeState = {
          status: result.state.status,
          detail: result.state.detail,
          ...(result.fired
            ? { lastFiredAt: Date.now() }
            : previous?.lastFiredAt !== undefined
              ? { lastFiredAt: previous.lastFiredAt }
              : {}),
        };
        watchers.set(watcherKey, nextRuntime);

        // Runtime flag effects remain CC-only and respect the automation gate.
        if (automate && canApplyFlagEffects()) {
          applyFlagOnUnsatisfied(
            canvasName,
            effectiveDoc,
            nodeId,
            watch.flagOnUnsatisfied,
            result.state.status,
          );
        }
        if (result.fired) {
          await applySchedulerFire(effectiveDoc, {
            canvasName,
            sourceNodeId: nodeId,
            kind: "gauge",
            fireKey: `gauge:${watcherKey}:${nextRuntime.lastFiredAt ?? Date.now()}`,
            status: result.state.status,
          });
        }
      }

      if (!RELAY_ENABLED) continue;

      // Page readiness: canvas-scoped slice of the live browser load map.
      const pageLoadGlobal = pageLoadDeps?.snapshot();
      const pageLoadByNodeId = new Map<string, PageLoadStatus>();
      if (pageLoadGlobal !== undefined && pageLoadGlobal.size > 0) {
        const prefix = `${canvasName}::`;
        for (const [key, status] of pageLoadGlobal) {
          if (!key.startsWith(prefix)) continue;
          pageLoadByNodeId.set(key.slice(prefix.length), status);
        }
      }
      const watchContext =
        pageLoadByNodeId.size > 0
          ? { pageLoadByNodeId }
          : undefined;

      // Relay: watch is sink → relay wires only (`when` / default completes).
      for (const node of effectiveDoc.nodes) {
        if (node.type !== "text" || node.ether?.entity?.kind !== "relay") continue;
        if (!isNodeEligibleOnStation(node, stationHostId)) continue;
        const watchEdges = collectWatchEdgesInto(effectiveDoc, node.id);
        const evaluation =
          watchEdges.length > 0
            ? combineWatchEvaluations(
                watchEdges.map((w) =>
                  evaluateWatchWhen(w.source, w.when, watchContext),
                ),
              )
            : ({
                status: "unknown" as const,
                detail: NO_WATCH_YET_DETAIL,
              });
        const result = evaluateWatcherLevel(canvasName, node.id, evaluation, {
          consumeEdge: automate,
        });
        const watcherKey = `${canvasName}::${node.id}`;
        const previous = watchers.get(watcherKey);
        const nextRuntime: WatcherRuntimeState = {
          status: result.state.status,
          detail: result.state.detail,
          ...(result.fired
            ? { lastFiredAt: Date.now() }
            : previous?.lastFiredAt !== undefined
              ? { lastFiredAt: previous.lastFiredAt }
              : {}),
        };
        watchers.set(watcherKey, nextRuntime);
        if (result.fired) {
          await applySchedulerFire(effectiveDoc, {
            canvasName,
            sourceNodeId: node.id,
            kind: "relay",
            fireKey: `relay:${watcherKey}:${nextRuntime.lastFiredAt ?? Date.now()}`,
            status: result.state.status,
          });
        }
      }
    } catch (err) {
      // One bad doc never stalls the rest — swallow, mark degraded, continue
      console.error(`Kernel evaluation failed for canvas "${canvasName}":`, err);
    }
  }
};

// --- timer scheduling ----------------------------------------------------------
// Crontab expression (preferred) or legacy everyMinutes → expression.
// Durable at-most-once via scheduler_interval_firings claim slots.
export const isValidTimerInterval = (everyMinutes: number): boolean =>
  Number.isFinite(everyMinutes) &&
  everyMinutes > 0 &&
  Number.isSafeInteger(everyMinutes * 60_000);

export const checkTimers = async (
  nowEpochMs = Date.now(),
): Promise<void> => {
  if (!CRON_ENABLED) {
    nextFire.clear();
    return;
  }
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

      const home = resolveNodeHostId(node);

      const cronExpression = timer.expression?.trim();
      if (
        typeof cronExpression === "string" &&
        cronExpression.length > 0 &&
        isValidCronExpression(cronExpression)
      ) {
        try {
          // Coalesce: walk to the latest due occurrence ≤ now (at most a few steps).
          let due = nextCronOccurrence(cronExpression, nowEpochMs - 60_000 * 24 * 7);
          if (due === undefined) {
            nextFire.delete(timerKey);
            continue;
          }
          // Advance while the following occurrence is still in the past.
          for (let i = 0; i < 500; i += 1) {
            const following = nextCronOccurrence(cronExpression, due);
            if (following === undefined || following > nowEpochMs) break;
            due = following;
          }
          const nextAfterDue = nextCronOccurrence(cronExpression, due);
          if (due > nowEpochMs) {
            nextFire.set(timerKey, due);
            continue;
          }
          // Due now.
          nextFire.set(timerKey, due);
          if (!canAutomateCanvas(canvasName)) continue;
          if (nextAfterDue === undefined) continue;
          const claimed = await timerSchedulerDeps.claimExpression({
            homeStation: home,
            timerKey,
            scheduleId: `cron:${cronExpression}`.slice(0, 256),
            dueAtEpochMs: due,
            nextDueAtEpochMs: nextAfterDue,
            nowEpochMs,
          });
          if (claimed._tag === "Claimed") {
            nextFire.set(timerKey, claimed.nextDueAtEpochMs);
            await applySchedulerFire(doc, {
              canvasName,
              sourceNodeId: node.id,
              kind: "cron",
              fireKey: `cron:${home}:${timerKey}:${claimed.dueAtEpochMs}`,
              status: "satisfied",
            });
            // Project lastFiredAt so the renderer can spark cron→target edges
            // (same channel as relay/gauge watchers).
            const previous = watchers.get(timerKey);
            watchers.set(timerKey, {
              status: "satisfied",
              detail: previous?.detail ?? "cron fired",
              lastFiredAt: Date.now(),
            });
          } else if (claimed._tag === "Duplicate") {
            nextFire.set(timerKey, nextAfterDue);
          } else {
            nextFire.delete(timerKey);
            console.error(
              `[kernel] expression timer ${timerKey} ineligible (${claimed.reason})`,
            );
          }
        } catch (error) {
          nextFire.delete(timerKey);
          console.error(
            `[kernel] expression timer claim failed for ${timerKey}:`,
            error,
          );
        }
        continue;
      }

      if (typeof timer.everyMinutes === "number" && isValidTimerInterval(timer.everyMinutes)) {
        try {
          const requestedInterval = timer.everyMinutes * 60_000;
          const existing = await timerSchedulerDeps.readIntervalState(home, timerKey);
          const shouldClaim =
            existing === undefined ||
            existing.intervalMilliseconds !== requestedInterval ||
            (existing.nextDueAtEpochMs <= nowEpochMs &&
              canAutomateCanvas(canvasName));
          if (!shouldClaim) {
            nextFire.set(timerKey, existing.nextDueAtEpochMs);
            continue;
          }
          const claimed = await timerSchedulerDeps.claimInterval({
            timerKey,
            localStationId: stationHostId,
            homeStationIds: [home],
            nowEpochMs,
            everyMinutes: timer.everyMinutes,
          });
          if (claimed._tag === "Ineligible") {
            nextFire.delete(timerKey);
            console.error(
              `[kernel] interval timer ${timerKey} ineligible (${claimed.reason})`,
            );
          } else if (
            claimed._tag === "Initialized" ||
            claimed._tag === "NotDue"
          ) {
            nextFire.set(timerKey, claimed.state.nextDueAtEpochMs);
          } else if (claimed._tag === "Firing") {
            nextFire.set(timerKey, claimed.nextState.nextDueAtEpochMs);
            await applySchedulerFire(doc, {
              canvasName,
              sourceNodeId: node.id,
              kind: "cron",
              fireKey: `cron:${home}:${timerKey}:${claimed.scheduledForEpochMs}`,
              status: "satisfied",
            });
            // Project lastFiredAt so the renderer can spark cron→target edges
            // (same channel as relay/gauge watchers).
            const previous = watchers.get(timerKey);
            watchers.set(timerKey, {
              status: "satisfied",
              detail: previous?.detail ?? "cron fired",
              lastFiredAt: Date.now(),
            });
          }
        } catch (error) {
          nextFire.delete(timerKey);
          console.error(
            `[kernel] interval timer claim failed for ${timerKey}:`,
            error,
          );
        }
        continue;
      }

      // No valid schedule.
      if (nextFire.has(timerKey)) nextFire.delete(timerKey);
      console.error(
        `[kernel] invalid timer schedule on ${timerKey} — disabled until fixed`,
      );
    }
  }
};

// --- utility exports (for tests) -----------------------------------------------

/**
 * Operator / agent-triggered fire for one selected scheduler.
 * Applies that node's outbound `does` edges only (never other schedulers,
 * never watch inputs, never trigger-chain walks). Unique fireKey; no
 * rising-edge gate. Canvas must be hydrated and playing.
 */
export type ManualSchedulerFireResult =
  | {
      readonly ok: true;
      readonly sourceNodeId: string;
      readonly kind: "relay" | "cron" | "gauge";
      readonly applied: number;
      readonly message: string;
    }
  | { readonly ok: false; readonly message: string };

const resolveManualFireKind = (
  node: { readonly ether?: { readonly entity?: { readonly kind?: string } } },
  preferred?: "relay" | "cron" | "gauge",
): "relay" | "cron" | "gauge" | undefined => {
  if (preferred) return preferred;
  const entityKind = node.ether?.entity?.kind;
  if (entityKind === "cron" || entityKind === "timer") return "cron";
  if (entityKind === "watcher" || entityKind === "gauge") return "gauge";
  if (entityKind === "relay") return "relay";
  return undefined;
};

const runManualSchedulerFire = async (input: {
  readonly canvasName: string;
  readonly sourceNodeId: string;
  readonly kind?: "relay" | "cron" | "gauge";
  readonly overseer?: { readonly liveGrant: () => Promise<boolean> };
}): Promise<ManualSchedulerFireResult> => {
  const doc = docs.get(input.canvasName);
  if (!doc) {
    return { ok: false, message: "canvas is not hydrated in the kernel" };
  }
  const node = doc.nodes.find((n) => n.id === input.sourceNodeId);
  if (!node) {
    return { ok: false, message: `node "${input.sourceNodeId}" not found` };
  }
  const kind = resolveManualFireKind(node, input.kind);
  if (!kind) {
    return {
      ok: false,
      message: `node "${input.sourceNodeId}" is not a scheduler (cron, relay, or gauge)`,
    };
  }
  if (!schedulerFeatureEnabled(kind)) {
    return {
      ok: false,
      message: `${kind} is disabled in this Vellum Command build`,
    };
  }
  const fireKey = `${input.overseer !== undefined ? "overseer" : "manual"}:${input.canvasName}::${input.sourceNodeId}:${Date.now()}`;
  const result = await applySchedulerFire(
    doc,
    {
      canvasName: input.canvasName,
      sourceNodeId: input.sourceNodeId,
      kind,
      fireKey,
      status: "satisfied",
    },
    input.overseer !== undefined ? { overseer: input.overseer } : undefined,
  );
  if (result.skipped === "paused") {
    return {
      ok: false,
      message:
        "Factory must be playing with a station role set before Fire now can run actions",
    };
  }
  if (result.skipped === "no_deps") {
    return {
      ok: false,
      message: "Scheduler effects are not wired in this runtime",
    };
  }
  if (result.skipped === "disabled") {
    return {
      ok: false,
      message: `${kind} is disabled in this Vellum Command build`,
    };
  }
  if (result.skipped === "revoked") {
    return {
      ok: false,
      message: "overseer grant revoked",
    };
  }
  if ((result.failed ?? 0) > 0 && result.applied === 0) {
    return {
      ok: false,
      message: "Wired scheduler effects failed to apply",
    };
  }
  if (result.skipped === "no_effects" || result.applied === 0) {
    return {
      ok: true,
      sourceNodeId: input.sourceNodeId,
      kind,
      applied: 0,
      message: `No effect wires from this ${kind} yet`,
    };
  }
  return {
    ok: true,
    sourceNodeId: input.sourceNodeId,
    kind,
    applied: result.applied,
    message:
      result.applied === 1
        ? `Ran 1 action from this ${kind}`
        : `Ran ${result.applied} actions from this ${kind}`,
  };
};

export const manualSchedulerFire = async (input: {
  readonly canvasName: string;
  readonly sourceNodeId: string;
  readonly kind?: "relay" | "cron" | "gauge";
}): Promise<ManualSchedulerFireResult> => runManualSchedulerFire(input);

/**
 * Overseer-admitted fire. Pause/play has no bearing; feature gates, node
 * kind, effect wiring, and role-owned effects still apply.
 */
export const overseerSchedulerFire = async (input: {
  readonly canvasName: string;
  readonly sourceNodeId: string;
  readonly kind?: "relay" | "cron" | "gauge";
  readonly liveGrant: () => Promise<boolean>;
}): Promise<ManualSchedulerFireResult> =>
  runManualSchedulerFire({
    canvasName: input.canvasName,
    sourceNodeId: input.sourceNodeId,
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    overseer: { liveGrant: input.liveGrant },
  });

export const setDocs = (docsMap: Map<string, CanvasDoc>): void => {
  docs = docsMap;
  reconcileRuntimeFlagOverrides(docsMap);
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
  runtimeFlagOverrides.delete(canvasName);
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

// Per-cycle reconcile for canvases that STILL exist but whose gauge/cron/relay
// nodes changed underneath us. Drops stale `${canvasName}::${nodeId}` entries.
export const reconcileLiveCanvasMemory = (): void => {
  reconcileRuntimeFlagOverrides(docs);
  const hasSensor = (canvasName: string, nodeId: string): boolean => {
    const doc = docs.get(canvasName);
    if (!doc) return false;
    return doc.nodes.some((node) => {
      if (node.id !== nodeId || node.type !== "text") return false;
      const kind = node.ether?.entity?.kind;
      return (
        kind === "relay" ||
        kind === "watcher" ||
        node.ether?.watch !== undefined
      );
    });
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
    if (!hasSensor(split[0], split[1])) watchers.delete(key);
  }
  for (const key of [...nextFire.keys()]) {
    const split = splitNamespacedKey(key);
    if (!split || !docs.has(split[0])) continue;
    if (!hasTimer(split[0], split[1])) nextFire.delete(key);
  }
};
