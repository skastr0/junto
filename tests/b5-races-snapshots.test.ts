import { ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findEntity, findFreshEntity, type SnapshotBundle } from "../src/shared/entities";
import type { BindingHint } from "../src/shared/ipc";
import { makeSnapshotsLive, SnapshotsService } from "../src/main/vellum-command/snapshots";

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

  it("retains last-known facts as stale and reports fleet-blind after a total failure", async () => {
    const successfulAt = "2026-07-23T10:00:00.000Z";
    mockFetchHermes.mockResolvedValueOnce({
      ...hermesBundle("studio:agent"),
      fetchedAt: successfulAt,
    });
    const snapshots = await runtime.runPromise(SnapshotsService);
    await runtime.runPromise(snapshots.refresh());

    mockFetchHermes.mockRejectedValueOnce(new Error("command center unreachable"));
    const failed = await runtime.runPromise(snapshots.refresh());
    const bundle = failed.bundles[0]!;
    expect(bundle).toMatchObject({
      ok: false,
      stale: true,
      lastSuccessfulAt: successfulAt,
      error: "command center unreachable",
    });
    expect(findEntity(failed, "hermes", "studio:agent")?.stale).toBe(true);
    expect(findFreshEntity(failed, "hermes", "studio:agent")).toBeUndefined();

    const doctor = await runtime.runPromise(snapshots.doctor);
    expect(doctor.status).toBe("warning");
    expect(doctor.detail).toMatch(/fleet-blind/i);
    expect(doctor.metadata).toMatchObject({
      fleetBlind: "true",
      freshFacts: "0",
      staleFacts: "1",
      lastSuccessfulAt: successfulAt,
    });
  });

  it("keeps current local facts fresh while marking missing host facts stale on a partial read", async () => {
    const at = "2026-07-23T10:00:00.000Z";
    mockFetchHermes.mockResolvedValueOnce({
      source: "hermes",
      fetchedAt: at,
      ok: true,
      entities: [
        {
          source: "hermes",
          key: "studio:agent",
          kind: "agent",
          stats: { running: 0 },
          updatedAt: at,
        },
        {
          source: "hermes",
          key: "command-center:agent",
          kind: "agent",
          stats: { running: 1 },
          updatedAt: at,
        },
      ],
    });
    const snapshots = await runtime.runPromise(SnapshotsService);
    await runtime.runPromise(snapshots.refresh());

    const partialAt = "2026-07-23T10:01:00.000Z";
    mockFetchHermes.mockResolvedValueOnce({
      source: "hermes",
      fetchedAt: partialAt,
      ok: false,
      error: "unreachable hermes hosts: command-center",
      entities: [
        {
          source: "hermes",
          key: "studio:agent",
          kind: "agent",
          stats: { running: 1 },
          updatedAt: partialAt,
        },
      ],
    });
    const partial = await runtime.runPromise(snapshots.refresh());

    expect(findFreshEntity(partial, "hermes", "studio:agent")).toMatchObject({
      stale: false,
      stats: { running: 1 },
    });
    expect(findEntity(partial, "hermes", "command-center:agent")).toMatchObject({
      stale: true,
      stats: { running: 1 },
    });
    expect(findFreshEntity(partial, "hermes", "command-center:agent")).toBeUndefined();
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

describe("snapshots.ts provider access", () => {
  it("does no Hermes work until enabled and clears live data on revoke", async () => {
    let enabled = false;
    const accessListeners = new Set<(enabled: boolean) => void>();
    const gatedRuntime = ManagedRuntime.make(
      makeSnapshotsLive(() => mockFetchHermes(), true, {
        enabled: () => enabled,
        subscribe: (listener) => {
          accessListeners.add(listener);
          return () => accessListeners.delete(listener);
        },
      }),
    );

    try {
      const snapshots = await gatedRuntime.runPromise(SnapshotsService);
      snapshots.start();
      await gatedRuntime.runPromise(snapshots.refresh());
      expect(mockFetchHermes).not.toHaveBeenCalled();

      enabled = true;
      for (const listener of accessListeners) listener(enabled);
      await vi.waitFor(() => expect(mockFetchHermes).toHaveBeenCalledTimes(1));
      await vi.waitFor(async () =>
        expect(await gatedRuntime.runPromise(snapshots.current)).toMatchObject({
          bundles: [{ source: "hermes" }],
        }),
      );

      enabled = false;
      for (const listener of accessListeners) listener(enabled);
      expect(await gatedRuntime.runPromise(snapshots.current)).toEqual({ bundles: [] });
      await gatedRuntime.runPromise(snapshots.refresh());
      expect(mockFetchHermes).toHaveBeenCalledTimes(1);
    } finally {
      await gatedRuntime.dispose();
    }

    expect(accessListeners).toHaveLength(0);
  });
});
