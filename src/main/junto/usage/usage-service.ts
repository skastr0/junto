import { Context, Effect, Layer } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import {
  hasUsageQuotas,
  usageStateIsPartial,
  type UsageSnapshot,
  type UsageState,
} from "@shared/usage";
import { UsageCache } from "./usage-cache";
import { UsagePreferences } from "./preferences";
import { UsageSources } from "./usage-source";

// Provider usage plane read service.
//
// Architecture:
//   disk last-good  →  instant HUD paint when cached quotas match active sources
//   primary fetch   →  fan-out active sources in registry order, commit all
//   enrich stage    →  optional per-source second push after first paint
//   failed live     →  KEEP last-good when present; else empty (HUD hides)
//
// Fail open: no quotas → empty state, no error chrome. Failures are total
// at the source envelope, never throws across IPC.

/**
 * effect-foundation **S4-rest-main** (staged, not half-migrated):
 * - Canonical id: `@vellum/UsageService` — single definition; no dual path.
 * - Service id: Context.Service (Effect V4 live).
 * - Shape:
 *   `class UsageService extends Context.Service<UsageService, UsageService>()("@junto/UsageService") {}`
 * - Layer today: UsageServiceLive (UsageLive merges sources+cache) — V4 rename candidate UsageService.layer
 *   Do not dual-export Live + `.layer` names.
 */
export class UsageService extends Context.Service<UsageService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly current: Effect.Effect<UsageState>;
    readonly refresh: () => Effect.Effect<UsageState>;
    readonly start: () => void;
    readonly subscribe: (listener: (state: UsageState) => void) => () => void;
  }>()("@junto/UsageService") {}

const emptyState: UsageState = { snapshots: [] };

// Live cadence only — first poll is immediate on start().
const POLL_INTERVAL_MS = 300_000;

const liveErrorMessage = (snapshots: ReadonlyArray<UsageSnapshot>): string | undefined => {
  const failed = snapshots.find((snapshot) => !snapshot.ok);
  if (!failed) return undefined;
  return failed.error ?? failed.reason ?? "usage refresh failed";
};

export const UsageServiceLive = Layer.effect(
  UsageService,
  Effect.gen(function* () {
    const sources = yield* UsageSources;
    const cache = yield* UsageCache;
    const preferences = yield* UsagePreferences;
    const runtime = yield* Effect.context<never>();

    const activeSources = () => {
      const enabled = preferences.enabledSources();
      return sources.filter((source) => enabled.has(source.id));
    };

    /** Drop stale cache rows and every source the operator has not enabled. */
    const keepActive = (snapshots: ReadonlyArray<UsageSnapshot>): ReadonlyArray<UsageSnapshot> =>
      snapshots.filter((snapshot) => activeSources().some((source) => source.id === snapshot.source));

    // Instant paint from SQLite when available (always stale until live lands).
    // Cache faults are non-fatal at this read-plane boundary.
    const cached =
      (yield* cache.loadLastGood.pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )) ?? undefined;
    let state: UsageState = emptyState;
    if (cached !== undefined) {
      const snapshots = keepActive(cached.snapshots);
      if (hasUsageQuotas({ snapshots })) {
        state = {
          snapshots: [...snapshots],
          stale: true,
          ...(cached.lastLiveAt !== undefined ? { lastLiveAt: cached.lastLiveAt } : {}),
        };
      }
    }
    let started = false;
    const listeners = new Set<(state: UsageState) => void>();
    let inFlight: Promise<UsageState> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let accessGeneration = 0;
    let accessAbort = new AbortController();

    const runAccess = <A>(effect: Effect.Effect<A>): Promise<A> =>
      Effect.runPromiseWith(runtime)(effect, { signal: accessAbort.signal });

    const abortAdmittedAccess = (): void => {
      accessAbort.abort();
      accessAbort = new AbortController();
      accessGeneration += 1;
      inFlight = null;
    };

    const notify = (next: UsageState): UsageState => {
      state = next;
      for (const listener of listeners) listener(state);
      return state;
    };

    /** Commit a successful live payload (has quotas) — persist + clear stale. */
    const commitLive = async (
      snapshots: ReadonlyArray<UsageSnapshot>,
      generation: number,
    ): Promise<UsageState> => {
      if (generation !== accessGeneration) return state;
      const next: UsageState = {
        snapshots: [...snapshots],
        stale: false,
        lastLiveAt: new Date().toISOString(),
      };
      // Usage is an observational HUD. A persistence fault must not turn a
      // successful provider poll into a service failure.
      await Effect.runPromiseWith(runtime)(
        cache.saveLastGood(next).pipe(Effect.catch(() => Effect.void)),
      );
      if (generation !== accessGeneration) return state;
      return notify(next);
    };

    /**
     * Live returned nothing useful. Never wipe last-good quotas — mark stale
     * and keep painting the previous rows. With no last-good: empty state so
     * the HUD hides (fail open — no error chip for missing CLI / empty poll).
     */
    const commitFailedLive = (
      snapshots: ReadonlyArray<UsageSnapshot>,
      generation: number,
    ): UsageState => {
      if (generation !== accessGeneration) return state;
      const error = liveErrorMessage(snapshots);
      if (hasUsageQuotas(state)) {
        return notify({
          snapshots: state.snapshots,
          stale: true,
          ...(state.lastLiveAt !== undefined ? { lastLiveAt: state.lastLiveAt } : {}),
          ...(error !== undefined ? { lastError: error } : {}),
        });
      }
      return notify({
        ...emptyState,
        stale: true,
        ...(error !== undefined ? { lastError: error } : {}),
      });
    };

    const applyPrimary = async (
      snapshots: ReadonlyArray<UsageSnapshot>,
      generation: number,
    ): Promise<UsageState> => {
      if (generation !== accessGeneration) return state;
      const kept = keepActive(snapshots);
      const live: UsageState = { snapshots: [...kept] };
      return hasUsageQuotas(live)
        ? await commitLive(kept, generation)
        : commitFailedLive(kept, generation);
    };

    const runEnrich = async (
      primary: ReadonlyArray<UsageSnapshot>,
      generation: number,
    ): Promise<void> => {
      if (generation !== accessGeneration) return;
      const enrichable = activeSources().filter((source) => source.enrich !== undefined);
      if (enrichable.length === 0) return;
      const enriched = await runAccess(
        Effect.all(
          enrichable.map((source) =>
            Effect.map(source.enrich!, (snapshot) => ({ id: source.id, snapshot })),
          ),
          { concurrency: "unbounded" },
        ),
      );
      if (generation !== accessGeneration) return;
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
      if (changed) await commitLive(keepActive(next), generation);
    };

    const runRefresh = async (): Promise<UsageState> => {
      const generation = accessGeneration;
      const admitted = activeSources();
      if (admitted.length === 0) return notify(emptyState);
      let snapshots: ReadonlyArray<UsageSnapshot>;
      try {
        snapshots = await runAccess(
          Effect.all(
            admitted.map((source) => source.fetch),
            { concurrency: "unbounded" },
          ),
        );
      } catch {
        if (generation !== accessGeneration) return state;
        return commitFailedLive([], generation);
      }
      if (generation !== accessGeneration) return state;
      const committed = await applyPrimary(snapshots, generation);
      // Multi-account enrich must not delay first paint.
      void runEnrich(snapshots, generation).catch(() => undefined);
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

    const stopPolling = (): void => {
      if (pollTimer !== undefined) clearInterval(pollTimer);
      pollTimer = undefined;
    };

    const restartPolling = (): void => {
      stopPolling();
      if (!started || activeSources().length === 0) return;
      void refresh();
      pollTimer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
      pollTimer.unref();
    };

    const unsubscribeAccess = preferences.subscribeEnabledSources(() => {
      // Fence old provider work and abort admitted filesystem/Keychain/network
      // stages so later fallback/retry work never starts for a revoked source.
      abortAdmittedAccess();
      notify({ ...state, snapshots: keepActive(state.snapshots) });
      restartPolling();
    });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stopPolling();
        unsubscribeAccess();
        abortAdmittedAccess();
      }),
    );

    return UsageService.of({
      doctor: Effect.gen(function* () {
        const admitted = activeSources();
        if (admitted.length === 0) {
          return {
            id: "usage",
            label: "Provider Usage",
            status: "ok" as const,
            detail: "disabled until a provider is explicitly enabled in Settings",
          };
        }
        const detected = yield* Effect.promise(() =>
          runAccess(
            Effect.all(
              admitted.map((source) =>
                Effect.map(source.detect, (present) => ({ id: source.id, present })),
              ),
              { concurrency: "unbounded" },
            ),
          ).catch(() => admitted.map((source) => ({ id: source.id, present: false }))),
        );
        const available = detected.filter((entry) => entry.present);
        const okProviders = state.snapshots
          .filter((snapshot) => snapshot.ok)
          .reduce((count, snapshot) => count + snapshot.quotas.filter((quota) => quota.status === "ok").length, 0);
        const staleNote = state.stale ? " - showing last-good" : "";
        const partialNote = usageStateIsPartial(state) ? " - partial" : "";
        return available.length > 0
          ? {
              id: "usage",
              label: "Provider Usage",
              status: "ok" as const,
              detail: `${available.map((entry) => entry.id).join(", ")} - ${okProviders} providers${staleNote}${partialNote}`,
            }
          : {
              id: "usage",
              label: "Provider Usage",
              status: "warning" as const,
              detail: `no configured usage source detected (checked: ${detected.map((entry) => entry.id).join(", ")}) - usage bar hidden`,
            };
      }),
      current: Effect.sync(() => state),
      refresh: () => Effect.promise(() => refresh()),
      start: () => {
        if (started) return;
        started = true;
        // No enabled source means no local credential/filesystem/network work.
        restartPolling();
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
