import { Effect, Layer, ManagedRuntime } from "effect";
import { TowerClient } from "@skastr0/tower-sdk";
import { describe, expect, it } from "vitest";
import { towerBrowseRows } from "../src/main/vellum/adapters/tower-browse";

// b4-negcache: the original hand-rolled fetch adapter distinguished "every
// one of the 10 fanned-out requests failed" (gateway outage) from "every
// request succeeded with an empty payload" (legitimate empty project) —
// losing that distinction would silently misreport an outage as "this
// project has zero glyphs/signals". @skastr0/tower-sdk swap keeps the same
// fan-out shape (5 orbits x listGlyphs+listSignals), so the same invariant
// is re-proven here against a fake TowerClient instead of a mocked fetch.
//
// The stale-token (401) auto-retry this file used to cover is DROPPED, not
// silently lost: it was a hand-rolled-fetch-era workaround (invalidate a
// cached ~/.tower-control/config.json read, re-read once, retry) that has
// no equivalent hook on the SDK's TowerConfig (resolved once at
// TowerSdkLive's layer-build time, not re-resolvable per-call). A rotated
// bearer token now surfaces as an ordinary ApiResponseError like any other
// request failure — correctly ok:false, just without the one-shot recovery
// attempt.

const ORBIT_COUNT = 5;

const fakeTowerClient = (outcome: {
  readonly listGlyphs: () => Effect.Effect<{ readonly items: ReadonlyArray<never> }, unknown>;
  readonly listSignals: () => Effect.Effect<{ readonly signals: ReadonlyArray<never> }, unknown>;
}) => Layer.succeed(TowerClient, outcome as unknown as typeof TowerClient.Service);

const runBrowse = (outcome: Parameters<typeof fakeTowerClient>[0]) => {
  const runtime = ManagedRuntime.make(fakeTowerClient(outcome));
  return runtime.runPromise(towerBrowseRows("vellum")).finally(() => runtime.dispose());
};

const allFail = Effect.fail(new Error("gateway down"));

describe("towerBrowseRows — total-outage negative-cache regression", () => {
  it("returns ok:false when every fanned-out request fails (total gateway outage)", async () => {
    let glyphCalls = 0;
    let signalCalls = 0;
    const result = await runBrowse({
      listGlyphs: () => {
        glyphCalls += 1;
        return allFail;
      },
      listSignals: () => {
        signalCalls += 1;
        return allFail;
      },
    });

    expect(result.ok).toBe(false);
    expect(result.glyphs).toEqual([]);
    expect(result.signals).toEqual([]);
    if (!result.ok) expect(result.error).toBeTruthy();
    expect(glyphCalls).toBe(ORBIT_COUNT);
    expect(signalCalls).toBe(ORBIT_COUNT);
  });

  it("stays ok:true when only some orbits fail (partial outage), and marks the result partial", async () => {
    const result = await runBrowse({
      listGlyphs: (input: { readonly orbit: string }) =>
        input.orbit === "forge"
          ? Effect.succeed({ items: [{ glyphId: "g1", orbit: "forge", title: "t", state: "building", updatedAt: 1 }] })
          : (allFail as Effect.Effect<never, unknown>),
      listSignals: () => allFail,
    } as never);

    expect(result.ok).toBe(true);
    expect(result.glyphs).toEqual([{ glyphId: "g1", orbit: "forge", title: "t", state: "building", updatedAt: 1 }]);
    expect(result.signals).toEqual([]);
    // Additive marker: a downstream consumer (the kernel's glyph-cache
    // fetcher) must be able to tell this apart from a genuinely complete
    // read — under-reported glyphs/signals must never be silently mistaken
    // for the whole picture.
    expect(result.partial).toBe(true);
  });

  // sdk-kernel-build fix 4: facets are tracked separately. Glyphs fail but
  // signals answer -> the orbit is NOT "succeeded"; the missing glyphs must
  // mark the whole read partial, never be treated as authoritative.
  it("marks partial when glyphs fail but signals succeed (per-facet, not per-orbit)", async () => {
    const result = await runBrowse({
      listGlyphs: () => allFail,
      listSignals: () => Effect.succeed({ signals: [] }),
    });
    expect(result.ok).toBe(true);
    expect(result.glyphs).toEqual([]);
    expect(result.partial).toBe(true);
  });

  it("distinguishes total failure from a legitimate empty project", async () => {
    const emptyButHealthy = await runBrowse({
      listGlyphs: () => Effect.succeed({ items: [] }),
      listSignals: () => Effect.succeed({ signals: [] }),
    });

    expect(emptyButHealthy).toEqual({ ok: true, glyphs: [], signals: [] });
  });

  it("never sets partial when every orbit succeeds", async () => {
    const result = await runBrowse({
      listGlyphs: () => Effect.succeed({ items: [] }),
      listSignals: () => Effect.succeed({ signals: [] }),
    });
    expect(result.partial).toBeUndefined();
  });

  it("never sets partial on total outage — ok:false already signals it's authoritative-nothing", async () => {
    const result = await runBrowse({
      listGlyphs: () => allFail,
      listSignals: () => allFail,
    });
    expect(result.ok).toBe(false);
    expect(result.partial).toBeUndefined();
  });
});
