/**
 * Step 80 to 81 adds `canvas_files_carried`, which machine the editor last
 * sent a Files node of whole (0.12.1, X6, remote-security C2), so a restart
 * keeps the departure mark. Expand only: one new, empty table, and no kept
 * row moves. Proven on both shipped fixtures replayed to 80 on the
 * production DDL.
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
  STATE_SCHEMA_V80_IDENTITY,
  STATE_SCHEMA_V81_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationDatabase,
  type StateSchemaMigrationPlan,
} from "../src/core/state/migrations";
import { migrateMachineNames } from "../src/core/state/migrate-machine-names";
import { expectedStateSchemaIdentity } from "../src/core/state/schema-identity";
import { STATE_SCHEMA_V80_SQL, STATE_SCHEMA_V81_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (name: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-files-carried-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fileURLToPath(new URL(`./fixtures/state-v13/${name}`, import.meta.url)), path);
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
      : step),
});

/** Every kept table but the schema's own witness, which a step rewrites. */
const tables = (database: DatabaseSync): string[] =>
  database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'state_schema_identity' ORDER BY name").all().map((row) => String(row.name));
const contents = (database: DatabaseSync): Record<string, string[]> => Object.fromEntries(tables(database).map((table) => [
  table, database.prepare(`SELECT * FROM "${table}"`).all().map((row) => JSON.stringify(row)).sort(),
]));

describe("state migration 80 -> 81 (which machine was last sent a Files node)", () => {
  it("starts from the version-80 witness and ends at the version-81 one", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V80_SQL)).toEqual(STATE_SCHEMA_V80_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V81_SQL)).toEqual(STATE_SCHEMA_V81_IDENTITY);
  });

  it("is expand only: it replaces, removes, renames and retires nothing", () => {
    const step = STATE_SCHEMA_MIGRATIONS.find((candidate) => candidate.toVersion === 81)!;
    expect(step).toMatchObject({ fromVersion: 80, safety: "expand-only" });
    expect(step.replacesTables).toBeUndefined();
    expect(step.removesTables).toBeUndefined();
    expect(step.renamesTables).toBeUndefined();
    expect(step.retiresColumns).toBeUndefined();
  });

  it.each(["command-center-v13.db", "remote-v13.db"])("adds one empty table to %s and moves no kept row", async (name) => {
    const database = await openCopy(name);
    try {
      expect(migrateStateSchema(database, upTo(80, STATE_SCHEMA_V80_SQL))).toMatchObject({ schemaVersion: 80, ...STATE_SCHEMA_V80_IDENTITY });
      const before = contents(database);
      expect(migrateStateSchema(database, upTo(81, STATE_SCHEMA_V81_SQL))).toMatchObject({ schemaVersion: 81, ...STATE_SCHEMA_V81_IDENTITY });
      const { canvas_files_carried: carried, ...rest } = contents(database);
      expect(carried).toEqual([]);
      expect(rest).toEqual(before);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      database.close();
    }
  });
});
