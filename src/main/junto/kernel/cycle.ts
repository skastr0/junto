// The kernel evaluation cycle. Gauge/relay status, cron claim/nextFire,
// scheduler edge effects and execution graph live here.
// Region pulse inject is retired — effects are compiled from the edge's verb
// (enqueues / wakes), never geometry fan-out. Edge phase is derived on
// every read and never mirrored back into the document, so the cycle has no
// phase to write.

import type { WirePhase } from "@shared/model";
import type { NodeId } from "@shared/model/base";
import { nodesOf } from "@shared/model/canvas";
import {
  deriveExecutionGraph,
  type BlockedReason,
} from "@shared/execution-graph";
import {
  DEFAULT_STATION_HOST_ID,
  isStationRole,
  type StationRole,
} from "@shared/station";
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
import {
  applySchedulerFire,
  schedulerKindOf,
  type OverseerFireAuthority,
} from "./effects";
import { workOf, type World } from "./world";
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
  readonly phaseByEdgeId: Record<string, WirePhase>;
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

export interface TimerSchedulerDeps {
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
}

/**
 * When false: sensors still project status/nextFire for UI, but must not
 * consume rising-edge memory or durable cron firing slots, and must not apply
 * effects. Wired from pause plane + station role.
 */
export interface AutomationGateDeps {
  readonly canAutomateCanvas: (canvasName: string) => boolean;
}

/**
 * Thin main→kernel page readiness map. Keys are `${canvasName}::${nodeId}`
 * (see pageLoadMapKey). Built from live browser sessions (onLoadOk/onLoadFail).
 */
export interface PageLoadDeps {
  readonly snapshot: () => ReadonlyMap<string, PageLoadStatus>;
}

/**
 * Thin main→kernel map of raised hands: agent seats with an open blocked or
 * escalate signal, as document-local node ids for one canvas. An agent's
 * `announces` wire into a relay watches this.
 */
export interface RaisedHandDeps {
  readonly snapshot: (canvasName: string) => ReadonlySet<string>;
}

// --- module-level state ------------------------------------------------------

let worlds: Map<string, World> = new Map();
let snapshots: SnapshotState = { bundles: [] };
let timerSchedulerDeps: TimerSchedulerDeps | undefined = undefined;
let automationGateDeps: AutomationGateDeps | undefined = undefined;
let pageLoadDeps: PageLoadDeps | undefined = undefined;
let raisedHandDeps: RaisedHandDeps | undefined = undefined;
let resolveActorRef: ActorRefResolver = () => undefined;

const canAutomateCanvas = (canvasName: string): boolean =>
  automationGateDeps?.canAutomateCanvas(canvasName) ?? false;

export const __setWorldsForTest = (held: Map<string, World>): void => {
  worlds = held;
};

export const __setSnapshotsForTest = (state: SnapshotState): void => {
  snapshots = state;
};

export const setActorRefResolver = (resolver: ActorRefResolver): void => {
  resolveActorRef = resolver;
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

/** Production + test injection for the raised-hand map. */
export const setRaisedHandDeps = (deps: RaisedHandDeps | undefined): void => {
  raisedHandDeps = deps;
};

export const __resetKernelMemoryForTest = (): void => {
  worlds = new Map();
  snapshots = { bundles: [] };
  timerSchedulerDeps = undefined;
  automationGateDeps = undefined;
  pageLoadDeps = undefined;
  raisedHandDeps = undefined;
  resolveActorRef = () => undefined;
  nextFire.clear();
  executionByCanvas.clear();
  resetWatcherMemory();
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

// Per-canvas derived execution graphs (recomputed each evaluation cycle).
const executionByCanvas = new Map<string, ExecutionSnapshot>();

export const getExecutionByCanvas = (): ReadonlyMap<string, ExecutionSnapshot> =>
  executionByCanvas;

const snapshotFromGraph = (
  canvasName: string,
  world: World,
): ExecutionSnapshot => {
  const graph = deriveExecutionGraph(world.canvas, {
    canvasName,
    resolveActorRef,
    itemsOf: workOf(world).itemsOf,
  });
  const phaseByEdgeId: Record<string, WirePhase> = {};
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
  for (const [canvasName, world] of worlds.entries()) {
    const { canvas } = world;
    try {
      const execution = snapshotFromGraph(canvasName, world);
      executionByCanvas.set(canvasName, execution);

      const automate = canAutomateCanvas(canvasName);
      if (RELAY_ENABLED) for (const { nodeId, watch, result } of detectPulses(canvasName, canvas, snapshots, {
        consumeEdge: automate,
      })) {
        // Host-scoped: this station only runs the schedulers assigned to it.
        if (watch.host !== stationHostId) continue;
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

        if (result.fired) {
          await applySchedulerFire(canvas, {
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
      const raisedHandNodeIds = raisedHandDeps?.snapshot(canvasName);
      const watchContext = {
        ...(pageLoadByNodeId.size > 0 ? { pageLoadByNodeId } : {}),
        ...(raisedHandNodeIds !== undefined && raisedHandNodeIds.size > 0
          ? { raisedHandNodeIds }
          : {}),
      };

      // Relay: watch is sink → relay wires only (`when` / default completes).
      for (const node of nodesOf(canvas, "relay")) {
        if (node.host !== stationHostId) continue;
        const watchEdges = collectWatchEdgesInto(canvas, node.id);
        const evaluation =
          watchEdges.length > 0
            ? combineWatchEvaluations(
                watchEdges.map((w) =>
                  evaluateWatchWhen(
                    w.source,
                    w.when,
                    workOf(world),
                    watchContext,
                  ),
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
          await applySchedulerFire(canvas, {
            canvasName,
            sourceNodeId: node.id,
            kind: "relay",
            fireKey: `relay:${watcherKey}:${nextRuntime.lastFiredAt ?? Date.now()}`,
            status: result.state.status,
          });
        }
      }
    } catch (err) {
      // One bad canvas never stalls the rest — swallow, mark degraded, continue
      console.error(`Kernel evaluation failed for canvas "${canvasName}":`, err);
    }
  }
};

// --- timer scheduling ----------------------------------------------------------
// A cron fires on its five-field expression. Durable at-most-once via claim
// slots; a cron with no expression yet does not fire.
export const checkTimers = async (
  nowEpochMs = Date.now(),
): Promise<void> => {
  if (!CRON_ENABLED) {
    nextFire.clear();
    return;
  }
  const crons = [...worlds.entries()].flatMap(([canvasName, { canvas }]) =>
    nodesOf(canvas, "cron")
      .filter((node) => node.host === stationHostId)
      .map((node) => ({ canvasName, canvas, node, timerKey: `${canvasName}::${node.id}` })),
  );
  const activeTimerKeys = crons.map(({ timerKey }) => timerKey);

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

  for (const { canvasName, canvas, node, timerKey } of crons) {
    const home = node.host;
    const cronExpression = node.expression?.trim();
    if (cronExpression === undefined || cronExpression.length === 0) {
      // Not given a schedule yet.
      nextFire.delete(timerKey);
      continue;
    }
    if (!isValidCronExpression(cronExpression)) {
      nextFire.delete(timerKey);
      console.error(
        `[kernel] invalid timer schedule on ${timerKey} — disabled until fixed`,
      );
      continue;
    }
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
        await applySchedulerFire(canvas, {
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

const runManualSchedulerFire = async (input: {
  readonly canvasName: string;
  readonly sourceNodeId: string;
  readonly kind?: "relay" | "cron" | "gauge";
  readonly overseer?: OverseerFireAuthority;
}): Promise<ManualSchedulerFireResult> => {
  const canvas = worlds.get(input.canvasName)?.canvas;
  if (!canvas) {
    return { ok: false, message: "canvas is not hydrated in the kernel" };
  }
  const node = canvas.nodes.get(input.sourceNodeId as NodeId);
  if (!node) {
    return { ok: false, message: `node "${input.sourceNodeId}" not found` };
  }
  const kind = input.kind ?? schedulerKindOf(node);
  if (!kind) {
    return {
      ok: false,
      message: `node "${input.sourceNodeId}" is not a scheduler (cron, relay, or gauge)`,
    };
  }
  if (!schedulerFeatureEnabled(kind)) {
    return {
      ok: false,
      message: `${kind} is disabled in this Junto build`,
    };
  }
  const fireKey = `${input.overseer !== undefined ? "overseer" : "manual"}:${input.canvasName}::${input.sourceNodeId}:${Date.now()}`;
  const result = await applySchedulerFire(
    canvas,
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
      message: `${kind} is disabled in this Junto build`,
    };
  }
  if (result.skipped === "revoked") {
    return {
      ok: false,
      message: "overseer grant revoked",
    };
  }
  if ((result.failed ?? 0) > 0) {
    return {
      ok: false,
      message:
        result.applied > 0
          ? "Wired scheduler effects failed after a partial apply"
          : "Wired scheduler effects failed to apply",
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

/** The kernel service owns this map and changes it in place. */
export const setWorlds = (held: Map<string, World>): void => {
  worlds = held;
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

// Per-cycle reconcile for canvases that STILL exist but whose gauge/cron/relay
// nodes changed underneath us. Drops stale `${canvasName}::${nodeId}` entries.
export const reconcileLiveCanvasMemory = (): void => {
  const kindAt = (canvasName: string, nodeId: string) =>
    worlds.get(canvasName)?.canvas.nodes.get(nodeId as NodeId)?.kind;
  const hasSensor = (canvasName: string, nodeId: string): boolean => {
    const kind = kindAt(canvasName, nodeId);
    return kind === "relay" || kind === "watcher";
  };
  const hasTimer = (canvasName: string, nodeId: string): boolean =>
    kindAt(canvasName, nodeId) === "cron";
  for (const key of [...watchers.keys()]) {
    const split = splitNamespacedKey(key);
    if (!split || !worlds.has(split[0])) continue;
    if (!hasSensor(split[0], split[1])) watchers.delete(key);
  }
  for (const key of [...nextFire.keys()]) {
    const split = splitNamespacedKey(key);
    if (!split || !worlds.has(split[0])) continue;
    if (!hasTimer(split[0], split[1])) nextFire.delete(key);
  }
};
