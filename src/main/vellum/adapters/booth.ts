import { Context, Effect, Either } from "effect";
import { BoothClient } from "@skastr0/booth-sdk";
import type { Entity, SnapshotBundle } from "@shared/entities";
import { SdkRuntime } from "./sdk-runtime";
import { describeSdkError } from "./sdk-errors";

// Read-only booth adapter, talking to the Booth Control HTTP server through
// @skastr0/booth-sdk's BoothClient — no `booth` CLI shell-out. Effect Schema
// decode at the SDK boundary already validated every project/draft shape, so
// this file only projects typed rows onto the SnapshotBundle contract the
// renderer consumes. A down/slow server folds to ok:false via the SDK's typed
// BoothError (never a hang: the SDK bounds every roundtrip with a timeout).
//
// Unlike tower/quasar, booth takes NO binding hints: a booth corpus is small
// by nature (a handful of projects), so every project is enriched with its
// per-status draft counts on every poll. That is what lets booth resolve
// IMPLICITLY in the renderer — a node bound to tower project X lights up the
// moment a booth project X exists, with no explicit booth binding required.

type BoothClientService = Context.Tag.Service<typeof BoothClient>;

// Safety ceiling, not a tuning knob: if a booth corpus ever outgrows this,
// the overflow projects still appear as entities — just without draft stats.
const MAX_ENRICHED_PROJECTS = 24;

// Per-status draft stats for one project: `drafts` (total), plus
// `pending_review` / `needs_revision` — the two attention states the canvas
// decorates on and the kernel can watch (stat_threshold source "booth").
// Pure + exported for tests.
export const draftStats = (
  rows: ReadonlyArray<{ readonly status: string }>,
): Record<string, number> => {
  let pendingReview = 0;
  let needsRevision = 0;
  for (const row of rows) {
    if (row.status === "ready_for_review") pendingReview += 1;
    else if (row.status === "needs_revision") needsRevision += 1;
  }
  return { drafts: rows.length, pending_review: pendingReview, needs_revision: needsRevision };
};

// Per-project enrichment: folds per-status draft counts into the entity map.
// Any failure degrades to a no-op — the entity keeps whatever it already had.
const enrichDrafts = (
  booth: BoothClientService,
  key: string,
  entities: Map<string, Entity>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const result = yield* Effect.either(booth.listDrafts(key));
    if (Either.isLeft(result)) return;

    const existing = entities.get(key);
    if (!existing) return;
    entities.set(key, { ...existing, stats: { ...existing.stats, ...draftStats(result.right) } });
  });

// The testable unit: requires only BoothClient, never touches SdkRuntime — a
// test provides a fake BoothClient layer and runs this directly.
export const boothBundleEntities = (): Effect.Effect<ReadonlyArray<Entity>, unknown, BoothClient> =>
  Effect.gen(function* () {
    const booth = yield* BoothClient;
    const rows = yield* booth.listProjects();

    const entities = new Map<string, Entity>();
    for (const row of rows) {
      entities.set(row.key, {
        source: "booth",
        key: row.key,
        kind: "project",
        title: row.name,
        // tower_project carries booth's own tower linkage so the renderer can
        // join booth↔tower even when the two keys differ.
        stats: row.towerProjectKey === undefined ? {} : { tower_project: row.towerProjectKey },
        updatedAt: new Date(row.updatedAt).toISOString(),
      });
    }

    yield* Effect.all(
      rows.slice(0, MAX_ENRICHED_PROJECTS).map((row) => enrichDrafts(booth, row.key, entities)),
      { concurrency: 4 },
    );

    return Array.from(entities.values());
  });

// Pure envelope wrapper — split out so ok/error framing is unit-testable
// without a runtime.
export const buildBoothBundle = (
  fetchedAt: string,
  result: Either.Either<ReadonlyArray<Entity>, unknown>,
): SnapshotBundle =>
  Either.isLeft(result)
    ? { source: "booth", fetchedAt, ok: false, error: describeSdkError(result.left), entities: [] }
    : { source: "booth", fetchedAt, ok: true, entities: result.right };

// A failed request degrades to an explicit ok:false naming the SDK error
// (never ok:true with silently-empty entities).
export const fetchBoothBundle = async (): Promise<SnapshotBundle> => {
  const fetchedAt = new Date().toISOString();
  const result = await SdkRuntime.runPromise(Effect.either(boothBundleEntities()));
  return buildBoothBundle(fetchedAt, result);
};
