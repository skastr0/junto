import { Effect, Either, Layer, ManagedRuntime } from "effect";
import { TowerClient } from "@skastr0/tower-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { buildTowerBundle, towerDashboardEntities } from "../src/main/vellum/adapters/tower";

// --- fixtures --------------------------------------------------------------
//
// Shaped like the live `TowerClient.listDashboardSummaries()` response
// (captured live 2026-07-13 against the deployed authority) — every project
// arrives fully schema-decoded now, so there is no separate "CLI stdout" /
// "malformed JSON" layer to fake any more; only the SDK call itself
// succeeds or fails.

const orbitStates = (building: number, done: number, abandoned: number, backlog = 0) => [
  { state: "backlog" as const, count: backlog },
  { state: "exploring" as const, count: 0 },
  { state: "committed" as const, count: 0 },
  { state: "building" as const, count: building },
  { state: "reviewing" as const, count: 0 },
  { state: "done" as const, count: done },
  { state: "abandoned" as const, count: abandoned },
];

const emptyOrbit = (orbit: "forge" | "survey" | "beacon" | "scribe" | "oracle") => ({ orbit, states: orbitStates(0, 0, 0) });

const vellumSummary = {
  project: {
    key: "vellum",
    name: "vellum",
    createdAt: 1783832734544,
    updatedAt: 1783974760898,
  },
  orbits: [
    { orbit: "forge" as const, states: orbitStates(1, 10, 1) },
    emptyOrbit("survey"),
    emptyOrbit("beacon"),
    emptyOrbit("scribe"),
    emptyOrbit("oracle"),
  ],
  signals: { total: 0, inbox: 0, claimed: 0 },
  chatter: { total: 0 },
  metrics: { glyphs: 12, activeGlyphs: 1, doneGlyphs: 10 },
};

const busySummary = {
  project: { key: "vouch", name: "vouch", createdAt: 1780000000000, updatedAt: 1783900000000 },
  orbits: [
    { orbit: "forge" as const, states: orbitStates(2, 31, 0, 10) },
    { orbit: "beacon" as const, states: orbitStates(0, 4, 0) },
    emptyOrbit("survey"),
    emptyOrbit("scribe"),
    emptyOrbit("oracle"),
  ],
  signals: { total: 30, inbox: 5, claimed: 2 },
  chatter: { total: 12 },
  metrics: { glyphs: 47, activeGlyphs: 12, doneGlyphs: 35 },
};

// A fake TowerClient exposing only the one method these tests exercise —
// the rest of the (large) service surface is never called.
const fakeTowerClient = (
  listDashboardSummaries: () => Effect.Effect<ReadonlyArray<unknown>, unknown>,
) => Layer.succeed(TowerClient, { listDashboardSummaries } as unknown as typeof TowerClient.Service);

const runEntities = (summaries: ReadonlyArray<unknown>) => {
  const runtime = ManagedRuntime.make(fakeTowerClient(() => Effect.succeed(summaries)));
  return runtime.runPromise(Effect.either(towerDashboardEntities)).finally(() => runtime.dispose());
};

describe("towerDashboardEntities (bulk dashboards)", () => {
  it("builds fully-enriched entities from one bulk call", async () => {
    const result = await runEntities([vellumSummary, busySummary]);
    expect(Either.isRight(result)).toBe(true);
    const entities = Either.isRight(result) ? result.right : [];
    expect(entities).toHaveLength(2);

    const vellum = entities.find((entity) => entity.key === "vellum");
    expect(vellum).toMatchObject({
      source: "tower",
      kind: "project",
      title: "vellum",
      stats: { glyphs_active: 1, glyphs_done: 10, orbits: 1, orbit_forge: 1 },
      updatedAt: new Date(1783974760898).toISOString(),
    });
    // zero totals must not surface as stats keys
    expect(vellum?.stats).not.toHaveProperty("signals");
    expect(vellum?.stats).not.toHaveProperty("chatter");
  });

  it("surfaces signal/chatter totals and multi-orbit rollups when non-zero", async () => {
    const result = await runEntities([busySummary]);
    const entities = Either.isRight(result) ? result.right : [];
    const vouch = entities[0];

    expect(vouch?.stats).toMatchObject({
      glyphs_active: 12, // forge backlog 10 + building 2
      glyphs_done: 35, // forge 31 + beacon 4
      orbits: 2,
      orbit_forge: 12,
      signals: 30,
      chatter: 12,
    });
    expect(vouch?.stats).not.toHaveProperty("orbit_beacon"); // active 0 → omitted
  });

  it("skips a row that throws during entity construction without taking down the fleet", async () => {
    // A defect a live schema decode would never actually let through
    // (orbits missing) — Effect.either around the per-row Effect.try is the
    // isolation belt this proves, not a "malformed JSON" scenario (that
    // whole class of failure is now dissolved by the SDK's schema decode).
    const poisoned = { ...vellumSummary, orbits: undefined };
    const result = await runEntities([poisoned, busySummary]);
    const entities = Either.isRight(result) ? result.right : [];
    expect(entities).toHaveLength(1);
    expect(entities[0]?.key).toBe("vouch");
  });
});

describe("buildTowerBundle", () => {
  const fetchedAt = "2026-07-13T00:00:00.000Z";

  it("wraps a Right into ok:true with the entities", () => {
    const bundle = buildTowerBundle(fetchedAt, Either.right([]));
    expect(bundle).toEqual({ source: "tower", fetchedAt, ok: true, entities: [] });
  });

  it("wraps a Left into ok:false naming the error message", () => {
    const bundle = buildTowerBundle(fetchedAt, Either.left(new Error("gateway down")));
    expect(bundle).toEqual({ source: "tower", fetchedAt, ok: false, error: "gateway down", entities: [] });
  });

  it("falls back to a generic message for a non-Error left", () => {
    const bundle = buildTowerBundle(fetchedAt, Either.left("boom"));
    expect(bundle.ok).toBe(false);
    expect(bundle.error).toBe("SDK request failed");
  });
});
