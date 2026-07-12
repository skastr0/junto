import { Context, Effect, Layer } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import type { SnapshotBundle, SnapshotState } from "@shared/entities";
import type { BindingHint } from "@shared/ipc";
import { parseGlyphKey } from "@shared/refs";
import { fetchBoothBundle } from "./adapters/booth";
import { fetchHermesBundle } from "./adapters/hermes";
import { fetchQuasarBundle } from "./adapters/quasar";
import { fetchTowerBundle, resolveTowerGlyphHints } from "./adapters/tower";

// The read-only data plane. Adapters shell out to reference CLIs and
// normalize into SnapshotBundles. refresh never fails: a broken adapter
// yields a bundle with ok:false and an error string, nothing more.
export class SnapshotsService extends Context.Tag("@vellum/SnapshotsService")<
  SnapshotsService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly current: Effect.Effect<SnapshotState>;
    readonly refresh: (hints?: ReadonlyArray<BindingHint>) => Effect.Effect<SnapshotState>;
    // Begin the background poll loop (cheap lists only). Idempotent.
    readonly start: () => void;
    readonly subscribe: (listener: (state: SnapshotState) => void) => () => void;
  }
>() {}

const emptyState: SnapshotState = { bundles: [] };

const POLL_INTERVAL_MS = 120_000;

const hintsFor = (
  hints: ReadonlyArray<BindingHint> | undefined,
  source: BindingHint["source"],
): ReadonlyArray<string> => (hints ?? []).filter((hint) => hint.source === source).map((hint) => hint.key);

// A fully isolated adapter call: fetchX already folds its own CLI/parse
// failures into an ok:false bundle, so this catch only guards against a
// truly unexpected throw (e.g. a bug in the adapter) so refresh() itself
// can never reject.
const guarded = async (
  source: SnapshotBundle["source"],
  run: () => Promise<SnapshotBundle>,
): Promise<SnapshotBundle> => {
  try {
    return await run();
  } catch (error) {
    return {
      source,
      fetchedAt: new Date().toISOString(),
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      entities: [],
    };
  }
};

// Glyph-level hydration: any hinted key that parses as a glyph key (e.g. a
// canvas node exploded via `explodeProjectInto`) gets resolved via the tower
// REST adapter and merged onto the tower bundle so findEntity can hydrate
// it. Fully isolated — a REST outage or a bug here must never take down the
// project-level tower bundle that already succeeded.
const withGlyphHints = async (
  tower: SnapshotBundle,
  hintKeys: ReadonlyArray<string>,
): Promise<SnapshotBundle> => {
  const glyphKeys = hintKeys.filter((key) => parseGlyphKey(key) !== undefined);
  if (glyphKeys.length === 0) return tower;
  try {
    const glyphEntities = await resolveTowerGlyphHints(glyphKeys);
    if (glyphEntities.length === 0) return tower;
    return { ...tower, entities: [...tower.entities, ...glyphEntities] };
  } catch {
    return tower;
  }
};

export const SnapshotsLive = Layer.sync(SnapshotsService, () => {
  let state: SnapshotState = emptyState;
  let lastHints: ReadonlyArray<BindingHint> | undefined;
  let started = false;
  const listeners = new Set<(state: SnapshotState) => void>();

  const refresh = async (hints?: ReadonlyArray<BindingHint>): Promise<SnapshotState> => {
    lastHints = hints;
    const [tower, quasar, booth, hermes] = await Promise.all([
      guarded("tower", () => fetchTowerBundle()),
      guarded("quasar", () => fetchQuasarBundle(hintsFor(hints, "quasar"))),
      guarded("booth", () => fetchBoothBundle(hintsFor(hints, "booth"))),
      guarded("hermes", () => fetchHermesBundle()),
    ]);
    const towerWithGlyphs = await withGlyphHints(tower, hintsFor(hints, "tower"));

    state = { bundles: [towerWithGlyphs, quasar, booth, hermes] };
    for (const listener of listeners) listener(state);
    return state;
  };

  return SnapshotsService.of({
    doctor: Effect.succeed({
      id: "snapshots",
      label: "Adapter Snapshots",
      status: "ok",
      detail: "tower/quasar/booth CLI adapters",
    }),
    current: Effect.sync(() => state),
    refresh: (hints) => Effect.promise(() => refresh(hints)),
    start: () => {
      if (started) return;
      started = true;
      void refresh(lastHints);
      setInterval(() => void refresh(lastHints), POLL_INTERVAL_MS);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
});
