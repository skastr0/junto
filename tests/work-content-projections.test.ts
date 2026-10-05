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
    yield* sql.withTransaction(unjournaledWorkMutationEffect("test.fixture-seed", Effect.gen(function* () {
      for (const [canvas, node, topic] of [["canvas", "a", "topic"], ["canvas", "b", "topic"], ["other", "a", "topic"]]) {
        yield* sql`INSERT INTO work_board_topics(canvas_name, node_id, topic_id, title, state, author_kind,
          parts_json, post_count, last_activity_at, created_at, updated_at)
          VALUES (${canvas}, ${node}, ${topic}, 'old', 'open', 'operator', ${oldParts}, 0,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      }
    })));
    const before = yield* projections.scan("board-topic");
    const selected = before.find((row) => row.canvasName === "canvas" && row.nodeId === "a")!;
    const failed = yield* Effect.result(sql.withTransaction(Effect.gen(function* () {
      yield* projections.rewrite(selected, "[]");
      return yield* Effect.fail("rollback");
    })));
    expect(Result.isFailure(failed) && failed.failure).toBe("rollback");
    expect(yield* projections.scan("board-topic")).toEqual(before);
    yield* sql.withTransaction(projections.rewrite(selected, "[]"));
    const changed = yield* projections.scan("board-topic");
    expect(changed).toEqual(before.map((row) => row === selected ? { ...row, partsJson: "[]" } : row));
    // A stale scan result still updates by PK: backfill semantics are unconditional.
    const newest = '[{"kind":"text","text":"replacement"}]';
    yield* sql.withTransaction(projections.rewrite(selected, newest));
    expect((yield* projections.scan("board-topic")).find((row) => row.canvasName === "canvas" && row.nodeId === "a")?.partsJson).toBe(newest);
    for (const kind of ["message", "task-message", "artifact", "board-post"] as const) {
      expect(yield* projections.scan(kind)).toEqual([]);
    }
  }));
});
