/**
 * Step 57 adds the machine code allowance (0.11, 05, Code steps, check 4):
 * which canvases this machine runs code steps for, machine-local: the step's
 * schema hashes the same as the witness, every row already held survives as
 * it was, and the new tables start empty, so a machine from before the step
 * runs no code.
 *
 * The version-56 database is made at version 56 (a fresh database takes the
 * witness schema whole), not by replaying 13 -> 56 over a shipped fixture:
 * that replay ran seconds under a loaded full run. It lives in memory, so no
 * path is shared with any other test, and rows seeded before the step stand in
 * for what a shipped database holds.
 */
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V56_IDENTITY,
  STATE_SCHEMA_V57_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, readRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V56_SQL, STATE_SCHEMA_V57_SQL } from "./fixtures/state-v13/schema";
import { MACHINE_CODE_ALLOWANCE_TABLES } from "../src/main/junto/automation/code-allowance-schema";

/** A version-56 database, fresh and in memory. */
const openAt56 = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:", { allowExtension: false, enableForeignKeyConstraints: true });
  expect(migrateStateSchema(database, upTo(56, STATE_SCHEMA_V56_SQL))).toMatchObject({ schemaVersion: 56, ...STATE_SCHEMA_V56_IDENTITY });
  return database;
};

/** What a machine from before the step holds: itself, a canvas, and a seat on it. */
const seed = (database: DatabaseSync): void => {
  database.exec(`
    INSERT INTO host_registry (id, label, is_this_machine, sort_order) VALUES ('macbook', 'MacBook', 1, 0);
    INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at) VALUES ('factory', 'canvas-1', 'now', 'now');
    INSERT INTO seats (canvas_name, id, x, y, width, height, z_index, created_at, updated_at,
      agent_key, label, binding_id, harness, overseer)
    VALUES ('factory', 'agent-1', 0, 0, 100, 100, 0, 'now', 'now', 'key-1', 'Agent', 'binding-1', 'claude', 0);
  `);
};

const tables = (database: DatabaseSync): ReadonlyArray<string> =>
  (
    database
      .prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'state_schema_identity'
          ORDER BY name`,
      )
      .all() as unknown as ReadonlyArray<{ readonly name: SQLOutputValue }>
  ).map(({ name }) => String(name));

const rows = (database: DatabaseSync, table: string) =>
  database.prepare(`SELECT * FROM "${table}" ORDER BY 1, 2`).all() as unknown as ReadonlyArray<Record<string, unknown>>;

const upTo = (version: number, currentSchemaSql: string): StateSchemaMigrationPlan => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version),
});

const TABLES: ReadonlyArray<string> = MACHINE_CODE_ALLOWANCE_TABLES;

describe("state migration 56 -> 57 (the machine code allowance)", () => {
  it("starts from the version-56 witness and ends at the version-57 one", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V56_SQL)).toEqual(STATE_SCHEMA_V56_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V57_SQL)).toEqual(STATE_SCHEMA_V57_IDENTITY);
  });

  it(
    "adds the empty allowance tables, hashes as a fresh 57, and leaves every row as it was",
    () => {
      const database = openAt56();
      try {
        seed(database);
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        expect(before["seats"]).toHaveLength(1);
        for (const table of TABLES) expect(Object.keys(before)).not.toContain(table);

        const result = migrateStateSchema(database, upTo(57, STATE_SCHEMA_V57_SQL));
        expect(result).toMatchObject({ previousVersion: 56, schemaVersion: 57, ...STATE_SCHEMA_V57_IDENTITY });
        expect(readRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V57_IDENTITY);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        const after = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        expect(Object.keys(after).filter((table) => !TABLES.includes(table))).toEqual(Object.keys(before));
        for (const table of TABLES) expect(after[table], table).toEqual([]);
        for (const table of Object.keys(before)) expect(after[table], table).toEqual(before[table]);
      } finally {
        database.close();
      }
    },
    60_000,
  );

  it("holds a closed scope, an installation per row, and goes with its canvas", () => {
    const database = openAt56();
    try {
      migrateStateSchema(database, upTo(57, STATE_SCHEMA_V57_SQL));
      database
        .prepare("INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at) VALUES ('main', 'c1', 'now', 'now')")
        .run();
      expect(() => database.prepare("INSERT INTO machine_code_allowances (canvas_name, scope) VALUES ('main', 'anyone')").run()).toThrow();
      expect(() => database.prepare("INSERT INTO machine_code_allowances (canvas_name, scope) VALUES ('gone', 'operator')").run()).toThrow();
      database.prepare("INSERT INTO machine_code_allowances (canvas_name, scope) VALUES ('main', 'operator')").run();
      database.prepare("INSERT INTO machine_code_allowance_installations (canvas_name, installation_id) VALUES ('main', 'inst-a')").run();
      expect(() => database.prepare("INSERT INTO machine_code_allowance_installations (canvas_name, installation_id) VALUES ('main', 'inst-a')").run()).toThrow();
      database.prepare("DELETE FROM canvases WHERE canvas_name = 'main'").run();
      for (const table of TABLES) expect(rows(database, table), table).toEqual([]);
    } finally {
      database.close();
    }
  });
});
