import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { unjournaledWorkMutationEffect } from "../src/main/junto/work/mutation-seam";
import { WorkContentProjections, WorkContentProjectionsLive } from "../src/main/junto/work/repository";

const root = join(tmpdir(), `junto-work-content-${randomUUID()}`);
const runtime = ManagedRuntime.make(WorkContentProjectionsLive.pipe(
  Layer.provideMerge(makeStateEngineLive(join(root, "junto.db"))),
));
afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

it("rewrites only the selected projection PK and rolls back with its caller", async () => {
  await runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* WorkContentProjections;
    const oldParts = JSON.stringify([{ kind: "raw", bytesBase64: "YWJj", mediaType: "image/png" }]);
    // Projection rows only: the facts and installations they cite are not under
    // test. The pragma is a no-op inside a transaction, so it wraps the seed's.
    yield* sql.unsafe("PRAGMA foreign_keys = OFF");
    yield* sql.withTransaction(unjournaledWorkMutationEffect("test.fixture-seed", Effect.gen(function* () {
      for (const [canvas, node, seq] of [["canvas", "a", "1"], ["canvas", "b", "2"], ["other", "a", "3"]]) {
        yield* sql`INSERT INTO work_artifacts(canvas_name, node_id, artifact_id, entity_home, actor_seat_id,
          fact_event_home, fact_entity_home, fact_seq, parts_json, origin_at, received_at)
          VALUES (${canvas}, ${node}, 'artifact', 'home', ${`seat_${"a".repeat(64)}`}, 'home', 'home', ${seq},
            ${oldParts}, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      }
    }))).pipe(Effect.ensuring(sql.unsafe("PRAGMA foreign_keys = ON").pipe(Effect.asVoid, Effect.orDie)));
    expect(yield* sql.unsafe("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
    const before = yield* projections.scan("artifact");
    const selected = before.find((row) => row.canvasName === "canvas" && row.nodeId === "a")!;
    const failed = yield* Effect.result(sql.withTransaction(Effect.gen(function* () {
      yield* projections.rewrite(selected, "[]");
      return yield* Effect.fail("rollback");
    })));
    expect(Result.isFailure(failed) && failed.failure).toBe("rollback");
    expect(yield* projections.scan("artifact")).toEqual(before);
    yield* sql.withTransaction(projections.rewrite(selected, "[]"));
    const changed = yield* projections.scan("artifact");
    expect(changed).toEqual(before.map((row) => row === selected ? { ...row, partsJson: "[]" } : row));
    // A stale scan result still updates by PK: backfill semantics are unconditional.
    const newest = '[{"kind":"text","text":"replacement"}]';
    yield* sql.withTransaction(projections.rewrite(selected, newest));
    expect((yield* projections.scan("artifact")).find((row) => row.canvasName === "canvas" && row.nodeId === "a")?.partsJson).toBe(newest);
    for (const kind of ["message", "task-message"] as const) {
      expect(yield* projections.scan(kind)).toEqual([]);
    }
  }));
});
