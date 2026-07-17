import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UsageSnapshot, UsageState } from "../src/shared/usage";
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
  runtime = ManagedRuntime.make(
    Layer.provideMerge(UsageServiceLive, Layer.succeed(UsageSources, sources)),
  );
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

  it("subscribe fires on refresh and unsub stops notifications", async () => {
    const usage = await runtime.runPromise(UsageService);
    const seen: UsageState[] = [];
    const unsub = usage.subscribe((state) => seen.push(state));
    await runtime.runPromise(usage.refresh());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.snapshots).toHaveLength(2);
    unsub();
    await runtime.runPromise(usage.refresh());
    expect(seen).toHaveLength(1);
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
    runtime = ManagedRuntime.make(
      Layer.provideMerge(UsageServiceLive, Layer.succeed(UsageSources, sources)),
    );
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

  it("doctor reports ok when a source is present and warning when none are", async () => {
    const usage = await runtime.runPromise(UsageService);
    await runtime.runPromise(usage.refresh());
    const okCheck = await runtime.runPromise(usage.doctor);
    expect(okCheck.id).toBe("usage");
    expect(okCheck.status).toBe("ok");
    expect(okCheck.detail).toContain("alpha");
    expect(okCheck.detail).toContain("2 providers tracked");

    // Registry with no present sources.
    await runtime.dispose();
    const absent = [
      fakeSource("ghost", {
        present: false,
        fetch: () => missingSnapshot("ghost"),
      }) as UsageSource & { readonly fetchCount: number },
    ];
    runtime = ManagedRuntime.make(
      Layer.provideMerge(UsageServiceLive, Layer.succeed(UsageSources, absent)),
    );
    const usage2 = await runtime.runPromise(UsageService);
    const warnCheck = await runtime.runPromise(usage2.doctor);
    expect(warnCheck.status).toBe("warning");
    expect(warnCheck.detail.toLowerCase()).toContain("no usage sources");
  });
});
