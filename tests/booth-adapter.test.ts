import { Effect, Either, Layer, ManagedRuntime } from "effect";
import { BoothClient } from "@skastr0/booth-sdk";
import { describe, expect, it } from "vitest";

import { boothBundleEntities, buildBoothBundle } from "../src/main/vellum/adapters/booth";

// --- fixtures --------------------------------------------------------------
//
// Shaped like the SDK's decoded `BoothClient.listProjects()` /
// `listDrafts()` returns — every row arrives fully schema-decoded, so there is
// no "CLI stdout" / "malformed JSON" layer to fake; only the SDK call itself
// succeeds or fails.

const project = (key: string, name: string, updatedAt: number) => ({
  key,
  name,
  createdAt: updatedAt - 1000,
  updatedAt,
});

// A fake BoothClient exposing only the two methods these tests exercise.
const fakeBooth = (over: {
  listProjects?: () => Effect.Effect<ReadonlyArray<unknown>, unknown>;
  listDrafts?: (key: string) => Effect.Effect<ReadonlyArray<unknown>, unknown>;
}) =>
  Layer.succeed(BoothClient, {
    listProjects: over.listProjects ?? (() => Effect.succeed([])),
    listDrafts: over.listDrafts ?? (() => Effect.succeed([])),
  } as unknown as typeof BoothClient.Service);

const runEntities = (
  layer: Layer.Layer<BoothClient>,
  hints: ReadonlyArray<string>,
  fetchedAt = "2026-07-15T00:00:00.000Z",
) => {
  const runtime = ManagedRuntime.make(layer);
  return runtime
    .runPromise(Effect.either(boothBundleEntities(hints, fetchedAt)))
    .finally(() => runtime.dispose());
};

describe("boothBundleEntities", () => {
  it("builds project entities (title=name, updatedAt from ms)", async () => {
    const layer = fakeBooth({
      listProjects: () => Effect.succeed([project("vellum", "Vellum", 1784121579771)]),
    });
    const result = await runEntities(layer, []);
    expect(Either.isRight(result)).toBe(true);
    const entities = Either.isRight(result) ? result.right : [];
    expect(entities).toEqual([
      {
        source: "booth",
        key: "vellum",
        kind: "project",
        title: "Vellum",
        stats: {},
        updatedAt: new Date(1784121579771).toISOString(),
      },
    ]);
  });

  it("folds per-status draft counts into stats", async () => {
    const layer = fakeBooth({
      listProjects: () => Effect.succeed([project("vellum", "Vellum", 1784121579771)]),
      listDrafts: (key) =>
        Effect.succeed(
          key === "vellum"
            ? [{ status: "ready_for_review" }, { status: "ready_for_review" }, { status: "needs_revision" }, { status: "approved" }]
            : [],
        ),
    });
    const result = await runEntities(layer, ["vellum"]);
    const entities = Either.isRight(result) ? result.right : [];
    expect(entities[0]?.stats).toEqual({ drafts: 4, pending_review: 2, needs_revision: 1 });
  });

  it("degrades a failing per-hint drafts fetch to a no-op (keeps the entity)", async () => {
    const layer = fakeBooth({
      listProjects: () => Effect.succeed([project("vellum", "Vellum", 1784121579771)]),
      listDrafts: () => Effect.fail(new Error("drafts 502")),
    });
    const result = await runEntities(layer, ["vellum"]);
    const entities = Either.isRight(result) ? result.right : [];
    expect(entities).toHaveLength(1);
    expect(entities[0]?.stats).toEqual({});
  });

  it("surfaces a listProjects failure as a Left (folds to ok:false upstream)", async () => {
    const layer = fakeBooth({
      listProjects: () => Effect.fail(new Error("projects gateway down")),
    });
    const result = await runEntities(layer, []);
    expect(Either.isLeft(result)).toBe(true);
  });
});

describe("buildBoothBundle", () => {
  const fetchedAt = "2026-07-15T00:00:00.000Z";

  it("wraps a Right into ok:true with the entities", () => {
    expect(buildBoothBundle(fetchedAt, Either.right([]))).toEqual({
      source: "booth",
      fetchedAt,
      ok: true,
      entities: [],
    });
  });

  it("wraps a Left into ok:false naming the error message", () => {
    const bundle = buildBoothBundle(fetchedAt, Either.left(new Error("gateway down")));
    expect(bundle).toEqual({ source: "booth", fetchedAt, ok: false, error: "gateway down", entities: [] });
  });

  it("falls back to a generic message for a non-Error left", () => {
    const bundle = buildBoothBundle(fetchedAt, Either.left("boom"));
    expect(bundle.ok).toBe(false);
    expect(bundle.error).toBe("SDK request failed");
  });
});
