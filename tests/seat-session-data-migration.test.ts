/**
 * State migration 21 -> 22 keeps seat session data in the database. Proven on
 * both shipped fixtures brought to version 21 by the real steps: every session
 * survives with its history, `notes_path` is gone, the new columns start
 * empty, and the continuation ledger and offboard clock tables exist, empty.
 * Nothing is read from files: the step never looks under `~/.junto/seats`.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateMachineNames } from "../src/main/junto/state/migrate-machine-names";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V21_IDENTITY,
  STATE_SCHEMA_V22_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V21_SQL, STATE_SCHEMA_V22_SQL } from "./fixtures/state-v1/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-seat-session-data-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fileURLToPath(new URL(`./fixtures/state-v1/${fixture}`, import.meta.url)), path);
  const database = new DatabaseSync(path, { open: true, readOnly: false, allowExtension: false, enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
};

const snapshot = (database: DatabaseSync) =>
  Object.fromEntries(
    (
      database
        .prepare(
          `SELECT name FROM sqlite_schema
            WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'state_schema_identity'
            ORDER BY name`,
        )
        .all() as unknown as ReadonlyArray<{ readonly name: SQLOutputValue }>
    ).map(({ name }) => [String(name), database.prepare(`SELECT * FROM "${String(name)}" ORDER BY 1, 2`).all()]),
  );

/** The real steps, with the name first boot would give fixed so the proof does not depend on where it runs. */
const named = <T extends { readonly toVersion: number; readonly migrate: (database: DatabaseSync) => void }>(step: T): T =>
  step.toVersion === 21 ? { ...step, migrate: (database: DatabaseSync) => migrateMachineNames(database, "macbook") } : step;

const versionTwentyOnePlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 21,
  currentSchemaSql: STATE_SCHEMA_V21_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 21).map(named),
};

const versionTwentyTwoPlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 22,
  currentSchemaSql: STATE_SCHEMA_V22_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 22).map(named),
};

/** Sessions as version 21 keeps them: one ended with notes, one open, one drained. */
const seed = (database: DatabaseSync): void => {
  const insert = database.prepare(
    `INSERT INTO seat_sessions(seat_id, session_id, harness, cwd, transcript_path, notes_path, gist, started_at,
       ended_at, end_reason, offboarded_at, binding_id)
     VALUES (?, ?, 'codex', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run("agent-1", "s1", "/work", "/t/s1.jsonl", "/home/.junto/seats/agent-1/sessions/s1.md", "Shipped it", 10, 20, "offboard", 19, null);
  insert.run("agent-1", "s2", "/work", null, "/home/.junto/seats/agent-1/sessions/s2.md", null, 20, null, null, null, "bind-1");
  insert.run("agent-2", "s3", null, null, "/home/.junto/seats/agent-2/sessions/s3.md", null, 5, 9, "replaced", null, null);
  database
    .prepare("INSERT INTO seat_session_drains(seat_id, session_id, detached_at, ended_at, ended_how) VALUES ('agent-1', 's1', 19, 25, 'settled')")
    .run();
};

describe("state migration 21 -> 22 (seat session data in the database)", () => {
  it("freezes the witnesses the step starts from and ends at", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V21_SQL)).toEqual(STATE_SCHEMA_V21_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V22_SQL)).toEqual(STATE_SCHEMA_V22_IDENTITY);
  });

  it.each(["command-center-v1.db", "remote-v1.db"])(
    "keeps every session of %s with its history, without notes_path, and adds the ledger and clock",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, versionTwentyOnePlan);
        seed(database);
        const before = snapshot(database);

        const result = migrateStateSchema(database, versionTwentyTwoPlan);
        expect(result).toMatchObject({ previousVersion: 21, schemaVersion: 22 });
        expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V22_IDENTITY);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        const {
          seat_sessions: sessions,
          seat_continuations_owed: owed,
          seat_offboard_clock: clock,
          ...rest
        } = snapshot(database);
        const { seat_sessions: sessionsBefore, ...restBefore } = before;
        expect(rest).toEqual(restBefore);
        expect(owed).toEqual([]);
        expect(clock).toEqual([]);
        expect(sessions).toEqual(
          (sessionsBefore as ReadonlyArray<Record<string, unknown>>).map(({ notes_path: _path, ...row }) => ({
            ...row,
            notes: null,
            continuation: null,
            ended_by: null,
            onboarded_at: null,
          })),
        );
        // The drain still belongs to its session.
        expect(database.prepare("SELECT seat_id, session_id FROM seat_session_drains").all()).toEqual([
          { seat_id: "agent-1", session_id: "s1" },
        ]);
      } finally {
        database.close();
      }
    },
  );

  it("bounds what a row holds as the files were bounded", async () => {
    const database = await openCopy("command-center-v1.db");
    try {
      migrateStateSchema(database, versionTwentyOnePlan);
      migrateStateSchema(database, versionTwentyTwoPlan);
      const insert = database.prepare(
        "INSERT INTO seat_sessions(seat_id, session_id, harness, started_at, notes, continuation, ended_at, end_reason, ended_by) VALUES ('a', ?, 'codex', 1, ?, ?, 2, 'offboard', ?)",
      );
      insert.run("ok", "n".repeat(16_000), "c".repeat(8_000), "operator");
      expect(() => insert.run("long-notes", "n".repeat(16_001), null, null)).toThrow();
      expect(() => insert.run("long-next", "n", "c".repeat(8_001), null)).toThrow();
      expect(() => insert.run("empty", "", null, null)).toThrow();
      expect(() => insert.run("who", "n", null, "agent")).toThrow();
    } finally {
      database.close();
    }
  });
});
