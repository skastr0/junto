// Pure gauge evaluation. Nothing in this module touches the document,
// IPC, or delivery — it takes already-fetched snapshots and returns a
// derived verdict. cycle.ts owns the loop and applies edge effects on fire.
//
// LAW: watcher/gauge runtime state is DERIVED, never written to the document;
// edge-detection memory lives only in app memory; first observation is always
// a baseline that can never fire. Rising edge into `satisfied` only.

import type { CanvasDoc, EtherWatch } from "@shared/canvas";
// Value import: vitest here has no alias resolver for runtime imports (only
// tsc resolves "@shared/*", via tsconfig paths) — a relative path is what
// actually lets this module load under `bun run test`. Type-only imports stay
// on the alias since those are erased before any resolver sees them.
import { findFreshEntity, type Entity, type SnapshotState } from "../../../shared/entities";

export type WatcherStatus = "satisfied" | "pending" | "unknown";

export interface WatcherEvaluation {
  readonly status: WatcherStatus;
  readonly detail: string;
}

export interface WatcherEvalResult {
  readonly state: WatcherEvaluation;
  readonly fired: boolean;
}

// --- edge-detection memory (app memory only, per LAW) -----------------------
// Keyed by `${canvasName}::${watcher NODE id}`, not by the watch rule's content,
// so two distinct watcher nodes that happen to describe the same rule still get
// independent baselines and independent fire history.
const seenLevelStatus = new Map<string, WatcherStatus>();

// Test-only reset: tests exercise many independent watcher scenarios in one
// process; this clears the module-level memory between cases instead of
// forcing every fixture to fabricate a globally-unique watcher id.
export const resetWatcherMemory = (): void => {
  seenLevelStatus.clear();
};

// Drops every namespaced entry for one deleted canvas, mirroring cycle.ts's
// purgeCanvasMemory for the OTHER half of the kernel's in-memory state.
export const purgeCanvasEdgeMemory = (canvasName: string): void => {
  const prefix = `${canvasName}::`;
  for (const key of seenLevelStatus.keys()) if (key.startsWith(prefix)) seenLevelStatus.delete(key);
};

// --- stat_threshold -------------------------------------------------------

const OP_SYMBOL: Record<"gt" | "lt" | "eq", string> = { gt: ">", lt: "<", eq: "=" };

const readNumericStat = (entity: Entity, key: string): number | undefined => {
  const raw = entity.stats[key];
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : undefined;
};

const evaluateStatThreshold = (watch: EtherWatch, snapshots: SnapshotState): WatcherEvaluation => {
  if (!watch.source || !watch.key || !watch.stat || !watch.op || watch.value === undefined) {
    return { status: "unknown", detail: "incomplete stat rule" };
  }
  const entity = findFreshEntity(snapshots, watch.source, watch.key);
  if (!entity) {
    return {
      status: "unknown",
      detail: `${watch.source}:${watch.key} unavailable or stale`,
    };
  }
  const value = readNumericStat(entity, watch.stat);
  if (value === undefined) return { status: "unknown", detail: `${watch.stat} not numeric` };
  const satisfied = watch.op === "gt" ? value > watch.value : watch.op === "lt" ? value < watch.value : value === watch.value;
  const detail = `${watch.stat} ${value} ${OP_SYMBOL[watch.op]} ${watch.value}`;
  return { status: satisfied ? "satisfied" : "pending", detail };
};

// --- dispatch ---------------------------------------------------------------

// `watcherId` is the watcher TEXT node's id — required so two watcher nodes
// describing the same rule get independent edge-detection memory.
export function evaluateWatcher(
  canvasName: string,
  watcherId: string,
  watch: EtherWatch,
  snapshots: SnapshotState,
): WatcherEvalResult {
  const evaluation = evaluateStatThreshold(watch, snapshots);

  const memoryKey = `${canvasName}::${watcherId}`;
  const previous = seenLevelStatus.get(memoryKey);
  // Only a KNOWN level (satisfied/pending) belongs in the edge-detection
  // baseline. An "unknown" read means the source was down/absent this pass —
  // it is not a level the condition actually passed through, so it must
  // neither overwrite the baseline nor manufacture a rising edge when the
  // source recovers. Skipping the write lets recovery re-baseline silently
  // against the last known level: a satisfied -> unknown -> satisfied blip
  // leaves `previous` at "satisfied", so it can never re-fire an already-met
  // condition on nothing more than a transient hermes outage.
  if (evaluation.status !== "unknown") {
    seenLevelStatus.set(memoryKey, evaluation.status);
  }
  // Baseline (previous === undefined) never fires, even if already
  // satisfied on first look.
  const fired = previous !== undefined && previous !== "satisfied" && evaluation.status === "satisfied";
  return { state: evaluation, fired };
}

// Evaluates every watcher TEXT node in `doc` exactly once and returns the
// full per-node result (not just the ones that fired) — callers must not
// separately call evaluateWatcher for the same pass, since doing so would
// double-advance the edge-detection memory above. Filter on `.result.fired`
// for "which watcher nodes fired this pass".
export interface DetectedWatcher {
  readonly nodeId: string;
  readonly watch: EtherWatch;
  readonly result: WatcherEvalResult;
}

export function detectPulses(
  canvasName: string,
  doc: CanvasDoc,
  snapshots: SnapshotState,
): ReadonlyArray<DetectedWatcher> {
  const out: DetectedWatcher[] = [];
  for (const node of doc.nodes) {
    if (node.type !== "text") continue;
    const watch = node.ether?.watch;
    if (!watch) continue;
    const result = evaluateWatcher(canvasName, node.id, watch, snapshots);
    out.push({ nodeId: node.id, watch, result });
  }
  return out;
}

/**
 * Rising-edge helper for non-hermes sensors (relay). Shares the same
 * seenLevelStatus map so first observation never fires.
 */
export function evaluateWatcherLevel(
  canvasName: string,
  nodeId: string,
  evaluation: WatcherEvaluation,
): WatcherEvalResult {
  const memoryKey = `${canvasName}::${nodeId}`;
  const previous = seenLevelStatus.get(memoryKey);
  if (evaluation.status !== "unknown") {
    seenLevelStatus.set(memoryKey, evaluation.status);
  }
  const fired =
    previous !== undefined &&
    previous !== "satisfied" &&
    evaluation.status === "satisfied";
  return { state: evaluation, fired };
}
