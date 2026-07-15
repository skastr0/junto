import { Context, Effect, Either } from "effect";
import { BoothClient } from "@skastr0/booth-sdk";
import type { Entity, SnapshotBundle } from "@shared/entities";
import { SdkRuntime } from "./sdk-runtime";
import { describeSdkError } from "./sdk-errors";

// Read-only booth adapter, talking to the Booth Control HTTP server through
// @skastr0/booth-sdk's BoothClient — no `booth` CLI shell-out. Effect Schema
// decode at the SDK boundary already validated every project/draft shape, so
// this file only projects typed rows onto the SnapshotBundle contract the
// renderer consumes (kept byte-identical). A down/slow server folds to
// ok:false via the SDK's typed BoothError (never a hang: the SDK bounds every
// roundtrip with a timeout).

type BoothClientService = Context.Tag.Service<typeof BoothClient>;

const MAX_HINTS = 8;

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

// Per-key enrichment: fetches the draft list for one hinted project key and
// folds per-status counts into the entity map. Any failure (SDK error, empty
// result) degrades to a no-op — the entity keeps whatever stats it already had.
const enrichDrafts = (
  booth: BoothClientService,
  key: string,
  entities: Map<string, Entity>,
  fetchedAt: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const result = yield* Effect.either(booth.listDrafts(key));
    if (Either.isLeft(result)) return;

    const existing = entities.get(key);
    entities.set(key, {
      source: "booth",
      key,
      kind: "project",
      title: existing?.title ?? key,
      stats: { ...existing?.stats, ...draftStats(result.right) },
      updatedAt: existing?.updatedAt ?? fetchedAt,
    });
  });

// The testable unit: requires only BoothClient, never touches SdkRuntime — a
// test provides a fake BoothClient layer and runs this directly.
export const boothBundleEntities = (
  hints: ReadonlyArray<string>,
  fetchedAt: string,
): Effect.Effect<ReadonlyArray<Entity>, unknown, BoothClient> =>
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
        stats: {},
        updatedAt: new Date(row.updatedAt).toISOString(),
      });
    }

    const hintedKeys = Array.from(new Set(hints)).slice(0, MAX_HINTS);
    yield* Effect.all(
      hintedKeys.map((key) => enrichDrafts(booth, key, entities, fetchedAt)),
      { concurrency: "unbounded" },
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
export const fetchBoothBundle = async (hints: ReadonlyArray<string>): Promise<SnapshotBundle> => {
  const fetchedAt = new Date().toISOString();
  const result = await SdkRuntime.runPromise(Effect.either(boothBundleEntities(hints, fetchedAt)));
  return buildBoothBundle(fetchedAt, result);
};
