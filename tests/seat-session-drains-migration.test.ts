/**
 * State migration 9 -> 10 adds seat session drains (expand only). Proven on
 * the real shipped fixture brought to version 9 by the real steps: every
 * pre-existing row survives byte for byte, and the new table holds what
 * became of an offboarded session's process: detached, then ended and how.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V9_IDENTITY,
  STATE_SCHEMA_V10_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { STATE_SCHEMA_V9_SQL } from "./fixtures/state-v1/schema";

const fixture = fileURLToPath(new URL("./fixtures/state-v1/command-center-v1.db", import.meta.url));

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-seat-session-drains-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fixture, path);
  const database = new DatabaseSync(path, { open: true, readOnly: false, allowExtension: false, enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
};

const tableNames = (database: DatabaseSync): string[] =>
  (
    database
      .prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'state_schema_identity'
          ORDER BY name`,
      )
      .all() as unknown as ReadonlyArray<{ readonly name: SQLOutputValue }>
  ).map(({ name }) => String(name));

const snapshot = (database: DatabaseSync) =>
  Object.fromEntries(
    tableNames(database).map((table) => [table, database.prepare(`SELECT * FROM "${table}" ORDER BY 1`).all()]),
  );

const versionNinePlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 9,
  currentSchemaSql: STATE_SCHEMA_V9_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 9),
};

describe("state migration 9 -> 10 (seat session drains)", () => {
  it("freezes the version-nine witness the step starts from and names the head", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V9_SQL)).toEqual(STATE_SCHEMA_V9_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(STATE_SCHEMA_V10_IDENTITY);
  });

  it("adds the table and leaves every existing row, immutable logs and session history included, untouched", async () => {
    const database = await openCopy();
    try {
      migrateStateSchema(database, versionNinePlan);
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 9 });
      // A session that offboarded before drains were recorded.
      database
        .prepare(
          `INSERT INTO seat_sessions(seat_id, session_id, harness, notes_path, started_at, ended_at, end_reason, offboarded_at)
           VALUES ('seat-old', 's0', 'claude', '/tmp/s0.md', 1, 5, 'offboard', 4)`,
        )
        .run();
      const before = snapshot(database);
      expect((before.work_events as unknown[]).length).toBeGreaterThan(0);
      expect(before).not.toHaveProperty("seat_session_drains");

      const result = migrateStateSchema(database);
      expect(result).toMatchObject({ previousVersion: 9, schemaVersion: 10 });
      expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V10_IDENTITY);

      const { seat_session_drains: added, ...rest } = snapshot(database);
      expect(rest).toEqual(before);
      // History from before the migration gains no invented drain.
      expect(added).toEqual([]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("holds a detach and its end, refuses anything dishonest, and goes with its session", async () => {
    const database = await openCopy();
    try {
      migrateStateSchema(database);
      database
        .prepare(
          `INSERT INTO seat_sessions(seat_id, session_id, harness, notes_path, started_at, ended_at, end_reason)
           VALUES ('seat-a', 's1', 'claude', '/tmp/s1.md', 1, 100, 'offboard')`,
        )
        .run();
      const insert = database.prepare(
        "INSERT INTO seat_session_drains(seat_id, session_id, detached_at, ended_at, ended_how) VALUES (?, ?, ?, ?, ?)",
      );
      // Winding down: detached, no end yet.
      insert.run("seat-a", "s1", 100, null, null);
      expect(database.prepare("SELECT * FROM seat_session_drains").all()).toEqual([
        { seat_id: "seat-a", session_id: "s1", detached_at: 100, ended_at: null, ended_how: null },
      ]);
      // One drain per session.
      expect(() => insert.run("seat-a", "s1", 200, null, null)).toThrow();
      // A session the seat never ran.
      expect(() => insert.run("seat-a", "nope", 100, null, null)).toThrow();
      // An end without a how, a how without an end, a how that is not one, an end before the detach.
      const update = (endedAt: number | null, how: string | null) =>
        database.prepare("UPDATE seat_session_drains SET ended_at = ?, ended_how = ? WHERE session_id = 's1'").run(endedAt, how);
      expect(() => update(150, null)).toThrow();
      expect(() => update(null, "settled")).toThrow();
      expect(() => update(150, "vanished")).toThrow();
      expect(() => update(50, "settled")).toThrow();
      for (const how of ["settled", "cap", "crashed", "quit"]) expect(() => update(150, how)).not.toThrow();

      database.prepare("DELETE FROM seat_sessions WHERE seat_id = 'seat-a'").run();
      expect(database.prepare("SELECT COUNT(*) AS n FROM seat_session_drains").get()).toEqual({ n: 0 });
    } finally {
      database.close();
    }
  });
});
