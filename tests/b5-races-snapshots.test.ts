import { ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SnapshotBundle } from "../src/shared/entities";
import type { BindingHint } from "../src/shared/ipc";
import { makeSnapshotsLive, SnapshotsService } from "../src/main/vellum/snapshots";

// reentrancy: sequence stamp + in-flight coalescing on hermes-only refresh

const mockFetchHermes = vi.fn<() => Promise<SnapshotBundle>>();

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const hermesBundle = (key: string): SnapshotBundle => ({
  source: "hermes",
  fetchedAt: new Date().toISOString(),
  ok: true,
  entities: [{ source: "hermes", key, kind: "agent", title: key, stats: {}, updatedAt: new Date().toISOString() }],
});

const hermesKeyOf = (state: { bundles: ReadonlyArray<SnapshotBundle> }): string | undefined =>
  state.bundles.find((b) => b.source === "hermes")?.entities[0]?.key;

let runtime: ManagedRuntime.ManagedRuntime<SnapshotsService, never>;

beforeEach(() => {
  mockFetchHermes.mockReset().mockResolvedValue(hermesBundle("h"));
  runtime = ManagedRuntime.make(makeSnapshotsLive(() => mockFetchHermes()));
});

afterEach(async () => {
  await runtime.dispose();
});

describe("snapshots.ts refresh() — newest-wins sequencing", () => {
  it("a slower older call never clobbers a faster newer one", async () => {
    let call = 0;
    mockFetchHermes.mockImplementation(async () => {
      const n = ++call;
      const isSlow = n === 1;
      await delay(isSlow ? 40 : 5);
      return hermesBundle(isSlow ? "A" : "B");
    });

    const snapshots = await runtime.runPromise(SnapshotsService);
    const seen: Array<string | undefined> = [];
    snapshots.subscribe((s) => seen.push(hermesKeyOf(s)));

    const hintsA: ReadonlyArray<BindingHint> = [{ source: "hermes", key: "a" }];
    const hintsB: ReadonlyArray<BindingHint> = [{ source: "hermes", key: "b" }];

    const [stateFromA, stateFromB] = await Promise.all([
      runtime.runPromise(snapshots.refresh(hintsA)),
      runtime.runPromise(snapshots.refresh(hintsB)),
    ]);

    expect(hermesKeyOf(stateFromA)).toBe("B");
    expect(hermesKeyOf(stateFromB)).toBe("B");
    expect(hermesKeyOf(await runtime.runPromise(snapshots.current))).toBe("B");
    expect(seen).toEqual(["B"]);
  });

  it("refresh() never throws when hermes fails", async () => {
    mockFetchHermes.mockRejectedValue(new Error("hermes down"));
    const snapshots = await runtime.runPromise(SnapshotsService);
    const result = await runtime.runPromise(snapshots.refresh());
    expect(result.bundles.every((b) => b.ok === false)).toBe(true);
  });
});

describe("snapshots.ts refresh() — in-flight coalescing", () => {
  it("identical in-flight hints join one fetch", async () => {
    mockFetchHermes.mockImplementation(async () => {
      await delay(30);
      return hermesBundle("only-call");
    });

    const snapshots = await runtime.runPromise(SnapshotsService);
    const hints: ReadonlyArray<BindingHint> = [{ source: "hermes", key: "shared" }];

    const [a, b] = await Promise.all([
      runtime.runPromise(snapshots.refresh(hints)),
      runtime.runPromise(snapshots.refresh(hints)),
    ]);

    expect(hermesKeyOf(a)).toBe("only-call");
    expect(hermesKeyOf(b)).toBe("only-call");
    expect(mockFetchHermes).toHaveBeenCalledTimes(1);
  });

  it("disjoint hints start separate fetches", async () => {
    mockFetchHermes.mockImplementation(async () => {
      await delay(20);
      return hermesBundle("h");
    });

    const snapshots = await runtime.runPromise(SnapshotsService);

    await Promise.all([
      runtime.runPromise(snapshots.refresh([{ source: "hermes", key: "one" }])),
      runtime.runPromise(snapshots.refresh([{ source: "hermes", key: "two" }])),
    ]);

    expect(mockFetchHermes).toHaveBeenCalledTimes(2);
  });
});
