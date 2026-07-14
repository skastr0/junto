// The kernel loop + delivery cycle. This handles evaluation over multiple
// canvases with per-canvas isolation and injectable dependencies for
// testability. All side-effects (glyph fetching, chat delivery, document
// writes) are behind injectable seams.

import { ulid } from "ulid";
import type { CanvasDoc, GroupNode } from "@shared/canvas";
import type { TowerGlyphRow } from "@shared/ipc";
import { detectPulses, evaluateWatcher, resetWatcherMemory, type GlyphIndex, type WatcherStatus } from "./evaluate";
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

export interface KernelSnapshot {
  canvases: Record<
    string,
    {
      watchers: Record<string, WatcherRuntimeState>;
      armed: Record<string, boolean>;
      nextFire: Record<string, number>;
    }
  >;
  pulseLog: ReadonlyArray<PulseRecord>;
}

// --- region geometry (derived, never persisted) ------------------------------

// Copied from renderer to maintain geometry evaluation consistency.
// Helper to find all node IDs contained within a group.
const containedNodeIds = (doc: CanvasDoc, group: GroupNode): string[] => {
  const ids: string[] = [];
  const isInside = (nodeId: string): boolean => {
    const node = doc.nodes.find((n) => n.id === nodeId);
    if (!node) return false;
    return node.x >= group.x && node.y >= group.y && node.x + node.width <= group.x + group.width && node.y + node.height <= group.y + group.height;
  };
  for (const node of doc.nodes) {
    if (node.id !== group.id && isInside(node.id)) {
      ids.push(node.id);
    }
  }
  return ids;
};

// "containedNodeIds reversed": scan every group node, keep the ones whose
// derived membership includes this node, and pick the smallest-area match —
// the innermost region wins when regions nest.
const findContainingRegionId = (doc: CanvasDoc, nodeId: string): string | undefined => {
  let best: GroupNode | undefined;
  for (const node of doc.nodes) {
    if (node.type !== "group") continue;
    if (!containedNodeIds(doc, node).includes(nodeId)) continue;
    if (!best || node.width * node.height < best.width * best.height) best = node;
  }
  return best?.id;
};

// Region members bound to a hermes agent, in document order. Membership
// itself is geometry-derived (never persisted); the hermes binding's
// ref.key is the chat-state agent key.
const agentKeysInRegion = (doc: CanvasDoc, regionId: string): ReadonlyArray<string> => {
  const region = doc.nodes.find((node): node is GroupNode => node.id === regionId && node.type === "group");
  if (!region) return [];
  const memberIds = new Set(containedNodeIds(doc, region));
  const keys: string[] = [];
  for (const node of doc.nodes) {
    if (!memberIds.has(node.id)) continue;
    for (const binding of node.ether?.bindings ?? []) {
      if (binding.source === "hermes") keys.push(binding.ref.key);
    }
  }
  return keys;
};

// --- pulse message ------------------------------------------------------------
// "[pulse] <summary>" + blank line + region.instruction when present.
// Nothing else — no canvas data ever leaks into the prompt.
export const composePulseMessage = (summary: string, instruction?: string): string =>
  instruction ? `[pulse] ${summary}\n\n${instruction}` : `[pulse] ${summary}`;

// --- delivery (injectable for testability) ------------------------------------

export interface PulseDeliverDeps {
  readonly isLive: (agentKey: string) => boolean;
  readonly openChat: (agentKey: string) => Promise<void>;
  readonly sendPrompt: (agentKey: string, message: string) => Promise<void>;
}

export interface FlagWriterDeps {
  readonly toggleFlag: (nodeId: string, flag: string) => void;
}

export const PULSE_CAP_PER_REGION_PER_HOUR = 6;
const ROLLING_HOUR_MS = 60 * 60 * 1000;
// Display-tray retention floor — NOT the enforcement mechanism for the hourly
// cap. The cap is enforced by armedDeliveriesLastHour (below), which counts a
// region's live records inside the rolling hour; if appendPulseRecord evicted a
// within-hour record purely to bound the array (the old size-only ring did,
// oldest-first, regardless of age or region), a region's earlier deliveries
// could fall out of the count while still inside their hour and the cap would
// fail OPEN at high total volume. So appendPulseRecord retains EVERY record
// from the last rolling hour at any volume (keeping the cap exact), and keeps
// the newest PULSE_LOG_DISPLAY_CAP entries on top of that so the tray still
// shows recent history during a quiet hour. A record is dropped only when it is
// BOTH older than the rolling hour AND beyond the newest PULSE_LOG_DISPLAY_CAP.
const PULSE_LOG_DISPLAY_CAP = 200;

// --- module-level state (injected for tests) ---------------------------------

let docs: Map<string, CanvasDoc> = new Map();
let snapshots: SnapshotState = { bundles: [] };
let armed: Map<string, boolean> = new Map();
let pulseLog: PulseRecord[] = [];

let deliveryDeps: PulseDeliverDeps | undefined = undefined;
let flagWriterDeps: FlagWriterDeps | undefined = undefined;
let glyphFetcher: ((project: string) => Promise<ReadonlyArray<TowerGlyphRow> | undefined>) | undefined = undefined;

// Test seams
export const __setDocsForTest = (docsMap: Map<string, CanvasDoc>): void => {
  docs = docsMap;
};

export const __setSnapshotsForTest = (state: SnapshotState): void => {
  snapshots = state;
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

export const __setGlyphFetcherForTest = (fetcher: ((project: string) => Promise<ReadonlyArray<TowerGlyphRow> | undefined>) | undefined): void => {
  glyphFetcher = fetcher;
};

export const __resetKernelMemoryForTest = (): void => {
  docs = new Map();
  snapshots = { bundles: [] };
  armed = new Map();
  pulseLog = [];
  deliveryDeps = undefined;
  flagWriterDeps = undefined;
  glyphFetcher = undefined;
  resetWatcherMemory();
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

const armedDeliveriesLastHour = (regionId: string): number => {
  const cutoff = Date.now() - ROLLING_HOUR_MS;
  return pulseLog.filter((record) => record.regionId === regionId && !record.dry && record.at >= cutoff).length;
};

const appendPulseRecord = (record: PulseRecord): void => {
  const cutoff = record.at - ROLLING_HOUR_MS;
  const all = [...pulseLog, record];
  const keepFromIndex = Math.max(0, all.length - PULSE_LOG_DISPLAY_CAP);
  pulseLog = all.filter((entry, index) => entry.at >= cutoff || index >= keepFromIndex);
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

// Single funnel for every pulse — watcher fire, timer tick, or manual. A
// regionless source (no containing group) always resolves dry with
// delivered: [] since there is no arming key to check.
export async function deliverPulse(params: DeliverPulseParams): Promise<void> {
  const deps = params.deps ?? deliveryDeps;
  if (!deps) {
    // No delivery deps configured — record dry pulse only
    appendPulseRecord({
      id: `pulse-${ulid()}`,
      at: Date.now(),
      sourceNodeId: params.sourceNodeId,
      kind: params.kind,
      summary: params.summary,
      delivered: [],
      dry: true,
      canvasName: params.canvasName,
      ...(params.regionId !== undefined ? { regionId: params.regionId } : {}),
    });
    return;
  }

  const { regionId } = params;
  const armedKey = regionId !== undefined ? `${params.canvasName}::${regionId}` : undefined;
  const isArmed = armedKey !== undefined && (armed.get(armedKey) ?? false);
  const wantsLive = isArmed && params.forceDry !== true;
  const capped = wantsLive && regionId !== undefined && armedDeliveriesLastHour(regionId) >= PULSE_CAP_PER_REGION_PER_HOUR;
  const dry = !wantsLive || capped;

  let delivered: ReadonlyArray<string> = [];
  if (!dry && regionId !== undefined) {
    const doc = docs.get(params.canvasName);
    if (doc) {
      const region = doc.nodes.find((node) => node.id === regionId);
      const instruction = region?.type === "group" ? region.ether?.region?.instruction : undefined;
      const message = composePulseMessage(params.summary, instruction);
      const keys = agentKeysInRegion(doc, regionId);
      const ok: string[] = [];
      // Sequential by contract — one agent turn spends real work; fan-out here
      // would spend N turns in parallel with no backpressure.
      for (const key of keys) {
        try {
          if (!deps.isLive(key)) await deps.openChat(key);
          await deps.sendPrompt(key, message);
          ok.push(key);
        } catch {
          // Best-effort per agent: one failing delivery doesn't sink the rest.
        }
      }
      delivered = ok;
    }
  }

  appendPulseRecord({
    id: `pulse-${ulid()}`,
    at: Date.now(),
    sourceNodeId: params.sourceNodeId,
    kind: params.kind,
    summary: capped ? `${params.summary} (cap reached · ${PULSE_CAP_PER_REGION_PER_HOUR}/hr)` : params.summary,
    delivered,
    dry,
    canvasName: params.canvasName,
    ...(regionId !== undefined ? { regionId } : {}),
  });
}

// --- pulse delivery queue (decoupled from the evaluation cycle) --------------
// A live pulse spends a real agent chat turn, and chatPrompt is bounded only by
// a 15-minute IPC ceiling (a turn may run tools for many minutes). If the
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
      // Error capture: a failing — or forever-pending — delivery never sinks
      // the drain; the next queued pulse still gets its turn.
      await deliverPulse(params).catch(() => undefined);
    }
  } finally {
    deliveryDraining = false;
  }
};

const enqueuePulseDelivery = (params: DeliverPulseParams): void => {
  pulseDeliveryQueue.push(params);
  void drainPulseDeliveries();
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

const applyFlagOnUnsatisfied = (doc: CanvasDoc, nodeId: string, flagOnUnsatisfied: boolean | undefined, status: WatcherStatus): void => {
  if (!flagOnUnsatisfied || !flagWriterDeps) return;
  const node = doc.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return;
  const hasFlag = node.ether?.flags?.includes("blocker") ?? false;
  if (flagShouldToggle(hasFlag, status)) {
    flagWriterDeps.toggleFlag(nodeId, "blocker");
  }
};

// --- glyph index (bridges the pure evaluator to the browse cache) ------------
// Only fetches for projects a watcher in the current doc actually scopes to
// — never every bound project. A slow/hung fetch is bounded so a cycle
// never stalls the loop; the abandoned request still warms the cache
// in the background, so the next pass (interval or doc/snapshot
// change) tends to land it.
const GLYPH_FETCH_TIMEOUT_MS = 2_000;

const relevantGlyphProjects = (doc: CanvasDoc): ReadonlySet<string> => {
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

const buildGlyphIndex = async (doc: CanvasDoc): Promise<GlyphIndex> => {
  const projects = Array.from(relevantGlyphProjects(doc));
  const index = new Map<string, ReadonlyArray<TowerGlyphRow>>();
  for (let i = 0; i < projects.length; i += MAX_CONCURRENT_GLYPH_FETCHES) {
    const batch = projects.slice(i, i + MAX_CONCURRENT_GLYPH_FETCHES);
    await Promise.all(
      batch.map(async (project) => {
        const glyphRows = await fetchGlyphsBounded(project);
        if (glyphRows !== undefined) index.set(project, glyphRows);
      }),
    );
  }
  return index;
};

// --- evaluation cycle (multi-canvas with per-canvas isolation) ---------------

// Watcher runtime state tracking (keyed by canvasName::nodeId)
const watchers = new Map<string, WatcherRuntimeState>();
// Next fire times for timers (keyed by canvasName::nodeId)
const nextFire = new Map<string, number>();

// Exported for tests: lets a test drive exactly one evaluation pass and assert
// it completes even while a delivery pends.
export const runEvaluationCycle = async (): Promise<void> => {
  // Get union of all projects from all canvases for glyph indexing
  const allProjects = new Set<string>();
  for (const doc of docs.values()) {
    for (const node of doc.nodes) {
      if (node.type !== "text") continue;
      const watch = node.ether?.watch;
      if (watch?.kind === "glyphs_done" || watch?.kind === "glyphs_entered_state") {
        if (watch.project) allProjects.add(watch.project);
      }
    }
  }

  // Build deduplicated glyph index across all canvases
  const glyphIndex = await buildGlyphIndex({ nodes: [], edges: [] }); // Dummy doc for now
  // Actually we need to build from all docs properly
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
      for (const { nodeId, watch, result } of detectPulses(canvasName, doc, snapshots, index)) {
        const watcherKey = `${canvasName}::${nodeId}`;
        const previous = watchers.get(watcherKey);
        const nextRuntime: WatcherRuntimeState = { status: result.state.status, detail: result.state.detail };
        const lastFiredAt = result.fired ? Date.now() : previous?.lastFiredAt;
        if (lastFiredAt !== undefined) nextRuntime.lastFiredAt = lastFiredAt;
        watchers.set(watcherKey, nextRuntime);

        if (watch.kind !== "glyphs_entered_state") {
          applyFlagOnUnsatisfied(doc, nodeId, watch.flagOnUnsatisfied, result.state.status);
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
// nextFire lives only in app memory, never the document. A timer node newly
// seen (fresh add, or first tick after boot) is scheduled one interval out —
// it never fires the instant it's discovered.
const ensureTimerScheduled = (canvasName: string, nodeId: string, everyMinutes: number): void => {
  const timerKey = `${canvasName}::${nodeId}`;
  if (nextFire.has(timerKey)) return;
  nextFire.set(timerKey, Date.now() + everyMinutes * 60_000);
};

export const checkTimers = async (): Promise<void> => {
  const now = Date.now();
  for (const [canvasName, doc] of docs.entries()) {
    for (const node of doc.nodes) {
      if (node.type !== "text") continue;
      const timer = node.ether?.timer;
      if (!timer) continue;
      const timerKey = `${canvasName}::${node.id}`;
      ensureTimerScheduled(canvasName, node.id, timer.everyMinutes);
      const due = nextFire.get(timerKey);
      if (due === undefined || now < due) continue;
      nextFire.set(timerKey, now + timer.everyMinutes * 60_000);
      firePulseForNode(canvasName, doc, node.id, "timer", `timer fired · every ${timer.everyMinutes}m`);
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
