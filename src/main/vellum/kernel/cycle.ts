// The kernel loop + delivery cycle. This handles evaluation over multiple
// canvases with per-canvas isolation and injectable dependencies for
// testability. All side-effects (glyph fetching, pulse delivery, document
// writes) are behind injectable seams.

import { ulid } from "ulid";
import { applyPhaseMirror, type CanvasDoc, type EdgePhase, type GroupNode } from "@shared/canvas";
import {
  composeRegionExecutionContext,
  deriveExecutionGraph,
  type BlockedReason,
} from "@shared/execution-graph";
import { groupMembers, isGroup } from "@shared/graph";
import { resolveSpec, roleOf } from "@shared/physics";
import type { TowerGlyphRow } from "@shared/ipc";
import { actorDeliverySurfaceOf } from "@shared/actor-surface";
import {
  agentKeysForExecutableSource,
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
  evaluateWatcher,
  purgeCanvasEdgeMemory,
  resetWatcherMemory,
  type GlyphIndex,
  type WatcherStatus,
} from "./evaluate";
import { findEntity, type SnapshotState } from "../../../shared/entities";

// --- frozen interface --------------------------------------------------------

export interface WatcherRuntimeState {
  status: "satisfied" | "pending" | "unknown";
  detail: string;
  lastFiredAt?: number;
}

export interface PulseRecord {
  id: string;
  at: number;
  sourceNodeId: string;
  regionId?: string;
  kind: "watcher" | "timer" | "manual";
  summary: string;
  delivered: ReadonlyArray<string>;
  dry: boolean;
  canvasName: string;
}

/** Serializable per-canvas execution graph for renderer projection. */
export interface ExecutionSnapshot {
  readonly phaseByEdgeId: Record<string, EdgePhase>;
  readonly detailByEdgeId: Record<string, string>;
  readonly blocked: ReadonlyArray<string>;
  readonly blockedEdgeIds: ReadonlyArray<string>;
  readonly reasonsByNodeId: Record<string, ReadonlyArray<BlockedReason>>;
}

export interface KernelSnapshot {
  canvases: Record<
    string,
    {
      watchers: Record<string, WatcherRuntimeState>;
      armed: Record<string, boolean>;
      nextFire: Record<string, number>;
      execution?: ExecutionSnapshot;
    }
  >;
  pulseLog: ReadonlyArray<PulseRecord>;
}

// --- region geometry (derived, never persisted) ------------------------------

// Membership is the single shared authority (I9, `groupMembers` in
// shared/graph.ts, full-rect containment) — no local copy here.

// Reverse lookup over the shared membership map: keep the groups whose
// derived membership includes this node, and pick the smallest-area match —
// the innermost region wins when regions nest.
const findContainingRegionId = (doc: CanvasDoc, nodeId: string): string | undefined => {
  const members = groupMembers(doc);
  let best: GroupNode | undefined;
  for (const node of doc.nodes) {
    if (node.type !== "group") continue;
    if (!(members.get(node.id) ?? []).includes(nodeId)) continue;
    if (!best || node.width * node.height < best.width * best.height) best = node;
  }
  return best?.id;
};

/** Role decides who is a seat — never a kind string compared here. */
const isActorNode = (node: CanvasDoc["nodes"][number]): boolean =>
  roleOf(resolveSpec({ kind: node.ether?.entity?.kind, isGroup: isGroup(node) })) ===
  "actor";

// Region members bound to a hermes agent, in document order. Membership
// itself is geometry-derived (never persisted); the hermes binding's
// ref.key is the agent key.
const agentKeysInRegion = (doc: CanvasDoc, regionId: string): ReadonlyArray<string> => {
  const region = doc.nodes.find((node): node is GroupNode => node.id === regionId && node.type === "group");
  if (!region) return [];
  const memberIds = new Set(groupMembers(doc).get(regionId) ?? []);
  const keys: string[] = [];
  for (const node of doc.nodes) {
    if (!memberIds.has(node.id)) continue;
    const entity = node.ether?.entity;
    if (isActorNode(node) && entity?.name) keys.push(entity.name);
  }
  return keys;
};

// --- pulse message ------------------------------------------------------------
// "[pulse] <summary>" + optional region.instruction. Live execution context
// (edges, blocked reasons, task lists) is appended as its own block so the
// operator briefing stays distinct from derived graph state.
export const composePulseMessage = (summary: string, instruction?: string): string =>
  instruction ? `[pulse] ${summary}\n\n${instruction}` : `[pulse] ${summary}`;

// --- delivery (injectable for testability) ------------------------------------

export interface PulseDeliverDeps {
  /**
   * Managed-terminal seats only (agent + ether.terminal.bindingId).
   * The one delivery path. Optional only so older tests that omit it simply
   * deliver nothing.
   */
  readonly sendManagedTerminal?: (
    bindingId: string,
    message: string,
  ) => Promise<boolean>;
}

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

// Operator-set spacing rule (2026-07-15, replacing an agent-invented 6/hr
// quota): a region that the operator armed fires as often as its watchers and
// timers say — the only catastrophe worth suppressing is seconds-level
// flapping (a watcher misfiring every evaluation pass). So live activations
// per (canvas, region) are spaced at least MIN_LIVE_PULSE_SPACING_MS apart; a
// 5-minute-or-slower cadence flows completely untouched.
export const MIN_LIVE_PULSE_SPACING_MS = 5 * 60 * 1000;
// Display-tray retention floor. appendPulseRecord additionally retains every
// record inside the spacing window at any volume, so a flood of records can
// never evict the one live record the cooldown check needs (which would make
// the spacing rule fail open). A record is dropped only when it is BOTH older
// than the spacing window AND beyond the newest PULSE_LOG_DISPLAY_CAP.
const PULSE_LOG_DISPLAY_CAP = 200;

// --- module-level state (injected for tests) ---------------------------------

let docs: Map<string, CanvasDoc> = new Map();
let snapshots: SnapshotState = { bundles: [] };
let armed: Map<string, boolean> = new Map();
let pulseLog: PulseRecord[] = [];

let deliveryDeps: PulseDeliverDeps | undefined = undefined;
/** Pause plane lookup — a paused source forces every pulse dry (fail open = never). */
let pausedLookup: ((canvasName: string, sourceNodeId: string) => boolean) | undefined = undefined;
let flagWriterDeps: FlagWriterDeps | undefined = undefined;
let phaseMirrorDeps: PhaseMirrorDeps | undefined = undefined;
let timerSchedulerDeps: TimerSchedulerDeps | undefined = undefined;
let glyphFetcher: ((project: string) => Promise<ReadonlyArray<TowerGlyphRow> | undefined>) | undefined = undefined;
let resolveActorRef: ActorRefResolver = () => undefined;

// Test seams
export const setPausedLookup = (
  lookup: (canvasName: string, sourceNodeId: string) => boolean,
): void => {
  pausedLookup = lookup;
};

export const __setDocsForTest = (docsMap: Map<string, CanvasDoc>): void => {
  docs = docsMap;
};

export const __setSnapshotsForTest = (state: SnapshotState): void => {
  snapshots = state;
};

export const setActorRefResolver = (resolver: ActorRefResolver): void => {
  resolveActorRef = resolver;
};

export const setArmed = (key: string, value: boolean): void => {
  armed.set(key, value);
};

export const __setDeliveryDepsForTest = (deps: PulseDeliverDeps | undefined): void => {
  deliveryDeps = deps;
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

export const __setGlyphFetcherForTest = (fetcher: ((project: string) => Promise<ReadonlyArray<TowerGlyphRow> | undefined>) | undefined): void => {
  glyphFetcher = fetcher;
};

export const __resetKernelMemoryForTest = (): void => {
  docs = new Map();
  snapshots = { bundles: [] };
  armed = new Map();
  pulseLog = [];
  pendingPulseDeliveries.clear();
  queuedPulseDeliveryKeys.clear();
  deliveryDeps = undefined;
  flagWriterDeps = undefined;
  phaseMirrorDeps = undefined;
  timerSchedulerDeps = undefined;
  glyphFetcher = undefined;
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

export const __resetPulseLogForTest = (): void => {
  pulseLog = [];
};

export const getKernelSnapshot = (): KernelSnapshot => {
  const canvases: Record<string, { watchers: Record<string, WatcherRuntimeState>; armed: Record<string, boolean>; nextFire: Record<string, number> }> = {};
  // TODO: This would need to maintain the watcher state tracking
  // For now, return the basic structure
  return {
    canvases,
    pulseLog: [...pulseLog],
  };
};

// --- arming + state tracking -------------------------------------------------

// The most recent LIVE activation for a (canvas, region). A `dry: false`
// record marks a genuine live activation (the seat transport actually got
// driven, real cost incurred) even when every bound agent's turn ultimately
// failed — a flapping-but-failing region still restarts its spacing window
// ("failed" is not "free"). Scoped per (canvas, region): region ids are
// document-local, so the same id on two canvases is two distinct regions with
// independent spacing.
const lastLiveActivationAt = (canvasName: string, regionId: string): number | undefined => {
  let latest: number | undefined;
  for (const record of pulseLog) {
    if (record.canvasName !== canvasName || record.regionId !== regionId || record.dry) continue;
    if (latest === undefined || record.at > latest) latest = record.at;
  }
  return latest;
};

const appendPulseRecord = (record: PulseRecord): void => {
  const cutoff = record.at - MIN_LIVE_PULSE_SPACING_MS;
  const all = [...pulseLog, record];
  const keepFromIndex = Math.max(0, all.length - PULSE_LOG_DISPLAY_CAP);
  pulseLog = all.filter((entry, index) => entry.at >= cutoff || index >= keepFromIndex);
};

// --- station scope (Command Center / Remote) ---------------------------------
// Host-scoped execution: this station only evaluates/fires executable nodes
// stamped for its hostId. Role is user-selected (settings); never inferred.

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

// --- delivery ----------------------------------------------------------------

export interface DeliverPulseParams {
  readonly canvasName: string;
  readonly sourceNodeId: string;
  readonly kind: "watcher" | "timer" | "manual";
  readonly regionId: string | undefined;
  readonly summary: string;
  // Forces a DRY pulse regardless of arming (pulseRegion's manual override).
  readonly forceDry?: boolean;
  readonly deps?: PulseDeliverDeps;
}

interface DeliverPulseResult {
  readonly delivered: boolean;
  readonly dry: boolean;
}

// Scheduled activations coalesce by source. A timer's summary can change as
// missed slots accumulate, but there is still only one useful pending turn for
// that timer; manual operator pulses never enter the retry plane.
const scheduledPulseKey = (
  params: DeliverPulseParams,
): string | undefined =>
  params.kind === "manual"
    ? undefined
    : `${params.canvasName}::${params.sourceNodeId}::${params.kind}`;

const pendingPulseDeliveries = new Map<string, DeliverPulseParams>();
const queuedPulseDeliveryKeys = new Set<string>();

const setPendingPulseDelivery = (
  params: DeliverPulseParams,
  shouldRetry: boolean,
): void => {
  const key = scheduledPulseKey(params);
  if (key === undefined) return;
  if (!shouldRetry) {
    pendingPulseDeliveries.delete(key);
    return;
  }
  pendingPulseDeliveries.set(key, params);
};

const setWatcherLastFiredAt = (
  canvasName: string,
  sourceNodeId: string,
  at: number,
): void => {
  const key = `${canvasName}::${sourceNodeId}`;
  const prior = watchers.get(key);
  if (!prior) return;
  watchers.set(key, { ...prior, lastFiredAt: at });
};

const scheduledPulseSourceExists = (
  params: DeliverPulseParams,
): boolean => {
  const source = docs
    .get(params.canvasName)
    ?.nodes.find((node) => node.id === params.sourceNodeId);
  if (source?.type !== "text") return false;
  switch (params.kind) {
    case "watcher":
      return source.ether?.watch !== undefined;
    case "timer":
      return source.ether?.timer !== undefined;
    case "manual":
      return false;
  }
};

const scheduledPulseContextIsCurrent = (
  params: DeliverPulseParams,
): boolean => {
  const doc = docs.get(params.canvasName);
  return (
    doc !== undefined &&
    scheduledPulseSourceExists(params) &&
    findContainingRegionId(doc, params.sourceNodeId) === params.regionId
  );
};

interface ManagedPulseTarget {
  readonly key: string;
  readonly bindingId: string;
}

const managedTargetsForKeys = (
  doc: CanvasDoc,
  canvasName: string,
  keys: ReadonlyArray<string>,
): ReadonlyArray<ManagedPulseTarget> => {
  const targets: ManagedPulseTarget[] = [];
  for (const key of keys) {
    const actors = doc.nodes.filter(
      (node) =>
        isActorNode(node) &&
        node.ether?.entity?.name === key,
    );
    if (
      pausedLookup !== undefined &&
      actors.some((node) => pausedLookup?.(canvasName, node.id) ?? false)
    ) {
      continue;
    }
    const actor = actors[0];
    const surface = actor ? actorDeliverySurfaceOf(actor) : undefined;
    if (surface?._tag !== "managedAgent") continue;
    targets.push({ key, bindingId: surface.bindingId });
  }
  return targets;
};

const scheduledManagedTargets = (
  params: DeliverPulseParams,
): ReadonlyArray<ManagedPulseTarget> => {
  const doc = docs.get(params.canvasName);
  if (
    doc === undefined ||
    stationRole === "unset" ||
    !scheduledPulseContextIsCurrent(params)
  ) {
    return [];
  }
  return managedTargetsForKeys(
    doc,
    params.canvasName,
    agentKeysForExecutableSource(
      doc,
      params.sourceNodeId,
      stationRole,
      stationHostId,
    ),
  );
};

const scheduledPulseCanWait = (
  params: DeliverPulseParams,
): boolean => {
  if (
    scheduledPulseKey(params) === undefined ||
    params.forceDry === true ||
    !scheduledPulseContextIsCurrent(params) ||
    params.regionId === undefined ||
    !(armed.get(`${params.canvasName}::${params.regionId}`) ?? false) ||
    (pausedLookup?.(params.canvasName, params.sourceNodeId) ?? false) ||
    scheduledManagedTargets(params).length === 0
  ) {
    return false;
  }
  const lastLiveAt = lastLiveActivationAt(
    params.canvasName,
    params.regionId,
  );
  return (
    lastLiveAt === undefined ||
    Date.now() - lastLiveAt >= MIN_LIVE_PULSE_SPACING_MS
  );
};

// Single funnel for every pulse — watcher fire, timer tick, or manual. A
// regionless source (no containing group) always resolves dry with
// delivered: [] since there is no arming key to check.
export async function deliverPulse(params: DeliverPulseParams): Promise<DeliverPulseResult> {
  const deps = params.deps ?? deliveryDeps;

  const { regionId } = params;
  const armedKey = regionId !== undefined ? `${params.canvasName}::${regionId}` : undefined;
  const isArmed = armedKey !== undefined && (armed.get(armedKey) ?? false);
  const contextIsCurrent =
    params.kind === "manual" || scheduledPulseContextIsCurrent(params);
  const wantsLive =
    isArmed &&
    params.forceDry !== true &&
    contextIsCurrent;
  const lastLiveAt = wantsLive && regionId !== undefined ? lastLiveActivationAt(params.canvasName, regionId) : undefined;
  const cooling = lastLiveAt !== undefined && Date.now() - lastLiveAt < MIN_LIVE_PULSE_SPACING_MS;
  // Pause wins over arming: a paused source (node, region, or canvas) never
  // spends a live turn, exactly like an un-armed region.
  const paused = pausedLookup?.(params.canvasName, params.sourceNodeId) ?? false;
  const dry = paused || !wantsLive || cooling;

  let delivered: ReadonlyArray<string> = [];
  if (!dry) {
    const doc = docs.get(params.canvasName);
    if (doc) {
      const region =
        params.regionId !== undefined
          ? doc.nodes.find((node) => node.id === params.regionId)
          : undefined;
      const instruction =
        region?.type === "group" ? region.ether?.region?.instruction : undefined;
      const message = composePulseMessage(params.summary, instruction);

      // Primary fire routing: human edges from watcher/timer → agent.
      // Region membership alone does not fan out. Unset role fires nothing.
      let keys =
        stationRole === "unset"
          ? []
          : agentKeysForExecutableSource(
              doc,
              params.sourceNodeId,
              stationRole,
              stationHostId,
            );

      // Manual region pulse still uses region agents (operator intent), host-filtered on Remote.
      if (keys.length === 0 && params.kind === "manual" && params.regionId !== undefined) {
        keys =
          stationRole === "unset"
            ? []
            : agentKeysInRegion(doc, params.regionId).filter((key) => {
                if (stationRole === "command-center") return true;
                const agentNode = doc.nodes.find(
                  (node) => isActorNode(node) && node.ether?.entity?.name === key,
                );
                return (
                  agentNode !== undefined &&
                  isNodeEligibleOnStation(agentNode, stationHostId)
                );
              });
      }

      const targets = managedTargetsForKeys(
        doc,
        params.canvasName,
        keys,
      );

      let contextBlocks: ReadonlyArray<string> | undefined;
      if (params.regionId !== undefined && region?.type === "group") {
        const memberIds = groupMembers(doc).get(params.regionId) ?? [];
        const graph = deriveExecutionGraph(doc, {
          canvasName: params.canvasName,
          resolveActorRef,
        });
        const executionContext = composeRegionExecutionContext(
          doc,
          params.regionId,
          graph,
          memberIds,
        );
        contextBlocks = executionContext.length > 0 ? [executionContext] : undefined;
      }

      const fullMessage =
        contextBlocks && contextBlocks.length > 0
          ? `${message}\n\n${contextBlocks.join("\n\n")}`
          : message;

      const ok: string[] = [];
      for (const target of targets) {
        try {
          if (!deps?.sendManagedTerminal) continue;
          const sent = await deps.sendManagedTerminal(
            target.bindingId,
            fullMessage,
          );
          if (sent) ok.push(target.key);
        } catch {
          // Best-effort per agent: one failing delivery doesn't sink the rest.
        }
      }
      delivered = ok;
    }
  }

  // A pulse that found no deliverable seat did not spend a live turn yet.
  // It stays dry until the retry path actually drives at least one seat.
  const finalDry = dry || delivered.length === 0;
  const shouldRetry =
    delivered.length === 0 &&
    scheduledPulseCanWait(params);
  setPendingPulseDelivery(params, shouldRetry);

  const at = Date.now();
  if (delivered.length > 0) {
    switch (params.kind) {
      case "watcher":
        setWatcherLastFiredAt(params.canvasName, params.sourceNodeId, at);
        break;
      case "timer":
      case "manual":
        break;
    }
  }

  appendPulseRecord({
    id: `pulse-${ulid()}`,
    at,
    sourceNodeId: params.sourceNodeId,
    kind: params.kind,
    summary: cooling
      ? `${params.summary} (cooldown · 5m min spacing)`
      : shouldRetry
        ? `${params.summary} (delivery pending)`
        : params.summary,
    delivered,
    dry: finalDry,
    canvasName: params.canvasName,
    ...(regionId !== undefined ? { regionId } : {}),
  });

  return {
    delivered: delivered.length > 0,
    dry: finalDry,
  };
}

// --- pulse delivery queue (decoupled from the evaluation cycle) --------------
// A live pulse spends a real agent turn, bounded only by a 15-minute IPC
// ceiling (a turn may run tools for many minutes). If the
// evaluation cycle AWAITED delivery inline, one slow/hung agent would freeze
// watcher + timer detection across the WHOLE canvas — every region, not just
// the busy one, and defeating the 30s safety interval — until that turn
// returned. So deliveries are enqueued fire-and-forget and drained by a single
// serialized worker OFF the cycle's critical path: the evaluation loop completes
// on schedule regardless of a hung delivery, while serialized draining preserves
// per-region backpressure (one turn at a time, never a parallel fan-out) and
// keeps the hourly cap exact (each record appends before the next starts).
const pulseDeliveryQueue: DeliverPulseParams[] = [];
let deliveryDraining = false;

const drainPulseDeliveries = async (): Promise<void> => {
  if (deliveryDraining) return;
  deliveryDraining = true;
  try {
    while (pulseDeliveryQueue.length > 0) {
      const params = pulseDeliveryQueue.shift();
      if (params === undefined) break;
      const key = scheduledPulseKey(params);
      try {
        // Error capture: a failing — or forever-pending — delivery never sinks
        // the drain; the next queued pulse still gets its turn.
        await deliverPulse(params);
      } catch {
        setPendingPulseDelivery(params, scheduledPulseCanWait(params));
      } finally {
        // Keep the key held through the await: later kernel cycles must not
        // enqueue a duplicate while this transport decision is unresolved.
        if (key !== undefined) queuedPulseDeliveryKeys.delete(key);
      }
    }
  } finally {
    deliveryDraining = false;
  }
};

const enqueuePulseDelivery = (
  params: DeliverPulseParams,
  fromPending = false,
): boolean => {
  const key = scheduledPulseKey(params);
  if (key === undefined) {
    pulseDeliveryQueue.push(params);
    void drainPulseDeliveries();
    return true;
  }
  if (
    queuedPulseDeliveryKeys.has(key) ||
    (!fromPending && pendingPulseDeliveries.has(key))
  ) {
    return false;
  }
  queuedPulseDeliveryKeys.add(key);
  pulseDeliveryQueue.push(params);
  void drainPulseDeliveries();
  return true;
};

// Enqueues a region pulse for the node and returns immediately — the actual
// agent turn is delivered by the serialized worker above, never inline in the
// evaluation cycle. (Was `await deliverPulse(...)`; that await is exactly what
// let one 15-minute agent turn stall the whole kernel loop.)
const firePulseForNode = (canvasName: string, doc: CanvasDoc, nodeId: string, kind: "watcher" | "timer", summary: string): void => {
  enqueuePulseDelivery({
    canvasName,
    sourceNodeId: nodeId,
    kind,
    regionId: findContainingRegionId(doc, nodeId),
    summary,
    deps: deliveryDeps,
  });
};

// Reset delivery queue (test seam)
export const __resetDeliveryQueueForTest = (): void => {
  pulseDeliveryQueue.length = 0;
  deliveryDraining = false;
  queuedPulseDeliveryKeys.clear();
  pendingPulseDeliveries.clear();
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

const applyFlagOnUnsatisfied = (canvasName: string, doc: CanvasDoc, nodeId: string, flagOnUnsatisfied: boolean | undefined, status: WatcherStatus): void => {
  if (!flagOnUnsatisfied || !flagWriterDeps) return;
  const node = doc.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return;
  const hasFlag = node.ether?.flags?.includes("blocker") ?? false;
  if (flagShouldToggle(hasFlag, status)) {
    flagWriterDeps.setFlag(canvasName, nodeId, "blocker", status === "pending");
  }
};

// --- watcher glyph index (bridges its pure evaluator to the browse cache) ----
// Only fetches for projects a watcher in the current doc actually scopes to
// — never every bound project. A slow/hung fetch is bounded so a cycle
// never stalls the loop; the abandoned request still warms the cache
// in the background, so the next pass (interval or doc/snapshot
// change) tends to land it.
const GLYPH_FETCH_TIMEOUT_MS = 2_000;

// Per-canvas derived execution graphs (recomputed each evaluation cycle).
const executionByCanvas = new Map<string, ExecutionSnapshot>();

export const getExecutionByCanvas = (): ReadonlyMap<string, ExecutionSnapshot> => executionByCanvas;

const snapshotFromGraph = (
  canvasName: string,
  doc: CanvasDoc,
): ExecutionSnapshot => {
  const graph = deriveExecutionGraph(doc, {
    canvasName,
    resolveActorRef,
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

const relevantWatcherProjects = (doc: CanvasDoc): ReadonlySet<string> => {
  const projects = new Set<string>();
  for (const node of doc.nodes) {
    if (node.type !== "text") continue;
    const watch = node.ether?.watch;
    if (!watch?.project) continue;
    if (watch.kind === "glyphs_done" || watch.kind === "glyphs_entered_state") projects.add(watch.project);
  }
  return projects;
};

const fetchGlyphsBounded = async (project: string): Promise<ReadonlyArray<TowerGlyphRow> | undefined> => {
  if (!glyphFetcher) return undefined;
  const result = await Promise.race([
    glyphFetcher(project),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), GLYPH_FETCH_TIMEOUT_MS)),
  ]);
  return result ?? undefined;
};

// A canvas is expected to bind a handful of distinct projects, but nothing
// stops a pathological one from binding many — cap in-flight glyph fetches
// per cycle rather than fanning out unbounded Promise.all over every
// project a watcher scopes to.
const MAX_CONCURRENT_GLYPH_FETCHES = 4;

// --- evaluation cycle (multi-canvas with per-canvas isolation) ---------------

// Watcher runtime state tracking (keyed by canvasName::nodeId)
const watchers = new Map<string, WatcherRuntimeState>();
// Next fire times for timers (keyed by canvasName::nodeId)
const nextFire = new Map<string, number>();

// Exported for tests: lets a test drive exactly one evaluation pass and assert
// it completes even while a delivery pends.
export const runEvaluationCycle = async (): Promise<void> => {
  // Union of watcher-scoped projects across all canvases.
  const allProjects = new Set<string>();
  for (const doc of docs.values()) {
    for (const project of relevantWatcherProjects(doc)) allProjects.add(project);
  }

  const index = new Map<string, ReadonlyArray<TowerGlyphRow>>();
  const projects = Array.from(allProjects);
  for (let i = 0; i < projects.length; i += MAX_CONCURRENT_GLYPH_FETCHES) {
    const batch = projects.slice(i, i + MAX_CONCURRENT_GLYPH_FETCHES);
    await Promise.all(
      batch.map(async (project) => {
        const glyphRows = await fetchGlyphsBounded(project);
        if (glyphRows !== undefined) index.set(project, glyphRows);
      }),
    );
  }

  // Evaluate each canvas with per-canvas isolation
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

      for (const { nodeId, watch, result } of detectPulses(canvasName, doc, snapshots, index)) {
        const source = doc.nodes.find((node) => node.id === nodeId);
        // Host-scoped: this station only runs executable nodes assigned to it.
        if (source !== undefined && !isNodeEligibleOnStation(source, stationHostId)) {
          continue;
        }
        const watcherKey = `${canvasName}::${nodeId}`;
        const previous = watchers.get(watcherKey);
        const nextRuntime: WatcherRuntimeState = {
          status: result.state.status,
          detail: result.state.detail,
          ...(previous?.lastFiredAt !== undefined
            ? { lastFiredAt: previous.lastFiredAt }
            : {}),
        };
        watchers.set(watcherKey, nextRuntime);

        if (watch.kind !== "glyphs_entered_state") {
          applyFlagOnUnsatisfied(canvasName, doc, nodeId, watch.flagOnUnsatisfied, result.state.status);
        }

        if (result.fired) {
          firePulseForNode(canvasName, doc, nodeId, "watcher", result.state.detail);
        }
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
        // Invalid -> unknown-style no-op: never scheduled, never fires
        // (LAW: unknown never fires). Clear any stale schedule left over
        // from before an edit made it invalid, and surface it loudly rather
        // than let it silently stop pulsing.
        if (nextFire.has(timerKey)) nextFire.delete(timerKey);
        console.error(`[kernel] invalid timer everyMinutes (${timer.everyMinutes}) on ${timerKey} — disabled until fixed`);
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
          nextFire.set(
            timerKey,
            decision.state.nextDueAtEpochMs,
          );
          continue;
        }
        if (decision._tag === "NotDue") {
          nextFire.set(timerKey, decision.state.nextDueAtEpochMs);
          continue;
        }

        nextFire.set(
          timerKey,
          decision.nextState.nextDueAtEpochMs,
        );
        const coalesced =
          decision.coalescedMissedSlots === "0"
            ? ""
            : ` · ${decision.coalescedMissedSlots} missed interval(s) coalesced`;
        firePulseForNode(
          canvasName,
          doc,
          node.id,
          "timer",
          `timer fired · every ${timer.everyMinutes}m${coalesced}`,
        );
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

export const getPulseLog = (): PulseRecord[] => {
  return [...pulseLog];
};

export const getArmed = (): Map<string, boolean> => {
  return new Map(armed);
};

export const __getPendingPulseDeliveryCountForTest = (): number => {
  return pendingPulseDeliveries.size;
};

export const retryPendingPulseDeliveries = (): void => {
  for (const [key, params] of [...pendingPulseDeliveries]) {
    if (queuedPulseDeliveryKeys.has(key)) continue;
    pendingPulseDeliveries.delete(key);
    // Re-authorize against the current document before every retry. An edge
    // drawn after the original event cannot resurrect it, and a removed edge
    // cancels the queued action before any transport is invoked.
    if (!scheduledPulseCanWait(params)) continue;
    if (!enqueuePulseDelivery(params, true)) {
      pendingPulseDeliveries.set(key, params);
    }
  }
};

// Drops the DERIVED namespaced state for a canvas that's gone from authority
// (deleted or renamed) — watchers/nextFire/edge-detection
// memory, keyed `${canvasName}::${id}`. ARMING is operator intent, not derived
// state, so the in-memory `armed` map is deliberately NOT purged here: a
// delete+recreate under the same name must resume armed (kernel-design.md §3),
// and while the canvas is gone the preserved intent surfaces as orphaned
// arming (service.ts computeOrphanedArming reads this same in-memory map).
// Previously this also `armed.delete`d the entries, which made preserved store
// intent invisible until an app restart — that deletion is now removed.
export const purgeCanvasMemory = (canvasName: string): void => {
  const prefix = `${canvasName}::`;
  for (const key of watchers.keys()) if (key.startsWith(prefix)) watchers.delete(key);
  for (const key of nextFire.keys()) if (key.startsWith(prefix)) nextFire.delete(key);
  for (const [key, params] of pendingPulseDeliveries) {
    if (params.canvasName === canvasName) pendingPulseDeliveries.delete(key);
  }
  // Cancel queued-but-not-started actions. The currently in-flight item has
  // already been shifted out and keeps its key until its transport settles.
  for (let index = pulseDeliveryQueue.length - 1; index >= 0; index -= 1) {
    const params = pulseDeliveryQueue[index];
    if (params?.canvasName !== canvasName) continue;
    pulseDeliveryQueue.splice(index, 1);
    const key = scheduledPulseKey(params);
    if (key !== undefined) queuedPulseDeliveryKeys.delete(key);
  }
  executionByCanvas.delete(canvasName);
  // evaluate.ts's edge-detection memory (seenLevelStatus/seenGlyphState) is
  // namespaced the same way and grows unbounded across the app's lifetime
  // otherwise — purge it here too so a deleted canvas's baselines don't
  // outlive the canvas.
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
// alone (that is purgeCanvasMemory's job, on delete). ARMING is never touched —
// it is operator intent, surfaced as orphaned arming, not swept.
export const reconcileLiveCanvasMemory = (): void => {
  const hasWatch = (canvasName: string, nodeId: string): boolean => {
    const doc = docs.get(canvasName);
    if (!doc) return false; // canvas not hydrated — leave to purgeCanvasMemory
    return doc.nodes.some((node) => node.id === nodeId && node.type === "text" && node.ether?.watch !== undefined);
  };
  const hasTimer = (canvasName: string, nodeId: string): boolean => {
    const doc = docs.get(canvasName);
    if (!doc) return false;
    return doc.nodes.some((node) => node.id === nodeId && node.type === "text" && node.ether?.timer !== undefined);
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
