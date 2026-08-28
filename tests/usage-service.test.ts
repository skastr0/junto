import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UsageSnapshot, UsageState } from "../src/shared/usage";
import {
  UsageCache,
  UsageCacheError,
} from "../src/main/vellum/usage/usage-cache";
import { UsageSources, type UsageSource } from "../src/main/vellum/usage/usage-source";
import { UsageService, UsageServiceLive } from "../src/main/vellum/usage/usage-service";

// UsageService mirrors SnapshotsService: closure state, single in-flight
// fan-out, subscribe, idempotent start. Sources are total (envelope-folded),
// so refresh never rejects. Tests inject fakes via Layer.succeed(UsageSources).

const okSnapshot = (source: string, providers: ReadonlyArray<string>): UsageSnapshot => ({
  source,
  fetchedAt: "2026-07-17T00:00:00.000Z",
  ok: true,
  quotas: providers.map((provider) => ({
    provider,
    source: "test",
    status: "ok" as const,
    windows: [{ label: "primary" as const, usedPercent: 42 }],
    updatedAt: "2026-07-17T00:00:00.000Z",
  })),
});

const missingSnapshot = (source: string): UsageSnapshot => ({
  source,
  fetchedAt: "2026-07-17T00:00:00.000Z",
  ok: false,
  reason: "cli-missing",
  quotas: [],
});

const fakeSource = (
  id: string,
  options: {
    readonly present?: boolean;
    readonly fetch: () => Promise<UsageSnapshot> | UsageSnapshot;
  },
): UsageSource => {
  let fetchCount = 0;
  return {
    id,
    detect: Effect.succeed(options.present ?? true),
    fetch: Effect.promise(async () => {
      fetchCount += 1;
      return await options.fetch();
    }),
    // Expose for assertions without breaking the interface.
    get fetchCount() {
      return fetchCount;
    },
  } as UsageSource & { readonly fetchCount: number };
};

let runtime: ManagedRuntime.ManagedRuntime<UsageService, never>;
let sources: Array<UsageSource & { readonly fetchCount: number }>;

const emptyCache = UsageCache.of({
  loadLastGood: Effect.succeed(undefined),
  saveLastGood: () => Effect.void,
});

const makeUsageRuntime = (
  sourceValues: ReadonlyArray<UsageSource>,
  cache = emptyCache,
): ManagedRuntime.ManagedRuntime<UsageService, never> =>
  ManagedRuntime.make(
    Layer.provideMerge(
      UsageServiceLive,
      Layer.mergeAll(
        Layer.succeed(UsageSources, sourceValues),
        Layer.succeed(UsageCache, cache),
      ),
    ),
  );

beforeEach(() => {
  sources = [
    fakeSource("alpha", {
      fetch: () => okSnapshot("alpha", ["claude", "codex"]),
    }) as UsageSource & { readonly fetchCount: number },
    fakeSource("beta", {
      present: false,
      fetch: () => missingSnapshot("beta"),
    }) as UsageSource & { readonly fetchCount: number },
  ];
  runtime = makeUsageRuntime(sources);
});

afterEach(async () => {
  await runtime.dispose();
});

describe("UsageService", () => {
  it("current is empty before any refresh", async () => {
    const usage = await runtime.runPromise(UsageService);
    const state = await runtime.runPromise(usage.current);
    expect(state).toEqual({ snapshots: [] });
  });

  it("refresh merges snapshots from all sources and never rejects", async () => {
    const usage = await runtime.runPromise(UsageService);
    const state = await runtime.runPromise(usage.refresh());
    expect(state.snapshots.map((snapshot) => snapshot.source)).toEqual(["alpha", "beta"]);
    expect(state.snapshots[0]?.ok).toBe(true);
    expect(state.snapshots[0]?.quotas).toHaveLength(2);
    expect(state.snapshots[1]?.ok).toBe(false);
    expect(state.snapshots[1]?.reason).toBe("cli-missing");
    const current = await runtime.runPromise(usage.current);
    expect(current).toEqual(state);
  });

  it("subscribe replays current then fires on refresh; unsub stops", async () => {
    const usage = await runtime.runPromise(UsageService);
    const seen: UsageState[] = [];
    const unsub = usage.subscribe((state) => seen.push(state));
    // Immediate replay of empty/cached current.
    expect(seen).toHaveLength(1);
    await runtime.runPromise(usage.refresh());
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[seen.length - 1]?.snapshots).toHaveLength(2);
    unsub();
    const after = seen.length;
    await runtime.runPromise(usage.refresh());
    expect(seen).toHaveLength(after);
  });

  it("keeps last-good quotas when a later live refresh fails", async () => {
    let mode: "ok" | "fail" = "ok";
    sources = [
      fakeSource("alpha", {
        fetch: () => (mode === "ok" ? okSnapshot("alpha", ["claude"]) : missingSnapshot("alpha")),
      }) as UsageSource & { readonly fetchCount: number },
    ];
    await runtime.dispose();
    runtime = makeUsageRuntime(sources);
    const usage = await runtime.runPromise(UsageService);
    const good = await runtime.runPromise(usage.refresh());
    expect(good.stale).toBe(false);
    expect(good.snapshots[0]?.quotas).toHaveLength(1);

    mode = "fail";
    const kept = await runtime.runPromise(usage.refresh());
    expect(kept.stale).toBe(true);
    expect(kept.snapshots[0]?.ok).toBe(true);
    expect(kept.snapshots[0]?.quotas[0]?.provider).toBe("claude");
    expect(kept.lastError).toBeTruthy();
  });

  it("concurrent refresh joins the in-flight fan-out", async () => {
    let resolveFetch!: (snapshot: UsageSnapshot) => void;
    const delayed = new Promise<UsageSnapshot>((resolve) => {
      resolveFetch = resolve;
    });
    sources = [
      fakeSource("slow", {
        fetch: () => delayed,
      }) as UsageSource & { readonly fetchCount: number },
    ];
    await runtime.dispose();
    runtime = makeUsageRuntime(sources);
    const usage = await runtime.runPromise(UsageService);

    const first = runtime.runPromise(usage.refresh());
    const second = runtime.runPromise(usage.refresh());
    // Let the single in-flight Effect.all reach the source fetch before we
    // release it — both callers must already share that one promise.
    await new Promise((resolve) => setTimeout(resolve, 5));
    resolveFetch(okSnapshot("slow", ["gemini"]));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a.snapshots[0]?.quotas[0]?.provider).toBe("gemini");
    // Single fan-out despite two concurrent callers.
    expect(sources[0]!.fetchCount).toBe(1);
  });

  it("start is idempotent: one immediate refresh only", async () => {
    const usage = await runtime.runPromise(UsageService);
    usage.start();
    usage.start();
    // Allow the fire-and-forget first refresh to settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sources[0]!.fetchCount).toBe(1);
    expect(sources[1]!.fetchCount).toBe(1);
    const state = await runtime.runPromise(usage.current);
    expect(state.snapshots).toHaveLength(2);
  });

  it("keeps successful live state when durable cache persistence fails", async () => {
    await runtime.dispose();
    const failingCache = UsageCache.of({
      loadLastGood: Effect.succeed(undefined),
      saveLastGood: () =>
        Effect.fail(
          UsageCacheError.make({
            operation: "save-last-good",
            message: "database unavailable",
            cause: new Error("database unavailable"),
          }),
        ),
    });
    runtime = makeUsageRuntime(sources, failingCache);

    const usage = await runtime.runPromise(UsageService);
    const live = await runtime.runPromise(usage.refresh());

    expect(live.stale).toBe(false);
    expect(live.snapshots[0]?.quotas).toHaveLength(2);
    expect(await runtime.runPromise(usage.current)).toEqual(live);
  });

  it("doctor reports ok when a source is present and warning when none are", async () => {
    const usage = await runtime.runPromise(UsageService);
    await runtime.runPromise(usage.refresh());
    const okCheck = await runtime.runPromise(usage.doctor);
    expect(okCheck.id).toBe("usage");
    expect(okCheck.status).toBe("ok");
    expect(okCheck.detail).toContain("alpha");
    expect(okCheck.detail).toContain("2 providers");

    // Registry with no present sources.
    await runtime.dispose();
    const absent = [
      fakeSource("ghost", {
        present: false,
        fetch: () => missingSnapshot("ghost"),
      }) as UsageSource & { readonly fetchCount: number },
    ];
    runtime = makeUsageRuntime(absent);
    const usage2 = await runtime.runPromise(UsageService);
    const warnCheck = await runtime.runPromise(usage2.doctor);
    expect(warnCheck.status).toBe("warning");
    // Honest aggregate: names what was checked, not one retired tool.
    expect(warnCheck.detail).toContain("no configured usage source detected");
    expect(warnCheck.detail).toContain("ghost");
  });

  it("fail-open: all sources missing with no last-good yields empty (HUD hides)", async () => {
    await runtime.dispose();
    sources = [
      fakeSource("grok", {
        present: false,
        fetch: () => missingSnapshot("grok"),
      }) as UsageSource & { readonly fetchCount: number },
    ];
    runtime = makeUsageRuntime(sources);
    const usage = await runtime.runPromise(UsageService);
    const state = await runtime.runPromise(usage.refresh());
    expect(state.snapshots).toEqual([]);
    expect(state.stale).toBe(true);
    expect(state.lastError).toBeTruthy();
  });

  it("drops cached snapshots from sources not in the live registry", async () => {
    await runtime.dispose();
    const seed: UsageState = {
      snapshots: [
        okSnapshot("claude", ["claude"]),
        okSnapshot("grok", ["grok-web"]),
      ],
      lastLiveAt: "2026-07-17T00:00:00.000Z",
    };
    const cache = UsageCache.of({
      loadLastGood: Effect.succeed(seed),
      saveLastGood: () => Effect.void,
    });
    sources = [
      fakeSource("claude", {
        fetch: () => okSnapshot("claude", ["claude", "codex"]),
      }) as UsageSource & { readonly fetchCount: number },
    ];
    runtime = makeUsageRuntime(sources, cache);
    const usage = await runtime.runPromise(UsageService);
    const current = await runtime.runPromise(usage.current);
    // Cache rows from sources not in the registry filtered out; only the
    // configured source's last-good paints.
    expect(current.snapshots.map((s) => s.source)).toEqual(["claude"]);
    expect(current.stale).toBe(true);
    expect(current.snapshots[0]?.quotas.map((q) => q.provider)).toEqual(["claude"]);
  });
});
