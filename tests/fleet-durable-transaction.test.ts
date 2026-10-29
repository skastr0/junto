/**
 * A consensus transaction commits under synchronous=FULL (0.11, 06 F2,
 * "Durability"), and the setting is the connection's: set, run and reset are
 * three statements. Two canvases draining at once must not let one's reset to
 * NORMAL land inside the other's transaction (tech-lead, F2 review 2).
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, expect, it } from "vitest";
import { durableTransaction } from "../src/main/junto/fleet/driver";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

it("holds synchronous=FULL through every consensus transaction, however many canvases drain at once", async () => {
  root = await mkdtemp(join(tmpdir(), "junto-fleet-durable-"));
  const database = new DatabaseSync(join(root, "junto.db"));
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; CREATE TABLE acks (canvas TEXT NOT NULL) STRICT");
  const runtime = ManagedRuntime.make(Layer.effect(SqlClient.SqlClient, makeSqliteClient(database)).pipe(Layer.provide(Reactivity.layer)));
  try {
    const seen = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const inside = yield* Deferred.make<void>();
        const drain = (canvas: string, entered?: Deferred.Deferred<void>) =>
          durableTransaction(
            sql,
            Effect.gen(function* () {
              if (entered !== undefined) yield* Deferred.succeed(entered, undefined);
              // The second canvas starts while this one holds the connection, as a drain does between its statements.
              for (let turn = 0; turn < 8; turn++) yield* Effect.yieldNow;
              yield* sql`INSERT INTO acks (canvas) VALUES (${canvas})`;
              const [row] = yield* sql<{ synchronous: number }>`PRAGMA synchronous`;
              return row!.synchronous;
            }),
          );
        return yield* Effect.all([drain("factory", inside), Effect.andThen(Deferred.await(inside), drain("home"))], { concurrency: "unbounded" });
      }),
    );
    // 2 is FULL.
    expect(seen).toEqual([2, 2]);
    expect((database.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous).toBe(1);
  } finally {
    await runtime.dispose();
    database.close();
  }
});
