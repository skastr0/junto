/**
 * Step 78 keeps a remote seat delete durable on both sides: the seat
 * machine's held fence and the editor's owed finish. Expand-only: replay the
 * shipped fixtures to 77, run the step, and every table, row, index and
 * trigger already there is unchanged while only the two new tables appear.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V77_IDENTITY,
  STATE_SCHEMA_V78_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationDatabase,
  type StateSchemaMigrationPlan,
} from "../src/core/state/migrations";
import { migrateMachineNames } from "../src/core/state/migrate-machine-names";
import { expectedStateSchemaIdentity } from "../src/core/state/schema-identity";
import { STATE_SCHEMA_SQL } from "../src/core/state/schema";
import { STATE_SCHEMA_V77_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/state-v13/${name}`, import.meta.url));

const openCopy = async (source: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-terminal-delete-migration-"));
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

const all = (database: DatabaseSync, sql: string) =>
  database.prepare(sql).all() as unknown as ReadonlyArray<Record<string, SQLOutputValue>>;

const tables = (database: DatabaseSync): ReadonlyArray<string> =>
  all(database, `SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'state_schema_identity' ORDER BY name`)
    .map(({ name }) => String(name));

const rows = (database: DatabaseSync, table: string) =>
  all(database, `SELECT * FROM "${table}"`).map((row) => JSON.stringify(row)).sort();

const objects = (database: DatabaseSync) =>
  Object.fromEntries(
    all(database, `SELECT type, name, tbl_name, sql FROM sqlite_schema
        WHERE type IN ('index', 'trigger') AND name NOT GLOB 'sqlite_*' ORDER BY type, name`)
      .map((row) => [`${String(row.type)}:${String(row.name)}`, `${String(row.tbl_name)} ${String(row.sql ?? "").replace(/\s+/gu, " ").trim()}`]),
  );

describe("state migration 77 -> 78 (durable terminal deletes)", () => {
  it("ends at the version-78 witness as a fresh install has it", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(STATE_SCHEMA_V78_IDENTITY);
  });

  it("is expand-only and names no rebuild, drop, rename or retired column", () => {
    const step = STATE_SCHEMA_MIGRATIONS.find((candidate) => candidate.toVersion === 78)!;
    expect(step).toMatchObject({ fromVersion: 77, safety: "expand-only" });
    expect(step.replacesTables).toBeUndefined();
    expect(step.removesTables).toBeUndefined();
    expect(step.renamesTables).toBeUndefined();
    expect(step.retiresColumns).toBeUndefined();
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "replays %s from 77 and changes no kept row or object",
    async (name) => {
      const database = await openCopy(fixture(name));
      try {
        expect(migrateStateSchema(database, upTo(77, STATE_SCHEMA_V77_SQL))).toMatchObject({
          schemaVersion: 77,
          ...STATE_SCHEMA_V77_IDENTITY,
        });
        const beforeTables = tables(database);
        const beforeRows = Object.fromEntries(beforeTables.map((table) => [table, rows(database, table)]));
        const beforeObjects = objects(database);

        expect(migrateStateSchema(database, upTo(78, STATE_SCHEMA_SQL))).toMatchObject({
          previousVersion: 77,
          schemaVersion: 78,
          ...STATE_SCHEMA_V78_IDENTITY,
        });

        expect(tables(database)).toEqual([...beforeTables, "terminal_delete_held", "terminal_delete_owed"].sort());
        for (const table of beforeTables) expect(rows(database, table)).toEqual(beforeRows[table]);
        expect(rows(database, "terminal_delete_held")).toEqual([]);
        expect(rows(database, "terminal_delete_owed")).toEqual([]);
        expect(objects(database)).toEqual(beforeObjects);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        database.close();
      }
    },
    60_000,
  );

  it("holds no secrets or paths and closes the owed reason set", () => {
    const database = new DatabaseSync(":memory:");
    try {
      migrateStateSchema(database, upTo(78, STATE_SCHEMA_SQL));
      database.exec(`INSERT INTO terminal_delete_held(binding_id, canvas_name, seat_id, editor_installation_id, editor_canvas_seq, created_at)
        VALUES('binding', 'factory', 'seat', 'installation', 4, 10)`);
      database.exec(`INSERT INTO terminal_delete_owed(lease_id, binding_id, machine_name, canvas_name, seat_id, reason, created_at)
        VALUES('lease', 'binding', 'machine', 'factory', 'seat', 'epoch-changed', 10)`);
      expect(() => database.exec(`INSERT INTO terminal_delete_owed(lease_id, binding_id, machine_name, canvas_name, seat_id, reason, created_at)
        VALUES('lease', 'other', 'machine', 'factory', 'seat', 'maybe', 10)`)).toThrow(/CHECK/);
      expect(() => database.exec(`INSERT INTO terminal_delete_held(binding_id, canvas_name, seat_id, editor_installation_id, editor_canvas_seq, created_at)
        VALUES('other', 'factory', 'seat', 'installation', -1, 10)`)).toThrow(/CHECK/);
    } finally {
      database.close();
    }
  });
});
