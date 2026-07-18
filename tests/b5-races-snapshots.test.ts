import { ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SnapshotBundle } from "../src/shared/entities";
import type { BindingHint } from "../src/shared/ipc";

// b5-races: snapshots.ts refresh() had no reentrancy guard — overlapping
// calls (poll vs IPC-triggered, or two IPC-triggered refreshes) ran their
// full adapter fan-out concurrently and whichever Promise.all finished LAST
// won `state` + the listener broadcast, regardless of which call started
// last. Fixed with (1) a monotonic per-call sequence stamp so only a
// completion at-least-as-new as the last committed one is applied, and (2)
// in-flight coalescing so a call whose hints are already covered by a
// running refresh joins it instead of firing a redundant adapter fan-out.
// Tower is a single unhinted bulk call (`tower dashboards --json`); quasar
// still takes per-source hint keys, so quasar is the channel these tests use
// to tell concurrent refreshes apart.

const mockFetchTower = vi.fn<() => Promise<SnapshotBundle>>();
const mockFetchQuasar = vi.fn<(hintKeys: ReadonlyArray<string>) => Promise<SnapshotBundle>>();
const mockFetchBooth = vi.fn<(hintKeys: ReadonlyArray<string>) => Promise<SnapshotBundle>>();
const mockFetchHermes = vi.fn<() => Promise<SnapshotBundle>>();

vi.mock("../src/main/vellum/adapters/tower", () => ({
  fetchTowerBundle: (...args: ReadonlyArray<unknown>) => mockFetchTower(...(args as [])),
}));
vi.mock("../src/main/vellum/adapters/quasar", () => ({
  fetchQuasarBundle: (...args: [ReadonlyArray<string>]) => mockFetchQuasar(...args),
}));
vi.mock("../src/main/vellum/adapters/booth", () => ({
  fetchBoothBundle: (...args: [ReadonlyArray<string>]) => mockFetchBooth(...args),
}));
vi.mock("../src/main/vellum/adapters/hermes", () => ({
  fetchHermesBundle: () => mockFetchHermes(),
}));

import { makeSnapshotsLive, SnapshotsService } from "../src/main/vellum/snapshots";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const bundle = (source: SnapshotBundle["source"], key: string): SnapshotBundle => ({
  source,
  fetchedAt: new Date().toISOString(),
  ok: true,
  entities: [{ source, key, kind: "project", title: key, stats: {}, updatedAt: new Date().toISOString() }],
});

const quasarKeyOf = (state: { bundles: ReadonlyArray<SnapshotBundle> }): string | undefined =>
  state.bundles.find((b) => b.source === "quasar")?.entities[0]?.key;

let runtime: ManagedRuntime.ManagedRuntime<SnapshotsService, never>;

beforeEach(() => {
  mockFetchTower.mockReset().mockResolvedValue(bundle("tower", "t"));
  mockFetchQuasar.mockReset().mockResolvedValue(bundle("quasar", "q"));
  mockFetchBooth.mockReset().mockResolvedValue(bundle("booth", "b"));
  mockFetchHermes.mockReset().mockResolvedValue(bundle("hermes", "h"));
  runtime = ManagedRuntime.make(makeSnapshotsLive(() => mockFetchHermes()));
});

afterEach(async () => {
  await runtime.dispose();
});

describe("snapshots.ts refresh() — newest-wins sequencing", () => {
  it("a slower older call never clobbers a faster newer one; subscribers only ever see the final state", async () => {
    // Two genuinely distinct calls (disjoint quasar hints, so neither
    // subsumes the other and both actually fire their own fetch).
    mockFetchQuasar.mockImplementation(async (hintKeys) => {
      const isSlowCall = hintKeys.includes("proj-a");
      await delay(isSlowCall ? 40 : 5);
      return bundle("quasar", isSlowCall ? "A" : "B");
    });

    const snapshots = await runtime.runPromise(SnapshotsService);
    const seen: Array<string | undefined> = [];
    snapshots.subscribe((s) => seen.push(quasarKeyOf(s)));

    const hintsA: ReadonlyArray<BindingHint> = [{ source: "quasar", key: "proj-a" }];
    const hintsB: ReadonlyArray<BindingHint> = [{ source: "quasar", key: "proj-b" }];

    // A starts first (older, slow); B starts second (newer, fast) while A
    // is still in flight.
    const resultA = runtime.runPromise(snapshots.refresh(hintsA));
    const resultB = runtime.runPromise(snapshots.refresh(hintsB));

    const [stateFromA, stateFromB] = await Promise.all([resultA, resultB]);

    // Both callers observe the authoritative, newest-committed state (B) —
    // A's late completion never overwrote it, so there is no torn state
    // visible to either awaiter.
    expect(quasarKeyOf(stateFromA)).toBe("B");
    expect(quasarKeyOf(stateFromB)).toBe("B");

    const current = await runtime.runPromise(snapshots.current);
    expect(quasarKeyOf(current)).toBe("B");

    // The stale (A) completion must not have broadcast at all — subscribers
    // only ever see the final, correct state.
    expect(seen).toEqual(["B"]);
  });

  it("refresh() never throws even when every adapter call fails", async () => {
    mockFetchTower.mockRejectedValue(new Error("tower down"));
    mockFetchQuasar.mockRejectedValue(new Error("quasar down"));
    mockFetchBooth.mockRejectedValue(new Error("booth down"));
    mockFetchHermes.mockRejectedValue(new Error("hermes down"));

    const snapshots = await runtime.runPromise(SnapshotsService);
    const result = await runtime.runPromise(snapshots.refresh());

    expect(result.bundles.every((b) => b.ok === false)).toBe(true);
  });
});

describe("snapshots.ts refresh() — in-flight coalescing", () => {
  it("a call whose hints are already covered by an in-flight refresh joins it instead of firing a duplicate fetch", async () => {
    mockFetchTower.mockImplementation(async () => {
      await delay(30);
      return bundle("tower", "only-call");
    });

    const snapshots = await runtime.runPromise(SnapshotsService);
    const hints: ReadonlyArray<BindingHint> = [{ source: "quasar", key: "shared" }];

    const first = runtime.runPromise(snapshots.refresh(hints));
    const second = runtime.runPromise(snapshots.refresh(hints)); // identical hints, still in flight

    const [a, b] = await Promise.all([first, second]);

    expect(a.bundles.find((x) => x.source === "tower")?.entities[0]?.key).toBe("only-call");
    expect(b.bundles.find((x) => x.source === "tower")?.entities[0]?.key).toBe("only-call");
    // Exactly one underlying adapter fan-out — the second call joined the
    // first rather than duplicating it.
    expect(mockFetchTower).toHaveBeenCalledTimes(1);
  });

  it("a call needing hints NOT covered by the in-flight refresh starts its own fetch rather than joining", async () => {
    mockFetchTower.mockImplementation(async () => {
      await delay(20);
      return bundle("tower", "t");
    });

    const snapshots = await runtime.runPromise(SnapshotsService);

    const first = runtime.runPromise(snapshots.refresh([{ source: "quasar", key: "one" }]));
    const second = runtime.runPromise(snapshots.refresh([{ source: "quasar", key: "two" }]));

    await Promise.all([first, second]);

    expect(mockFetchTower).toHaveBeenCalledTimes(2);
  });
});

describe("snapshots.ts refresh() — tower bulk call", () => {
  it("calls fetchTowerBundle with no arguments (bulk dashboards needs no hints)", async () => {
    const snapshots = await runtime.runPromise(SnapshotsService);
    await runtime.runPromise(
      snapshots.refresh([
        { source: "tower", key: "proj-x" },
        { source: "quasar", key: "git:proj-x" },
      ]),
    );

    expect(mockFetchTower).toHaveBeenCalledTimes(1);
    expect(mockFetchTower.mock.calls[0]).toEqual([]);
  });
});
