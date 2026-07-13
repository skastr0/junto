// The kernel loop + delivery. This file is the FROZEN interface the UI lane
// builds against — WatcherRuntimeState, PulseRecord, kernel$, startKernel,
// armRegion, and pulseRegion below must keep their exact shapes. Everything
// else here is this lane's own implementation detail.
//
// LAWS (src/shared/canvas.ts): watcher runtime state is derived, never
// written to the document. ARMING lives only in app state (kernel$.armed),
// never the file. A disarmed pulse is a DRY pulse — logged, no agent turns.

import { observable, observe } from "@legendapp/state";
import { ulid } from "ulid";
import type { CanvasDoc, GroupNode } from "@shared/canvas";
import type { TowerGlyphRow } from "@shared/ipc";
import { detectPulses, type GlyphIndex, type WatcherStatus } from "./kernel";
import { containedNodeIds } from "./geometry";
import { toggleFlag } from "./mutations";
import { openChat, sendPrompt, getAgentChatState } from "./chat-state";
import { fetchTowerBrowse } from "./browse";
import { state$ } from "./state";

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
}

export const kernel$ = observable<{
  watchers: Record<string, WatcherRuntimeState>;
  armed: Record<string, boolean>;
  nextFire: Record<string, number>;
  pulseLog: PulseRecord[];
}>({
  watchers: {},
  armed: {},
  nextFire: {},
  pulseLog: [],
});

// --- region geometry (derived, never persisted) ------------------------------
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

const defaultDeliverDeps: PulseDeliverDeps = {
  isLive: (agentKey) => getAgentChatState(agentKey).status === "live",
  openChat: (agentKey) => openChat(agentKey),
  sendPrompt: (agentKey, message) => sendPrompt(agentKey, message),
};

export const PULSE_CAP_PER_REGION_PER_HOUR = 6;
const ROLLING_HOUR_MS = 60 * 60 * 1000;
const PULSE_LOG_CAP = 200;

const armedDeliveriesLastHour = (regionId: string): number => {
  const cutoff = Date.now() - ROLLING_HOUR_MS;
  return kernel$.pulseLog
    .peek()
    .filter((record) => record.regionId === regionId && !record.dry && record.at >= cutoff).length;
};

const appendPulseRecord = (record: PulseRecord): void => {
  const next = [...kernel$.pulseLog.peek(), record];
  kernel$.pulseLog.set(next.length > PULSE_LOG_CAP ? next.slice(next.length - PULSE_LOG_CAP) : next);
};

export interface DeliverPulseParams {
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
  const deps = params.deps ?? defaultDeliverDeps;
  const { regionId } = params;
  const isArmed = regionId !== undefined && (kernel$.armed[regionId].peek() ?? false);
  const wantsLive = isArmed && params.forceDry !== true;
  const capped = wantsLive && regionId !== undefined && armedDeliveriesLastHour(regionId) >= PULSE_CAP_PER_REGION_PER_HOUR;
  const dry = !wantsLive || capped;

  let delivered: ReadonlyArray<string> = [];
  if (!dry && regionId !== undefined) {
    const doc = state$.doc.peek();
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

  appendPulseRecord({
    id: `pulse-${ulid()}`,
    at: Date.now(),
    sourceNodeId: params.sourceNodeId,
    kind: params.kind,
    summary: capped ? `${params.summary} (cap reached · ${PULSE_CAP_PER_REGION_PER_HOUR}/hr)` : params.summary,
    delivered,
    dry,
    ...(regionId !== undefined ? { regionId } : {}),
  });
}

const firePulseForNode = async (doc: CanvasDoc, nodeId: string, kind: "watcher" | "timer", summary: string): Promise<void> => {
  await deliverPulse({ sourceNodeId: nodeId, kind, regionId: findContainingRegionId(doc, nodeId), summary });
};

// --- flagOnUnsatisfied (level watchers only) ----------------------------------
// Mirrors the derived "unsatisfied" state into the blocker flag, writing
// only when the flag actually needs to change — never on every tick.
const applyFlagOnUnsatisfied = (doc: CanvasDoc, nodeId: string, flagOnUnsatisfied: boolean | undefined, status: WatcherStatus): void => {
  if (!flagOnUnsatisfied) return;
  const node = doc.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return;
  const hasFlag = node.ether?.flags?.includes("blocker") ?? false;
  const shouldFlag = status !== "satisfied";
  if (hasFlag !== shouldFlag) toggleFlag(nodeId, "blocker");
};

// --- glyph index (bridges the pure evaluator to the browse cache) ------------
// Only fetches for projects a watcher in the current doc actually scopes to
// — never every bound project. A slow/hung fetch is bounded so a cycle
// never stalls the loop; the abandoned request still warms lib/browse.ts's
// cache in the background, so the next pass (interval or doc/snapshot
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
  const result = await Promise.race([
    fetchTowerBrowse(project),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), GLYPH_FETCH_TIMEOUT_MS)),
  ]);
  return result && result.ok ? result.glyphs : undefined;
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
        const glyphs = await fetchGlyphsBounded(project);
        if (glyphs !== undefined) index.set(project, glyphs);
      }),
    );
  }
  return index;
};

// --- evaluation cycle ----------------------------------------------------------

const runEvaluationCycle = async (): Promise<void> => {
  const doc = state$.doc.peek();
  const snapshots = state$.snapshots.peek();
  const glyphIndex = await buildGlyphIndex(doc);

  for (const { nodeId, watch, result } of detectPulses(doc, snapshots, glyphIndex)) {
    const previous = kernel$.watchers[nodeId].peek();
    const nextRuntime: WatcherRuntimeState = { status: result.state.status, detail: result.state.detail };
    const lastFiredAt = result.fired ? Date.now() : previous?.lastFiredAt;
    if (lastFiredAt !== undefined) nextRuntime.lastFiredAt = lastFiredAt;
    kernel$.watchers[nodeId].set(nextRuntime);

    if (watch.kind !== "glyphs_entered_state") {
      applyFlagOnUnsatisfied(doc, nodeId, watch.flagOnUnsatisfied, result.state.status);
    }

    if (result.fired) {
      await firePulseForNode(doc, nodeId, "watcher", result.state.detail);
    }
  }
};

// --- timer scheduling ----------------------------------------------------------
// nextFire lives only in kernel$ (app memory), never the document. A timer
// node newly seen (fresh add, or first tick after boot) is scheduled one
// interval out — it never fires the instant it's discovered.
const ensureTimerScheduled = (nodeId: string, everyMinutes: number): void => {
  if (kernel$.nextFire[nodeId].peek() !== undefined) return;
  kernel$.nextFire[nodeId].set(Date.now() + everyMinutes * 60_000);
};

const checkTimers = async (): Promise<void> => {
  const doc = state$.doc.peek();
  const now = Date.now();
  for (const node of doc.nodes) {
    if (node.type !== "text") continue;
    const timer = node.ether?.timer;
    if (!timer) continue;
    ensureTimerScheduled(node.id, timer.everyMinutes);
    const due = kernel$.nextFire[node.id].peek();
    if (due === undefined || now < due) continue;
    kernel$.nextFire[node.id].set(now + timer.everyMinutes * 60_000);
    await firePulseForNode(doc, node.id, "timer", `timer fired · every ${timer.everyMinutes}m`);
  }
};

// --- loop wiring ----------------------------------------------------------------

const SAFETY_INTERVAL_MS = 30_000;

let cycleInFlight = false;
let cycleQueued = false;

// Coalesces overlapping triggers (snapshot change + doc change + the safety
// interval can all fire close together) into at most one queued rerun,
// rather than racing two concurrent cycles against the same edge-detection
// memory in lib/kernel.ts.
const scheduleCycle = (): void => {
  if (cycleInFlight) {
    cycleQueued = true;
    return;
  }
  cycleInFlight = true;
  void Promise.all([runEvaluationCycle(), checkTimers()])
    .catch(() => undefined)
    .finally(() => {
      cycleInFlight = false;
      if (cycleQueued) {
        cycleQueued = false;
        scheduleCycle();
      }
    });
};

// Tracks one observable selector and reschedules the cycle whenever it
// changes — the shared shape behind both the snapshots and doc subscriptions.
const watchAndScheduleCycle = (track: () => unknown): (() => void) =>
  observe(() => {
    track();
    scheduleCycle();
  });

let started = false;
let teardown: ReadonlyArray<() => void> = [];

const stopKernel = (): void => {
  for (const off of teardown) off();
  teardown = [];
  started = false;
};

// Idempotent singleton: repeated calls (StrictMode remount, a second
// mounting consumer) return the same stop handle rather than re-subscribing.
export function startKernel(): () => void {
  if (started) return stopKernel;
  started = true;

  const offSnapshots = watchAndScheduleCycle(() => state$.snapshots.get());
  const offDoc = watchAndScheduleCycle(() => state$.docVersion.get());
  const interval = setInterval(scheduleCycle, SAFETY_INTERVAL_MS);

  teardown = [offSnapshots, offDoc, () => clearInterval(interval)];
  return stopKernel;
}

// --- arming + manual pulse ------------------------------------------------------

export function armRegion(regionId: string, armed: boolean): void {
  kernel$.armed[regionId].set(armed);
}

export async function pulseRegion(regionId: string, opts?: { dry?: boolean; summary?: string }): Promise<void> {
  await deliverPulse({
    sourceNodeId: regionId,
    kind: "manual",
    regionId,
    summary: opts?.summary ?? "manual pulse",
    forceDry: opts?.dry,
  });
}
