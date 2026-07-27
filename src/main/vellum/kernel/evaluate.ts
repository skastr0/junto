// Pure watcher evaluation. Nothing in this module touches the document,
// IPC, or delivery — it takes already-fetched snapshots + a glyph index and
// returns a derived verdict. cycle.ts owns the loop that keeps
// those inputs fresh and turns a fired verdict into a region pulse.
//
// LAW (src/shared/canvas.ts EtherWatch/EtherTimer comments): watcher runtime
// state is DERIVED, never written to the document; edge-detection memory —
// "did this newly become true since the last time we looked" — lives only
// in app memory, and the first evaluation of anything is always a baseline
// that can never fire. That law is stated generically for "watcher runtime
// state," not scoped to one kind, so it is applied uniformly here: every
// watcher kind (including the two level rules) only ever "fires" on a
// rising edge into `satisfied`, never on the resting state, and never on
// its own first observation.

import type { CanvasDoc, EtherWatch } from "@shared/canvas";
import type { TowerGlyphRow } from "@shared/ipc";
// Value import: vitest here has no alias resolver for runtime imports (only
// tsc resolves "@shared/*", via tsconfig paths) — a relative path is what
// actually lets this module load under `bun run test`. Mirrors the same
// Type-only imports stay on
// the alias since those are erased before any resolver sees them.
import { findFreshEntity, type Entity, type SnapshotState } from "../../../shared/entities";

export type WatcherStatus = "satisfied" | "pending" | "unknown";

export interface WatcherEvaluation {
  readonly status: WatcherStatus;
  readonly detail: string;
}

export interface WatcherEvalResult {
  readonly state: WatcherEvaluation;
  readonly fired: boolean;
  readonly firedGlyphIds?: ReadonlyArray<string>;
}

// projectKey -> that project's current glyph rows, as last landed via
// the glyph index. A project absent from the index
// means "not in cache yet" (a fetch may already be in flight) — evaluation
// degrades to "unknown" rather than blocking on it; the next pass picks up
// whatever landed in the meantime (LAW: never blocks).
export type GlyphIndex = ReadonlyMap<string, ReadonlyArray<TowerGlyphRow>>;

const DEFAULT_ENTERED_STATE = "committed";

// --- edge-detection memory (app memory only, per LAW) -----------------------
// Keyed by `${canvasName}::${watcher NODE id}`, not by the watch rule's content,
// so two distinct watcher nodes that happen to describe the same rule still get
// independent baselines and independent fire history.
const seenLevelStatus = new Map<string, WatcherStatus>();
// Keyed by `${canvasName}::${watcherId}::${orbit}::${glyphId}` so per-glyph
// baselines are scoped to the watcher that is watching them.
const seenGlyphState = new Map<string, string>();

// Test-only reset: tests exercise many independent watcher scenarios in one
// process; this clears the module-level memory between cases instead of
// forcing every fixture to fabricate a globally-unique watcher id.
export const resetWatcherMemory = (): void => {
  seenLevelStatus.clear();
  seenGlyphState.clear();
};

// Drops every namespaced entry for one deleted canvas, mirroring cycle.ts's
// purgeCanvasMemory for the OTHER half of the kernel's in-memory state: that
// function only ever purged its own watchers/nextFire/armed maps, never
// these two — so a canvas that gets created, watched a while, and deleted
// left its edge-detection baselines behind forever (unbounded growth across
// the app's lifetime, one entry per watcher-node/glyph pair ever observed).
// Both maps are keyed `${canvasName}::...`, same convention as everywhere
// else in the kernel, so a prefix match is exact and can't collide with a
// differently-named canvas.
export const purgeCanvasEdgeMemory = (canvasName: string): void => {
  const prefix = `${canvasName}::`;
  for (const key of seenLevelStatus.keys()) if (key.startsWith(prefix)) seenLevelStatus.delete(key);
  for (const key of seenGlyphState.keys()) if (key.startsWith(prefix)) seenGlyphState.delete(key);
};

// --- level-rule scoping (glyphs_done, glyphs_entered_state) -----------------

const scopeGlyphs = (watch: EtherWatch, glyphIndex: GlyphIndex): ReadonlyArray<TowerGlyphRow> | undefined => {
  if (!watch.project) return undefined;
  const rows = glyphIndex.get(watch.project);
  if (rows === undefined) return undefined;
  let scoped = rows;
  if (watch.orbit) scoped = scoped.filter((glyph) => glyph.orbit === watch.orbit);
  if (watch.glyphIds && watch.glyphIds.length > 0) {
    const ids = new Set(watch.glyphIds);
    scoped = scoped.filter((glyph) => ids.has(glyph.glyphId));
  }
  return scoped;
};

// --- glyphs_done --------------------------------------------------------

const evaluateGlyphsDone = (watch: EtherWatch, glyphIndex: GlyphIndex): WatcherEvaluation => {
  if (!watch.project) return { status: "unknown", detail: "no project bound" };
  const scoped = scopeGlyphs(watch, glyphIndex);
  if (scoped === undefined) return { status: "unknown", detail: "glyph data unavailable" };
  // Zero glyphs in scope (cache landed but nothing matched project/orbit/ids)
  // stays "unknown" rather than vacuously "satisfied" — an empty scope from
  // a typo'd glyphId or a not-yet-populated orbit must never read as done.
  if (scoped.length === 0) return { status: "unknown", detail: "no glyphs in scope" };
  const total = scoped.length;
  const done = scoped.filter((glyph) => glyph.state === "done").length;
  const abandoned = scoped.filter((glyph) => glyph.state === "abandoned").length;
  const detail = abandoned > 0 ? `${done}/${total} done (${abandoned} abandoned)` : `${done}/${total} done`;
  return { status: done === total ? "satisfied" : "pending", detail };
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

// --- glyphs_entered_state (edge rule) ---------------------------------------

const evaluateGlyphsEnteredState = (
  canvasName: string,
  watcherId: string,
  watch: EtherWatch,
  glyphIndex: GlyphIndex,
): { readonly evaluation: WatcherEvaluation; readonly firedGlyphIds: ReadonlyArray<string> } => {
  const target = watch.state ?? DEFAULT_ENTERED_STATE;
  if (!watch.project) return { evaluation: { status: "unknown", detail: "no project bound" }, firedGlyphIds: [] };
  const scoped = scopeGlyphs(watch, glyphIndex);
  if (scoped === undefined) {
    return { evaluation: { status: "unknown", detail: "glyph data unavailable" }, firedGlyphIds: [] };
  }

  const fired: string[] = [];
  for (const glyph of scoped) {
    const memoryKey = `${canvasName}::${watcherId}::${glyph.orbit}::${glyph.glyphId}`;
    const previous = seenGlyphState.get(memoryKey);
    // First observation of THIS glyph under THIS watcher = baseline, never
    // fires — independent of whether the watcher itself has fired before.
    if (previous !== undefined && previous !== target && glyph.state === target) {
      fired.push(glyph.glyphId);
    }
    seenGlyphState.set(memoryKey, glyph.state);
  }

  const detail = fired.length > 0 ? `watching · ${target} (entered: ${fired.join(", ")})` : `watching · ${target}`;
  // "satisfied" here reads as "the awaited transition just happened this
  // pass" — there is no meaningful resting-level for an edge rule.
  return { evaluation: { status: fired.length > 0 ? "satisfied" : "pending", detail }, firedGlyphIds: fired };
};

// --- dispatch ---------------------------------------------------------------

// `watcherId` is the watcher TEXT node's id — required so two watcher nodes
// describing the same rule (or watching the same glyph) get independent
// edge-detection memory; see the module comment above.
export function evaluateWatcher(
  canvasName: string,
  watcherId: string,
  watch: EtherWatch,
  snapshots: SnapshotState,
  glyphIndex: GlyphIndex,
): WatcherEvalResult {
  if (watch.kind === "glyphs_entered_state") {
    const { evaluation, firedGlyphIds } = evaluateGlyphsEnteredState(canvasName, watcherId, watch, glyphIndex);
    return { state: evaluation, fired: firedGlyphIds.length > 0, firedGlyphIds };
  }

  const evaluation = watch.kind === "glyphs_done"
    ? evaluateGlyphsDone(watch, glyphIndex)
    : evaluateStatThreshold(watch, snapshots);

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
  // satisfied on first look — matches the edge-rule baseline law above.
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
  glyphIndex: GlyphIndex,
): ReadonlyArray<DetectedWatcher> {
  const out: DetectedWatcher[] = [];
  for (const node of doc.nodes) {
    if (node.type !== "text") continue;
    const watch = node.ether?.watch;
    if (!watch) continue;
    const result = evaluateWatcher(canvasName, node.id, watch, snapshots, glyphIndex);
    out.push({ nodeId: node.id, watch, result });
  }
  return out;
}
