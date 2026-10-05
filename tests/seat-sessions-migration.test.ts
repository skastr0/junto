/**
 * State migration 7 -> 8 adds seat sessions (expand only). Proven on the real
 * shipped fixture brought to version 7 by the real steps: every pre-existing
 * row survives byte for byte, and the new table holds a seat's session history
 * with one open session at most.
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
  STATE_SCHEMA_V7_IDENTITY,
  STATE_SCHEMA_V8_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V7_SQL, STATE_SCHEMA_V8_SQL } from "./fixtures/state-v1/schema";

const fixture = fileURLToPath(new URL("./fixtures/state-v1/command-center-v1.db", import.meta.url));

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-seat-sessions-migration-"));
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

const versionSevenPlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 7,
  currentSchemaSql: STATE_SCHEMA_V7_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 7),
};

// 8 -> 9 (signal attachments) lands on top; this suite stops at 8.
const versionEightPlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 8,
  currentSchemaSql: STATE_SCHEMA_V8_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 8),
};

describe("state migration 7 -> 8 (seat sessions)", () => {
  it("freezes the version-seven witness the step starts from and names the head", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V7_SQL)).toEqual(STATE_SCHEMA_V7_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V8_SQL)).toEqual(STATE_SCHEMA_V8_IDENTITY);
  });

  it("adds the table and leaves every existing row, immutable logs included, untouched", async () => {
    const database = await openCopy();
    try {
      migrateStateSchema(database, versionSevenPlan);
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
      const before = snapshot(database);
      expect((before.work_events as unknown[]).length).toBeGreaterThan(0);
      expect(before).not.toHaveProperty("seat_sessions");

      const result = migrateStateSchema(database, versionEightPlan);
      expect(result).toMatchObject({ previousVersion: 7, schemaVersion: 8 });
      expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V8_IDENTITY);

      const { seat_sessions: added, ...rest } = snapshot(database);
      expect(rest).toEqual(before);
      expect(added).toEqual([]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("holds one open session per seat, ended rows carry their reason, and refuses anything else", async () => {
    const database = await openCopy();
    try {
      migrateStateSchema(database, versionEightPlan);
      const insert = database.prepare(
        `INSERT INTO seat_sessions(seat_id, session_id, harness, notes_path, started_at, ended_at, end_reason)
         VALUES (?, ?, 'claude', '/n.md', ?, ?, ?)`,
      );
      insert.run("seat-1", "s1", 1, 5, "replaced");
      insert.run("seat-1", "s2", 5, null, null);
      insert.run("seat-2", "s1", 1, null, null);
      // A second open session for the same seat.
      expect(() => insert.run("seat-1", "s3", 6, null, null)).toThrow();
      // The same session twice for one seat.
      expect(() => insert.run("seat-1", "s1", 7, 8, "offboard")).toThrow();
      // An end without a reason, a reason without an end, an unknown reason.
      expect(() => insert.run("seat-3", "s1", 1, 2, null)).toThrow();
      expect(() => insert.run("seat-3", "s2", 1, null, "offboard")).toThrow();
      expect(() => insert.run("seat-3", "s3", 1, 2, "crashed")).toThrow();
      expect(() => insert.run("", "s4", 1, null, null)).toThrow();
    } finally {
      database.close();
    }
  });
});
