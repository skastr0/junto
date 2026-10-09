import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { InstallationId } from "../src/shared/installation-id";
import { DisplayTimestamp } from "../src/shared/work-protocol";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { WorkJournal, WorkJournalLive } from "../src/main/junto/work/journal";
import { unjournaledWorkMutationEffect } from "../src/main/junto/work/mutation-seam";

const receivedAt = Schema.decodeUnknownSync(DisplayTimestamp)(
  "2026-08-27T12:00:00.000Z",
);

test("SQL journal sequences retain zero, bigint precision and rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-journal-sql-"));
  const runtime = ManagedRuntime.make(
    WorkJournalLive.pipe(
      Layer.provideMerge(makeStateEngineLive(join(root, "junto.db"))),
    ),
  );
  const home = Schema.decodeUnknownSync(InstallationId)(
    "journal-sequence-home",
  );
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const journal = yield* WorkJournal;
        yield* sql.withTransaction(
          unjournaledWorkMutationEffect(
            "test.fixture-seed",
            Effect.gen(function* () {
              yield* sql`INSERT INTO station_known_installations(installation_id, registered_at) VALUES (${home}, ${receivedAt})`;
              yield* sql`INSERT INTO work_event_sequences VALUES (${home}, ${home}, '0')`;
              expect(yield* journal.allocateSequence(home, home)).toBe("1");
              yield* sql`UPDATE work_event_sequences SET last_seq = '9007199254740993'
                WHERE event_home = ${home} AND entity_home = ${home}`;
              expect(yield* journal.allocateSequence(home, home)).toBe(
                "9007199254740994",
              );
              yield* Effect.result(
                sql.withTransaction(
                  Effect.gen(function* () {
                    expect(yield* journal.allocateSequence(home, home)).toBe(
                      "9007199254740995",
                    );
                    return yield* Effect.fail("rollback");
                  }),
                ),
              );
              expect(yield* journal.allocateSequence(home, home)).toBe(
                "9007199254740995",
              );
            }),
          ),
        );
      }),
    );
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
