import { Context, Effect, Layer } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import type { UsageState } from "@shared/usage";
import { UsageSources } from "./usage-source";

// The provider usage plane's read service. Mirrors SnapshotsService
// (snapshots.ts): closure-held state, idempotent poll loop, subscribe for
// renderer pushes. Unlike the entity plane there are no binding hints —
// every refresh is a full fan-out over the registered UsageSources, and
// refresh can never reject because every source's fetch is total (failures
// arrive folded into the UsageSnapshot envelope).
export class UsageService extends Context.Tag("@vellum/UsageService")<
  UsageService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly current: Effect.Effect<UsageState>;
    readonly refresh: () => Effect.Effect<UsageState>;
    // Begin the background poll loop. Idempotent.
    readonly start: () => void;
    readonly subscribe: (listener: (state: UsageState) => void) => () => void;
  }
>() {}

const emptyState: UsageState = { snapshots: [] };

// codexbar takes ~15-20s per fetch; a 5-minute cadence keeps the HUD fresh
// without hammering the vendors' web endpoints. Deliberately NOT the 60s
// entity-snapshot loop.
const POLL_INTERVAL_MS = 300_000;

export const UsageServiceLive = Layer.effect(
  UsageService,
  Effect.gen(function* () {
    const sources = yield* UsageSources;
    let state: UsageState = emptyState;
    let started = false;
    const listeners = new Set<(state: UsageState) => void>();

    // One refresh at a time: concurrent callers join the in-flight fan-out.
    // No sequencing needed beyond that — every poll is a full replacement.
    let inFlight: Promise<UsageState> | null = null;

    const runRefresh = async (): Promise<UsageState> => {
      const snapshots = await Effect.runPromise(
        Effect.all(
          sources.map((source) => source.fetch),
          { concurrency: "unbounded" },
        ),
      );
      state = { snapshots };
      for (const listener of listeners) listener(state);
      return state;
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
        void refresh();
        // unref so a leaked interval in tests never pins the process; the
        // app's own lifetime keeps it alive in production.
        setInterval(() => void refresh(), POLL_INTERVAL_MS).unref();
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
  }),
);
