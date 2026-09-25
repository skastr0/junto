/**
 * State migration 3 -> 4 adds squads, expand-only. Proven on the real shipped
 * fixture (brought to version 3 by the real 1 -> 2 and 2 -> 3 steps), with the
 * production DDL and triggers live and rows in the immutable work logs: every
 * pre-existing row survives byte for byte and the new table takes writes.
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
  STATE_SCHEMA_V3_IDENTITY,
  STATE_SCHEMA_V4_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import {
  expectedStateSchemaIdentity,
  verifyRecordedStateSchemaIdentity,
} from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V3_SQL } from "./fixtures/state-v1/schema";

const fixture = fileURLToPath(
  new URL("./fixtures/state-v1/command-center-v1.db", import.meta.url),
);

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-squads-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fixture, path);
  const database = new DatabaseSync(path, {
    open: true,
    readOnly: false,
    allowExtension: false,
    enableForeignKeyConstraints: true,
  });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
};

const tableNames = (database: DatabaseSync): string[] =>
  (
    database
      .prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name NOT GLOB 'sqlite_*'
            AND name <> 'state_schema_identity'
          ORDER BY name`,
      )
      .all() as unknown as ReadonlyArray<{ readonly name: SQLOutputValue }>
  ).map(({ name }) => String(name));

const snapshot = (database: DatabaseSync) =>
  Object.fromEntries(
    tableNames(database).map((table) => [
      table,
      database.prepare(`SELECT * FROM "${table}" ORDER BY 1`).all(),
    ]),
  );

const versionThreePlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 3,
  currentSchemaSql: STATE_SCHEMA_V3_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 3),
};

describe("state migration 3 -> 4 (squads)", () => {
  it("freezes the version-three witness the step starts from", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V3_SQL)).toEqual(
      STATE_SCHEMA_V3_IDENTITY,
    );
  });

  it("keeps every existing row, immutable logs included, and adds the table", async () => {
    const database = await openCopy();
    try {
      migrateStateSchema(database, versionThreePlan);
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
      const before = snapshot(database);
      expect((before.work_events as unknown[]).length).toBeGreaterThan(0);
      expect(before).not.toHaveProperty("squads");

      const result = migrateStateSchema(database);
      expect(result).toMatchObject({ previousVersion: 3, schemaVersion: 4 });
      expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(
        STATE_SCHEMA_V4_IDENTITY,
      );

      const after = snapshot(database);
      const { squads, ...rest } = after;
      expect(rest).toEqual(before);
      expect(squads).toEqual([]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      const insert = database.prepare(
        `INSERT INTO squads(squad_id, name, body_json, created_at, updated_at)
         VALUES (?, ?, ?, 1, 1)`,
      );
      insert.run("q1", "Review crew", '{"seats":[]}');
      // Names are unique regardless of case.
      expect(() => insert.run("q2", "review CREW", '{"seats":[]}')).toThrow();
      // The body must be JSON.
      expect(() => insert.run("q3", "Other", "not json")).toThrow();
      // A blank name is refused.
      expect(() => insert.run("q4", "   ", '{"seats":[]}')).toThrow();
    } finally {
      database.close();
    }
  });
});
