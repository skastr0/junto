import { Context, Effect, Layer } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import {
  hasUsageQuotas,
  preferNativeUsageSnapshots,
  usageStateIsPartial,
  type UsageSnapshot,
  type UsageState,
} from "@shared/usage";
import { UsageCache } from "./usage-cache";
import { UsageSources } from "./usage-source";

// Provider usage plane read service.
//
// Architecture (native harness homes first; codexbar optional):
//   disk last-good  →  instant HUD paint (always show UI when we have quotas)
//   primary fetch   →  fan-out all sources; prefer native over codexbar per provider
//   enrich stage    →  multi-account codexbar as a second push
//   failed live     →  KEEP last-good, mark stale + lastError (never blank the bar)
//
// Failures are total at the source envelope, never throws across IPC.

export class UsageService extends Context.Tag("@vellum/UsageService")<
  UsageService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly current: Effect.Effect<UsageState>;
    readonly refresh: () => Effect.Effect<UsageState>;
    readonly start: () => void;
    readonly subscribe: (listener: (state: UsageState) => void) => () => void;
  }
>() {}

const emptyState: UsageState = { snapshots: [] };

// Live cadence only — first poll is immediate on start().
const POLL_INTERVAL_MS = 300_000;

const liveErrorMessage = (snapshots: ReadonlyArray<UsageSnapshot>): string | undefined => {
  const failed = snapshots.find((snapshot) => !snapshot.ok);
  if (!failed) return undefined;
  return failed.error ?? failed.reason ?? "usage refresh failed";
};

export const UsageServiceLive = Layer.scoped(
  UsageService,
  Effect.gen(function* () {
    const sources = yield* UsageSources;
    const cache = yield* UsageCache;
    // Instant paint from SQLite when available (always stale until live lands).
    // Cache faults are non-fatal at this read-plane boundary.
    let state: UsageState =
      (yield* cache.loadLastGood.pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
      )) ?? emptyState;
    let started = false;
    const listeners = new Set<(state: UsageState) => void>();
    let inFlight: Promise<UsageState> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (pollTimer !== undefined) clearInterval(pollTimer);
      }),
    );

    const notify = (next: UsageState): UsageState => {
      state = next;
      for (const listener of listeners) listener(state);
      return state;
    };

    /** Commit a successful live payload (has quotas) — persist + clear stale. */
    const commitLive = async (
      snapshots: ReadonlyArray<UsageSnapshot>,
    ): Promise<UsageState> => {
      const next: UsageState = {
        snapshots: [...snapshots],
        stale: false,
        lastLiveAt: new Date().toISOString(),
      };
      // Usage is an observational HUD. A persistence fault must not turn a
      // successful provider poll into a service failure.
      await Effect.runPromise(
        cache.saveLastGood(next).pipe(Effect.catchAll(() => Effect.void)),
      );
      return notify(next);
    };

    /**
     * Live returned nothing useful. Never wipe last-good quotas — mark stale
     * and keep painting the previous rows.
     */
    const commitFailedLive = (snapshots: ReadonlyArray<UsageSnapshot>): UsageState => {
      const error = liveErrorMessage(snapshots);
      if (hasUsageQuotas(state)) {
        return notify({
          snapshots: state.snapshots,
          stale: true,
          ...(state.lastLiveAt !== undefined ? { lastLiveAt: state.lastLiveAt } : {}),
          ...(error !== undefined ? { lastError: error } : {}),
        });
      }
      // No last-good yet: surface the failure envelope so the HUD can chip it.
      return notify({
        snapshots: [...snapshots],
        stale: true,
        ...(error !== undefined ? { lastError: error } : {}),
      });
    };

    const applyPrimary = async (
      snapshots: ReadonlyArray<UsageSnapshot>,
    ): Promise<UsageState> => {
      const ranked = preferNativeUsageSnapshots(snapshots);
      const live: UsageState = { snapshots: [...ranked] };
      return hasUsageQuotas(live)
        ? await commitLive(ranked)
        : commitFailedLive(ranked);
    };

    const runEnrich = async (primary: ReadonlyArray<UsageSnapshot>): Promise<void> => {
      const enrichable = sources.filter((source) => source.enrich !== undefined);
      if (enrichable.length === 0) return;
      const enriched = await Effect.runPromise(
        Effect.all(
          enrichable.map((source) =>
            Effect.map(source.enrich!, (snapshot) => ({ id: source.id, snapshot })),
          ),
          { concurrency: "unbounded" },
        ),
      );
      let next = [...(hasUsageQuotas(state) ? state.snapshots : primary)];
      let changed = false;
      for (const entry of enriched) {
        if (entry.snapshot === undefined || !entry.snapshot.ok || entry.snapshot.quotas.length === 0) {
          continue;
        }
        const index = next.findIndex((snapshot) => snapshot.source === entry.id);
        if (index >= 0) {
          next[index] = entry.snapshot;
        } else {
          next = [...next, entry.snapshot];
        }
        changed = true;
      }
      if (changed) await commitLive(preferNativeUsageSnapshots(next));
    };

    const runRefresh = async (): Promise<UsageState> => {
      const snapshots = await Effect.runPromise(
        Effect.all(
          sources.map((source) => source.fetch),
          { concurrency: "unbounded" },
        ),
      );
      const committed = await applyPrimary(snapshots);
      // Multi-account enrich must not delay first paint.
      void runEnrich(snapshots);
      return committed;
    };

    const refresh = (): Promise<UsageState> => {
      if (inFlight) return inFlight;
      const promise = runRefresh();
      inFlight = promise;
      void promise.finally(() => {
        if (inFlight === promise) inFlight = null;
      });
      return promise;
    };

    return UsageService.of({
      doctor: Effect.gen(function* () {
        const detected = yield* Effect.all(
          sources.map((source) => Effect.map(source.detect, (present) => ({ id: source.id, present }))),
          { concurrency: "unbounded" },
        );
        const available = detected.filter((entry) => entry.present);
        const okProviders = state.snapshots
          .filter((snapshot) => snapshot.ok)
          .reduce((count, snapshot) => count + snapshot.quotas.filter((quota) => quota.status === "ok").length, 0);
        const staleNote = state.stale ? " · showing last-good" : "";
        const partialNote = usageStateIsPartial(state) ? " · partial" : "";
        return available.length > 0
          ? {
              id: "usage",
              label: "Provider Usage",
              status: "ok" as const,
              detail: `${available.map((entry) => entry.id).join(", ")} · ${okProviders} providers${staleNote}${partialNote}`,
            }
          : {
              id: "usage",
              label: "Provider Usage",
              status: "warning" as const,
              detail: "no usage sources detected (harness homes / codexbar)",
            };
      }),
      current: Effect.sync(() => state),
      refresh: () => Effect.promise(() => refresh()),
      start: () => {
        if (started) return;
        started = true;
        // Immediate first poll — never wait for the interval.
        void refresh();
        pollTimer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
        pollTimer.unref();
      },
      subscribe: (listener) => {
        listeners.add(listener);
        // Always replay current (cache or empty) so late mounts paint.
        listener(state);
        return () => listeners.delete(listener);
      },
    });
  }),
);
