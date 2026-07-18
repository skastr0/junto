import { Context, Effect, Layer } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import type { UsageSnapshot, UsageState } from "@shared/usage";
import { readUsageCache, writeUsageCache } from "./usage-cache";
import { UsageSources } from "./usage-source";

// The provider usage plane's read service. Mirrors SnapshotsService
// (snapshots.ts): closure-held state, idempotent poll loop, subscribe for
// renderer pushes. Unlike the entity plane there are no binding hints —
// every refresh is a full fan-out over the registered UsageSources, and
// refresh can never reject because every source's fetch is total (failures
// arrive folded into the UsageSnapshot envelope).
//
// Boot paint: last-good cache is loaded synchronously so the HUD is not blank
// while codexbar runs. Primary fetch commits as soon as it returns; optional
// source.enrich stages (multi-account codex) land as a second push.
export class UsageService extends Context.Tag("@vellum/UsageService")<
  UsageService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly current: Effect.Effect<UsageState>;
    readonly refresh: () => Effect.Effect<UsageState>;
    // Begin the background poll loop. Idempotent. Fires first poll immediately.
    readonly start: () => void;
    readonly subscribe: (listener: (state: UsageState) => void) => () => void;
  }
>() {}

const emptyState: UsageState = { snapshots: [] };

// Deliberately NOT the 60s entity-snapshot loop — codexbar hits vendor web
// endpoints. Primary poll is immediate on start; this is only the cadence.
const POLL_INTERVAL_MS = 300_000;

export const UsageServiceLive = Layer.effect(
  UsageService,
  Effect.gen(function* () {
    const sources = yield* UsageSources;
    // Instant paint from disk when available.
    let state: UsageState = readUsageCache() ?? emptyState;
    let started = false;
    const listeners = new Set<(state: UsageState) => void>();

    // One primary refresh at a time: concurrent callers join the in-flight fan-out.
    let inFlight: Promise<UsageState> | null = null;

    const commit = (next: UsageState): UsageState => {
      state = next;
      writeUsageCache(state);
      for (const listener of listeners) listener(state);
      return state;
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
      let next = [...primary];
      let changed = false;
      for (const entry of enriched) {
        if (entry.snapshot === undefined) continue;
        const index = next.findIndex((snapshot) => snapshot.source === entry.id);
        if (index >= 0) {
          next[index] = entry.snapshot;
        } else {
          next = [...next, entry.snapshot];
        }
        changed = true;
      }
      if (changed) commit({ snapshots: next });
    };

    const runRefresh = async (): Promise<UsageState> => {
      const snapshots = await Effect.runPromise(
        Effect.all(
          sources.map((source) => source.fetch),
          { concurrency: "unbounded" },
        ),
      );
      const committed = commit({ snapshots });
      // Multi-account (and any future enrich stages) must not delay first paint.
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
        return available.length > 0
          ? {
              id: "usage",
              label: "Provider Usage",
              status: "ok" as const,
              detail: `${available.map((entry) => entry.id).join(", ")} · ${okProviders} providers tracked`,
            }
          : {
              id: "usage",
              label: "Provider Usage",
              status: "warning" as const,
              detail: "no usage sources detected (codexbar CLI absent?) — usage HUD hidden",
            };
      }),
      current: Effect.sync(() => state),
      refresh: () => Effect.promise(() => refresh()),
      start: () => {
        if (started) return;
        started = true;
        // First poll immediately — do not wait for the interval.
        void refresh();
        setInterval(() => void refresh(), POLL_INTERVAL_MS).unref();
      },
      subscribe: (listener) => {
        listeners.add(listener);
        // Push cached state immediately so late subscribers (renderer mount)
        // do not wait for the in-flight primary fetch to finish.
        if (state.snapshots.length > 0) listener(state);
        return () => listeners.delete(listener);
      },
    });
  }),
);
