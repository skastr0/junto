/**
 * Step 57 adds the machine code allowance (0.11, 05, Code steps, check 4):
 * which canvases this machine runs code steps for, machine-local. Proven on
 * both shipped fixtures brought to version 56 by the real steps: the step's
 * schema hashes the same as the witness, every row already held survives as
 * it was, and the new tables start empty, so a machine from before the step
 * runs no code.
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
  STATE_SCHEMA_V56_IDENTITY,
  STATE_SCHEMA_V57_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, readRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V56_SQL, STATE_SCHEMA_V57_SQL } from "./fixtures/state-v13/schema";
import { MACHINE_CODE_ALLOWANCE_TABLES } from "../src/main/junto/automation/code-allowance-schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-code-allowance-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fileURLToPath(new URL(`./fixtures/state-v13/${fixture}`, import.meta.url)), path);
  const database = new DatabaseSync(path, { open: true, readOnly: false, allowExtension: false, enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
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

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "adds the empty allowance tables to %s, hashes as a fresh 57, and leaves every row as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, upTo(56, STATE_SCHEMA_V56_SQL));
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
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

  it("holds a closed scope, an installation per row, and goes with its canvas", async () => {
    const database = await openCopy("command-center-v13.db");
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
