import { Context, Effect, Layer } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import type { SnapshotBundle, SnapshotState } from "@shared/entities";
import type { BindingHint } from "@shared/ipc";
import { HermesPlane } from "./hermes/plane";
import { HERMES_INTEGRATION_ENABLED } from "@shared/features";
import { UsagePreferences } from "./usage/preferences";

// Read-only data plane: hermes only. refresh never fails — a broken adapter
// yields ok:false. Private source adapters are gone, not stubbed.
export class SnapshotsService extends Context.Service<SnapshotsService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly current: Effect.Effect<SnapshotState>;
    readonly refresh: (hints?: ReadonlyArray<BindingHint>) => Effect.Effect<SnapshotState>;
    readonly start: () => void;
    readonly subscribe: (listener: (state: SnapshotState) => void) => () => void;
  }>()("@vellum-command/SnapshotsService") {}

const emptyState: SnapshotState = { bundles: [] };

const POLL_INTERVAL_MS = 60_000;

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
      stale: true,
      error: error instanceof Error ? error.message : String(error),
      entities: [],
    };
  }
};

const factKey = (entity: SnapshotBundle["entities"][number]): string =>
  `${entity.source}:${entity.key}`;

/**
 * Preserve last-known facts without laundering them into current truth.
 *
 * A partial adapter result may contain facts successfully observed during
 * this attempt even though another host failed. Those current facts are
 * explicitly `stale:false`; only missing prior facts are retained as stale.
 * A total failure has no current facts, so every retained observation is stale.
 */
export const retainLastKnownFacts = (
  previous: SnapshotBundle | undefined,
  attempted: SnapshotBundle,
): SnapshotBundle => {
  if (attempted.ok) {
    return {
      ...attempted,
      stale: false,
      lastSuccessfulAt: attempted.fetchedAt,
      entities: attempted.entities.map(({ stale: _stale, ...entity }) => entity),
    };
  }

  const current = attempted.entities.map((entity) => ({ ...entity, stale: false as const }));
  const currentKeys = new Set(current.map(factKey));
  const retained = (previous?.entities ?? [])
    .filter((entity) => !currentKeys.has(factKey(entity)))
    .map((entity) => ({ ...entity, stale: true as const }));
  const lastSuccessfulAt =
    attempted.lastSuccessfulAt ??
    previous?.lastSuccessfulAt ??
    (previous?.ok ? previous.fetchedAt : undefined);

  return {
    ...attempted,
    stale: true,
    ...(lastSuccessfulAt === undefined ? {} : { lastSuccessfulAt }),
    entities: [...current, ...retained],
  };
};

const hintsKeySet = (hints: ReadonlyArray<BindingHint> | undefined): ReadonlySet<string> =>
  new Set((hints ?? []).map((hint) => `${hint.source}:${hint.key}`));

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
  livePollingEnabled = true,
  access: {
    readonly enabled: () => boolean;
    readonly subscribe: (listener: (enabled: boolean) => void) => () => void;
  } = {
    enabled: () => true,
    subscribe: () => () => undefined,
  },
) => Layer.effect(SnapshotsService, Effect.gen(function* () {
  let state: SnapshotState = emptyState;
  let lastHints: ReadonlyArray<BindingHint> | undefined;
  let started = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<(state: SnapshotState) => void>();

  let sequenceCounter = 0;
  let lastCommittedSequence = 0;

  let inFlight: { readonly hints: ReadonlyArray<BindingHint> | undefined; readonly promise: Promise<SnapshotState> } | null =
    null;

  const runRefresh = async (
    _hints: ReadonlyArray<BindingHint> | undefined,
    sequence: number,
  ): Promise<SnapshotState> => {
    const hermes = await guarded("hermes", () => fetchHermesBundle());

    if (access.enabled() && sequence >= lastCommittedSequence) {
      lastCommittedSequence = sequence;
      const previous = state.bundles.find((bundle) => bundle.source === "hermes");
      state = { bundles: [retainLastKnownFacts(previous, hermes)] };
      for (const listener of listeners) listener(state);
    }

    return state;
  };

  const refresh = (hints?: ReadonlyArray<BindingHint>): Promise<SnapshotState> => {
    if (!livePollingEnabled || !access.enabled()) return Promise.resolve(state);
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

  const stopPolling = (): void => {
    if (pollTimer !== undefined) clearInterval(pollTimer);
    pollTimer = undefined;
  };

  const syncPolling = (): void => {
    stopPolling();
    if (!started || !livePollingEnabled || !access.enabled()) {
      if (!livePollingEnabled || !access.enabled()) {
        lastCommittedSequence = ++sequenceCounter;
        inFlight = null;
      }
      if (state.bundles.length > 0) {
        state = emptyState;
        for (const listener of listeners) listener(state);
      }
      return;
    }
    void refresh(lastHints);
    pollTimer = setInterval(() => void refresh(lastHints), POLL_INTERVAL_MS);
    pollTimer.unref();
  };

  const unsubscribeAccess = access.subscribe(() => syncPolling());
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unsubscribeAccess();
      stopPolling();
      listeners.clear();
    }),
  );

  return SnapshotsService.of({
    doctor: Effect.sync(() => {
      if (!livePollingEnabled || !access.enabled()) {
        return {
          id: "snapshots",
          label: "Adapter Snapshots",
          status: "ok" as const,
          detail: livePollingEnabled
            ? "Hermes access disabled until explicitly enabled in Settings"
            : "optional live adapters disabled for this build",
          metadata: {
            fleetBlind: "false",
            freshFacts: "0",
            staleFacts: "0",
          } as Record<string, string>,
        };
      }
      const hermes = state.bundles.find((bundle) => bundle.source === "hermes");
      if (!hermes) {
        return {
          id: "snapshots",
          label: "Adapter Snapshots",
          status: "warning" as const,
          detail: "hermes not refreshed yet - fleet state unknown",
          metadata: { fleetBlind: "true", freshFacts: "0", staleFacts: "0" },
        };
      }
      const staleFacts = hermes.entities.filter((entity) => entity.stale === true).length;
      const freshFacts = hermes.entities.length - staleFacts;
      if (hermes.ok) {
        return {
          id: "snapshots",
          label: "Adapter Snapshots",
          status: "ok" as const,
          detail: `hermes fresh - ${freshFacts} fact(s)`,
          metadata: {
            fleetBlind: "false",
            freshFacts: String(freshFacts),
            staleFacts: String(staleFacts),
            lastSuccessfulAt: hermes.lastSuccessfulAt ?? hermes.fetchedAt,
          },
        };
      }
      return {
        id: "snapshots",
        label: "Adapter Snapshots",
        status: "warning" as const,
        detail:
          `fleet-blind - ${hermes.error ?? "hermes refresh failed"} - ` +
          `${freshFacts} current / ${staleFacts} last-known fact(s)`,
        metadata: {
          fleetBlind: "true",
          freshFacts: String(freshFacts),
          staleFacts: String(staleFacts),
          ...(hermes.lastSuccessfulAt === undefined
            ? {}
            : { lastSuccessfulAt: hermes.lastSuccessfulAt }),
        },
      };
    }),
    current: Effect.sync(() => state),
    refresh: (hints) => Effect.promise(() => refresh(hints)),
    start: () => {
      if (started) return;
      started = true;
      syncPolling();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}));

export const SnapshotsLive = Layer.unwrap(
  Effect.map(
    Effect.all({ plane: HermesPlane, preferences: UsagePreferences }),
    ({ plane, preferences }) =>
      makeSnapshotsLive(
        HERMES_INTEGRATION_ENABLED
          ? plane.fetchBundle
          : async () => ({
              source: "hermes" as const,
              fetchedAt: new Date().toISOString(),
              ok: true,
              entities: [],
            }),
        HERMES_INTEGRATION_ENABLED,
        {
          enabled: () => preferences.enabledSources().has("hermes"),
          subscribe: (listener) =>
            preferences.subscribeEnabledSources((enabled) => listener(enabled.has("hermes"))),
        },
      ),
  ),
);
