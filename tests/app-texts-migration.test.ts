/**
 * State migration 11 -> 12 adds app texts (expand only): the app briefing and
 * the named references a seat reads on demand. Proven on the real shipped
 * fixture brought to version 11 by the real steps, with rows already in the
 * immutable work log: every pre-existing row survives byte for byte, and the
 * one new table starts empty.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURRENT_STATE_SCHEMA_IDENTITY,
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V11_IDENTITY,
  STATE_SCHEMA_V12_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { STATE_SCHEMA_V11_SQL } from "./fixtures/state-v1/schema";

const fixture = fileURLToPath(new URL("./fixtures/state-v1/command-center-v1.db", import.meta.url));

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-app-texts-migration-"));
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
    tableNames(database).map((table) => [table, database.prepare(`SELECT * FROM "${table}" ORDER BY 1, 2`).all()]),
  );

const versionElevenPlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 11,
  currentSchemaSql: STATE_SCHEMA_V11_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 11),
};

describe("state migration 11 -> 12 (app texts)", () => {
  it("freezes the version-eleven witness the step starts from and names the head", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V11_SQL)).toEqual(STATE_SCHEMA_V11_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(STATE_SCHEMA_V12_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toBe(STATE_SCHEMA_V12_IDENTITY);
  });

  it("adds the one table and leaves every row already held as it was", async () => {
    const database = await openCopy();
    try {
      migrateStateSchema(database, versionElevenPlan);
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 11 });
      const before = snapshot(database);
      expect((before.work_events as unknown[]).length).toBeGreaterThan(0);
      expect(before).not.toHaveProperty("app_texts");

      const result = migrateStateSchema(database);
      expect(result).toMatchObject({ previousVersion: 11, schemaVersion: 12 });
      expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V12_IDENTITY);

      const { app_texts: texts, ...rest } = snapshot(database);
      expect(rest).toEqual(before);
      expect(texts).toEqual([]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("holds one briefing, app and region references of any length, and refuses a row that fits no scope", async () => {
    const database = await openCopy();
    try {
      migrateStateSchema(database);
      const insert = database.prepare(
        `INSERT INTO app_texts(scope_kind, canvas_name, region_id, name, description, body, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, 1, 'operator')`,
      );
      const long = "x".repeat(300_000);
      insert.run("briefing", "", "", "", null, long);
      insert.run("app", "", "", "style", long, long);
      insert.run("app", "", "", "release", null, "How we ship.");
      // The same name in two regions, and in the app, are different rows; a region no canvas has is still held.
      insert.run("region", "factory", "region-1", "style", null, "Region style.");
      insert.run("region", "factory", "region-gone", "style", null, "Other style.");
      expect(database.prepare("SELECT COUNT(*) AS n FROM app_texts").get()).toEqual({ n: 5 });

      // One briefing only, and one row per name in a scope.
      expect(() => insert.run("briefing", "", "", "", null, "again")).toThrow();
      expect(() => insert.run("app", "", "", "style", null, "again")).toThrow();
      // A briefing has no name, description or place; an app reference has a name and no place; a region one has both.
      expect(() => insert.run("briefing", "", "", "named", null, "b")).toThrow();
      expect(() => insert.run("briefing", "", "", "", "described", "b")).toThrow();
      expect(() => insert.run("app", "", "", "", null, "b")).toThrow();
      expect(() => insert.run("app", "factory", "", "placed", null, "b")).toThrow();
      expect(() => insert.run("app", "", "", "n".repeat(81), null, "b")).toThrow();
      expect(() => insert.run("region", "", "region-1", "nowhere", null, "b")).toThrow();
      expect(() => insert.run("region", "factory", "", "nowhere", null, "b")).toThrow();
      expect(() => insert.run("canvas", "factory", "", "other", null, "b")).toThrow();
      // Empty prose is an absent row, never a stored one.
      expect(() => insert.run("app", "", "", "empty", null, "")).toThrow();
      expect(() => insert.run("app", "", "", "empty", "", "b")).toThrow();
    } finally {
      database.close();
    }
  });
});
