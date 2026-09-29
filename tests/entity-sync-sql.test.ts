import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { CanvasEntitySync } from "../src/main/junto/entities/sync";
import { CanvasEntityRepository, CanvasEntityRepositoryLive } from "../src/main/junto/entities/repository";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import type { CanvasDoc } from "../src/shared/canvas";

test("SQL entity sync transfers bindings before upsert and participates in outer rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-entity-sql-"));
  const runtime = ManagedRuntime.make(Layer.mergeAll(CanvasEntitySync.layer, CanvasEntityRepositoryLive)
    .pipe(Layer.provideMerge(makeStateEngineLive(join(root, "junto.db")))));
  try {
    await runtime.runPromise(Effect.gen(function* () {
      const sync = yield* CanvasEntitySync;
      const repo = yield* CanvasEntityRepository;
      const sql = yield* SqlClient.SqlClient;
      const doc = (bindings: ReadonlyArray<readonly [string, string]>): CanvasDoc => ({
        nodes: bindings.map(([id, bindingId]) => ({ id, type: "text", x: 0, y: 0, width: 100, height: 100,
          text: id, ether: { entity: { kind: "agent", name: id }, terminal: { bindingId } },
        })), edges: [],
      });
      const initial = "2026-01-02T03:04:05.000Z";
      const changed = "2026-01-03T03:04:05.000Z";
      yield* sql.withTransaction(sync.syncCanvasEntities("alpha", doc([["a", "one"], ["b", "two"]]), initial));
      yield* sql.withTransaction(sync.syncCanvasEntities("alpha", doc([["a", "two"], ["b", "one"]]), changed));
      expect((yield* repo.listByCanvas("alpha")).map((row) => [row.key.entityId, row.bindingId, row.updatedAt]))
        .toEqual([["a", "two", changed], ["b", "one", changed]]);
      yield* sql.withTransaction(sync.syncCanvasEntities("alpha", doc([["a", "two"], ["b", "one"]]), "2026-01-04T00:00:00.000Z"));
      expect((yield* repo.get("alpha", "a"))?.updatedAt).toBe(changed);
      expect(yield* sql.withTransaction(Effect.gen(function* () {
        yield* sync.archiveAllCanvasEntities("alpha", changed);
        yield* repo.softDelete("alpha", "a");
        expect((yield* repo.get("alpha", "a"))?.lifecycle).toBe("soft_deleted");
        return yield* Effect.fail("abort");
      })).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: "abort" });
      expect((yield* repo.listByCanvas("alpha")).map((row) => row.lifecycle)).toEqual(["active", "active"]);
      expect(yield* repo.softDelete("alpha", "a").pipe(Effect.result))
        .toMatchObject({ _tag: "Failure", failure: { _tag: "CanvasEntityNotArchivedError", lifecycle: "active" } });
      expect(yield* repo.softDelete("alpha", "missing").pipe(Effect.result))
        .toMatchObject({ _tag: "Failure", failure: { _tag: "CanvasEntityMissingError" } });
      yield* sql.withTransaction(sync.syncCanvasEntities("alpha", doc([["replacement", "one"], ["a", "two"]]), changed));
      expect((yield* repo.get("alpha", "b"))?.lifecycle).toBe("archived");
      expect((yield* repo.get("alpha", "replacement"))?.bindingId).toBe("one");
    }));
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
