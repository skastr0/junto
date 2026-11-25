/**
 * Step 79 admits the end reason a deleted seat's session takes: seat_sessions
 * is rebuilt with `removed` in its CHECK, every row copied as it was. Replay
 * the shipped fixtures to 78, plant a session, run the step, and the row is
 * byte-identical while a close with `removed` now passes the CHECK.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V79_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationDatabase,
  type StateSchemaMigrationPlan,
} from "../src/core/state/migrations";
import { migrateMachineNames } from "../src/core/state/migrate-machine-names";
import { expectedStateSchemaIdentity } from "../src/core/state/schema-identity";
import { STATE_SCHEMA_SQL } from "../src/core/state/schema";
import { STATE_SCHEMA_V78_SQL } from "./fixtures/state-v13/schema";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { makeStateEngineLive } from "../src/core/state/engine";
import { SeatSessionRepository, SeatSessionRepositoryLive } from "../src/core/seat-sessions/repository";

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/state-v13/${name}`, import.meta.url));

const openCopy = async (source: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-seat-sessions-removed-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(source, path);
  const database = new DatabaseSync(path, { open: true, readOnly: false, allowExtension: false, enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
};

const upTo = (version: number, currentSchemaSql: string): StateSchemaMigrationPlan => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version).map((step) =>
    step.toVersion === 21
      ? { ...step, migrate: (database: StateSchemaMigrationDatabase) => migrateMachineNames(database, "macbook") }
      : step,
  ),
});

describe("state migration 78 -> 79 (the removed end reason)", () => {
  it("ends at the version-79 witness as a fresh install has it", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(STATE_SCHEMA_V79_IDENTITY);
  });

  it("keeps every session row byte-identical, and a close with removed passes the CHECK after it", async () => {
    const database = await openCopy(fixture("command-center-v13.db"));
    try {
      migrateStateSchema(database, upTo(78, STATE_SCHEMA_V78_SQL));
      database.exec("PRAGMA foreign_keys = OFF");
      database
        .prepare(
          `INSERT INTO seat_sessions(seat_id, session_id, harness, started_at) VALUES ('seat-a', 'session-a', 'claude', 1)`,
        )
        .run();
      // Before the step the close this migration exists for is refused.
      expect(() =>
        database.prepare("UPDATE seat_sessions SET ended_at = 2, end_reason = 'removed' WHERE seat_id = 'seat-a'").run(),
      ).toThrow(/CHECK/);

      migrateStateSchema(database, upTo(79, STATE_SCHEMA_SQL));
      const rows = database.prepare("SELECT * FROM seat_sessions WHERE seat_id = 'seat-a'").all() as ReadonlyArray<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ seat_id: "seat-a", session_id: "session-a", harness: "claude", end_reason: null });

      // After it the delete finish's close passes, and the one-open index is back.
      database.prepare("UPDATE seat_sessions SET ended_at = 2, end_reason = 'removed' WHERE seat_id = 'seat-a'").run();
      expect(
        (database.prepare("SELECT end_reason FROM seat_sessions WHERE seat_id = 'seat-a'").get() as { end_reason: string }).end_reason,
      ).toBe("removed");
      expect(
        database.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'seat_sessions_one_open'").all(),
      ).toHaveLength(1);
      expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(STATE_SCHEMA_V79_IDENTITY);
    } finally {
      database.close();
    }
  });

  it("the delete finish's end with removed succeeds against the real SQL repository", async () => {
    // The defect remote-verify caught on a real far machine: every fake let
    // "removed" through and the real CHECK refused it, so the finish died
    // before the release. This runs the repository's own end path over a
    // migrated database, no fake anywhere in it.
    const root = await mkdtemp(join(tmpdir(), "junto-seat-sessions-end-"));
    dir = root;
    const layer = Layer.provideMerge(SeatSessionRepositoryLive, makeStateEngineLive(join(root, "junto.db")));
    await Effect.gen(function* () {
      const sessions = yield* SeatSessionRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(
        "INSERT INTO seat_sessions(seat_id, session_id, harness, started_at, binding_id) VALUES ('seat-a', 'session-a', 'claude', 1, 'binding-a')",
      );
      yield* sessions.end("seat-a", "removed", undefined, "binding-a");
      const rows = yield* sql.unsafe<{ end_reason: string }>("SELECT end_reason FROM seat_sessions WHERE seat_id = 'seat-a'");
      expect(rows[0]?.end_reason).toBe("removed");
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
  });

  it("a seat_session_drains child survives the rebuild with foreign keys on, and foreign_key_check is empty", async () => {
    // The rebuild drops and recreates seat_sessions. seat_session_drains
    // cascades from it, so if the runner's foreign_keys OFF ever failed the
    // drop would silently take every drain with it — and this connection
    // keeps its keys ON, so nothing but the runner's own handling protects
    // the rows.
    const database = await openCopy(fixture("command-center-v13.db"));
    try {
      migrateStateSchema(database, upTo(78, STATE_SCHEMA_V78_SQL));
      database
        .prepare("INSERT INTO seat_sessions(seat_id, session_id, harness, started_at, binding_id) VALUES ('seat-a', 'session-a', 'claude', 1, 'binding-a')")
        .run();
      database
        .prepare("INSERT INTO seat_session_drains(seat_id, session_id, detached_at) VALUES ('seat-a', 'session-a', 5)")
        .run();

      migrateStateSchema(database, upTo(79, STATE_SCHEMA_SQL));

      const drains = database.prepare("SELECT * FROM seat_session_drains").all() as ReadonlyArray<Record<string, unknown>>;
      expect(drains).toEqual([{ seat_id: "seat-a", session_id: "session-a", detached_at: 5, ended_at: null, ended_how: null }]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});


