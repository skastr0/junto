import { Effect, Either } from "effect";
import { TowerClient, type ControlDashboardSummaryList } from "@skastr0/tower-sdk";
import type { Entity, SnapshotBundle } from "@shared/entities";
import { SdkRuntime } from "./sdk-runtime";
import { describeSdkError } from "./sdk-errors";
import { resolved } from "./tower-client";

// Shape of `TowerClient.listDashboardSummaries()`: ONE bulk authority
// roundtrip returning every project pre-enriched (~0.75s for the whole
// fleet). `orbits` is always the full fixed set (forge/survey/beacon/scribe/
// oracle) with per-state counts — "present" is derived as "has any glyph in
// any state". `signals`/`chatter` are server-computed rollup counters, both
// non-optional under the SDK's DashboardSummary schema (Effect Schema decode
// at the boundary already rejected anything malformed before this code
// runs — no hand-rolled guards or Raw* interfaces needed any more).
type DashboardSummary = ControlDashboardSummaryList[number];

const toEntity = (summary: DashboardSummary): Entity => {
  let active = 0;
  let done = 0;
  let orbitCount = 0;
  const perOrbit: Record<string, number> = {};
  for (const orbit of summary.orbits) {
    let orbitActive = 0;
    let orbitTotal = 0;
    for (const { state, count } of orbit.states) {
      orbitTotal += count;
      if (state === "done") {
        done += count;
      } else if (state !== "abandoned") {
        orbitActive += count;
      }
    }
    active += orbitActive;
    if (orbitTotal > 0) orbitCount += 1;
    if (orbitActive > 0) perOrbit[`orbit_${orbit.orbit}`] = orbitActive;
  }

  const stats: Record<string, string | number> = {
    glyphs_active: active,
    glyphs_done: done,
    orbits: orbitCount,
    ...perOrbit,
  };
  if (summary.signals.total > 0) {
    stats.signals = summary.signals.total;
  }
  if (summary.chatter.total > 0) {
    stats.chatter = summary.chatter.total;
  }

  return {
    source: "tower",
    key: summary.project.key,
    kind: "project",
    title: summary.project.name,
    stats,
    updatedAt: new Date(summary.project.updatedAt).toISOString(),
  };
};

// The testable unit: requires only TowerClient, never touches SdkRuntime —
// a test provides a fake TowerClient layer and runs this directly. A single
// row that fails entity construction is skipped via Effect.either so one
// poisoned project can never take down the rest of the fleet (kernel
// concurrency-safety constraint: one bad row, isolated).
export const towerDashboardEntities: Effect.Effect<ReadonlyArray<Entity>, unknown, TowerClient> = Effect.gen(
  function* () {
    const tower = yield* TowerClient;
    const summaries = yield* resolved(tower.listDashboardSummaries());
    const entities: Entity[] = [];
    for (const summary of summaries) {
      const built = yield* Effect.either(Effect.try(() => toEntity(summary)));
      if (Either.isRight(built)) entities.push(built.right);
    }
    return entities;
  },
);

// Pure envelope wrapper — split out so ok/error framing is unit-testable
// without a runtime.
export const buildTowerBundle = (
  fetchedAt: string,
  result: Either.Either<ReadonlyArray<Entity>, unknown>,
): SnapshotBundle =>
  Either.isLeft(result)
    ? { source: "tower", fetchedAt, ok: false, error: describeSdkError(result.left), entities: [] }
    : { source: "tower", fetchedAt, ok: true, entities: result.right };

// Single bulk call over the SDK: every project arrives fully schema-decoded,
// so there is no hint mechanism any more. A failed request degrades to an
// explicit ok:false naming the SDK error (never ok:true with silently-empty
// entities).
export const fetchTowerBundle = async (): Promise<SnapshotBundle> => {
  const fetchedAt = new Date().toISOString();
  const result = await SdkRuntime.runPromise(Effect.either(towerDashboardEntities));
  return buildTowerBundle(fetchedAt, result);
};
