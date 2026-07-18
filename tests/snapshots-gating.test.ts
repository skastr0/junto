import { ManagedRuntime } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SnapshotBundle } from "../src/shared/entities";

// Capability gating: an unconfigured private source (no config file, no env
// var — see source-capabilities.ts) is skipped by the refresh fan-out
// entirely: its adapter is never invoked, its bundle reads "not configured",
// and the detected capabilities ride SnapshotState so the renderer can hide
// the source's surfaces. Hermes is not a private source and always fetches.

const mockFetchTower = vi.fn<() => Promise<SnapshotBundle>>();
const mockFetchQuasar = vi.fn<(hintKeys: ReadonlyArray<string>) => Promise<SnapshotBundle>>();
const mockFetchBooth = vi.fn<() => Promise<SnapshotBundle>>();
const mockFetchHermes = vi.fn<() => Promise<SnapshotBundle>>();

vi.mock("../src/main/vellum/adapters/tower", () => ({
  fetchTowerBundle: (...args: ReadonlyArray<unknown>) => mockFetchTower(...(args as [])),
}));
vi.mock("../src/main/vellum/adapters/quasar", () => ({
  fetchQuasarBundle: (...args: [ReadonlyArray<string>]) => mockFetchQuasar(...args),
}));
vi.mock("../src/main/vellum/adapters/booth", () => ({
  fetchBoothBundle: () => mockFetchBooth(),
}));
vi.mock("../src/main/vellum/adapters/hermes", () => ({
  fetchHermesBundle: () => mockFetchHermes(),
}));

import { makeSnapshotsLive, SnapshotsService } from "../src/main/vellum/snapshots";
import type { SourceCapabilities } from "../src/shared/entities";

const bundle = (source: SnapshotBundle["source"], key: string): SnapshotBundle => ({
  source,
  fetchedAt: new Date().toISOString(),
  ok: true,
  entities: [{ source, key, kind: "project", title: key, stats: {}, updatedAt: new Date().toISOString() }],
});

const runtimeWith = (capabilities: SourceCapabilities) =>
  ManagedRuntime.make(makeSnapshotsLive(() => mockFetchHermes(), () => capabilities));

beforeEach(() => {
  mockFetchTower.mockReset().mockResolvedValue(bundle("tower", "t"));
  mockFetchQuasar.mockReset().mockResolvedValue(bundle("quasar", "q"));
  mockFetchBooth.mockReset().mockResolvedValue(bundle("booth", "b"));
  mockFetchHermes.mockReset().mockResolvedValue(bundle("hermes", "h"));
});

describe("snapshots.ts refresh() — capability gating", () => {
  it("never invokes unconfigured adapters, marks their bundles not configured, and reports capabilities", async () => {
    const runtime = runtimeWith({ tower: false, quasar: false, booth: false });
    const snapshots = await runtime.runPromise(SnapshotsService);
    const state = await runtime.runPromise(snapshots.refresh());

    expect(mockFetchTower).not.toHaveBeenCalled();
    expect(mockFetchQuasar).not.toHaveBeenCalled();
    expect(mockFetchBooth).not.toHaveBeenCalled();
    expect(mockFetchHermes).toHaveBeenCalledTimes(1);

    for (const source of ["tower", "quasar", "booth"] as const) {
      const skipped = state.bundles.find((b) => b.source === source);
      expect(skipped?.ok).toBe(false);
      expect(skipped?.error).toBe("not configured");
      expect(skipped?.entities).toEqual([]);
    }
    expect(state.bundles.find((b) => b.source === "hermes")?.ok).toBe(true);
    expect(state.capabilities).toEqual({ tower: false, quasar: false, booth: false });

    await runtime.dispose();
  });

  it("a partially configured station fetches only the configured sources", async () => {
    const runtime = runtimeWith({ tower: true, quasar: false, booth: false });
    const snapshots = await runtime.runPromise(SnapshotsService);
    const state = await runtime.runPromise(snapshots.refresh());

    expect(mockFetchTower).toHaveBeenCalledTimes(1);
    expect(mockFetchQuasar).not.toHaveBeenCalled();
    expect(mockFetchBooth).not.toHaveBeenCalled();

    expect(state.bundles.find((b) => b.source === "tower")?.ok).toBe(true);
    expect(state.bundles.find((b) => b.source === "quasar")?.error).toBe("not configured");
    expect(state.capabilities).toEqual({ tower: true, quasar: false, booth: false });

    await runtime.dispose();
  });
});
