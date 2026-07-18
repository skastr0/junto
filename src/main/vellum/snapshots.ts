import { Context, Effect, Layer } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import type { SnapshotBundle, SnapshotState } from "@shared/entities";
import type { BindingHint } from "@shared/ipc";
import { fetchBoothBundle } from "./adapters/booth";
import { fetchQuasarBundle } from "./adapters/quasar";
import { fetchTowerBundle } from "./adapters/tower";
import { HermesPlane } from "./hermes/plane";

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

const POLL_INTERVAL_MS = 60_000;

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

// A canonical, order-independent key for a hint set: used to decide whether
// an in-flight refresh already covers what a new call is asking for.
const hintsKeySet = (hints: ReadonlyArray<BindingHint> | undefined): ReadonlySet<string> =>
  new Set((hints ?? []).map((hint) => `${hint.source}:${hint.key}`));

// True when everything `requested` needs is already covered by `covering`
// (requested is a subset-or-equal of covering) — i.e. `covering` has
// equal-or-newer/broader hints than what's being asked for.
const isSubsumedBy = (
  requested: ReadonlyArray<BindingHint> | undefined,
  covering: ReadonlyArray<BindingHint> | undefined,
): boolean => {
  const coveringKeys = hintsKeySet(covering);
  for (const key of hintsKeySet(requested)) {
    if (!coveringKeys.has(key)) return false;
  }
  return true;
};

export const makeSnapshotsLive = (
  fetchHermesBundle: () => Promise<SnapshotBundle>,
) => Layer.sync(SnapshotsService, () => {
  let state: SnapshotState = emptyState;
  let lastHints: ReadonlyArray<BindingHint> | undefined;
  let started = false;
  const listeners = new Set<(state: SnapshotState) => void>();

  // Monotonic call-order stamp: whichever refresh() call started last is
  // "newest". A completion only commits to `state` (and only notifies
  // listeners) if its stamp is not older than the newest one already
  // committed — so a slow, superseded call can never clobber a faster,
  // newer one, regardless of Promise settle order.
  let sequenceCounter = 0;
  let lastCommittedSequence = 0;

  // The currently-running refresh, if any, plus the hint set it was
  // started with. A new call whose hints are already covered by this one
  // joins it instead of kicking off a redundant CLI fan-out.
  let inFlight: { readonly hints: ReadonlyArray<BindingHint> | undefined; readonly promise: Promise<SnapshotState> } | null =
    null;

  const runRefresh = async (
    hints: ReadonlyArray<BindingHint> | undefined,
    sequence: number,
  ): Promise<SnapshotState> => {
    const [tower, quasar, booth, hermes] = await Promise.all([
      guarded("tower", () => fetchTowerBundle()),
      guarded("quasar", () => fetchQuasarBundle(hintsFor(hints, "quasar"))),
      // booth ignores hints by design: every project is enriched each poll,
      // which is what lets the renderer resolve booth implicitly via tower.
      guarded("booth", () => fetchBoothBundle()),
      guarded("hermes", () => fetchHermesBundle()),
    ]);

    if (sequence >= lastCommittedSequence) {
      lastCommittedSequence = sequence;
      state = { bundles: [tower, quasar, booth, hermes] };
      for (const listener of listeners) listener(state);
    }

    return state;
  };

  const refresh = (hints?: ReadonlyArray<BindingHint>): Promise<SnapshotState> => {
    lastHints = hints;

    if (inFlight && isSubsumedBy(hints, inFlight.hints)) {
      return inFlight.promise;
    }

    const sequence = ++sequenceCounter;
    const promise = runRefresh(hints, sequence);
    const record = { hints, promise };
    inFlight = record;
    void promise.finally(() => {
      if (inFlight === record) inFlight = null;
    });
    return promise;
  };

  return SnapshotsService.of({
    doctor: Effect.succeed({
      id: "snapshots",
      label: "Adapter Snapshots",
      status: "ok",
      detail: "tower/quasar/booth SDK adapters",
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

export const SnapshotsLive = Layer.unwrapEffect(
  Effect.map(HermesPlane, (plane) => makeSnapshotsLive(plane.fetchBundle)),
);
