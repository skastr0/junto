/**
 * Step 79 to 80 adds `machine_peer_seen`, what each peer last said of itself
 * in a hello this machine admitted (0.12, Remote slice 1). Expand only: one
 * new, empty table, and no kept row moves. Proven on both shipped fixtures
 * replayed to 79 on the production DDL.
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
  STATE_SCHEMA_V80_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationDatabase,
  type StateSchemaMigrationPlan,
} from "../src/core/state/migrations";
import { migrateMachineNames } from "../src/core/state/migrate-machine-names";
import { expectedStateSchemaIdentity } from "../src/core/state/schema-identity";
import { STATE_SCHEMA_SQL } from "../src/core/state/schema";
import { STATE_SCHEMA_V79_SQL, STATE_SCHEMA_V80_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (name: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-peer-seen-migration-"));
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

describe("state migration 79 -> 80 (what each peer last said it runs)", () => {
  it("starts from the version-79 witness and ends at the version-80 one, as a fresh install has it", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V79_SQL)).toEqual(STATE_SCHEMA_V79_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V80_SQL)).toEqual(STATE_SCHEMA_V80_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(STATE_SCHEMA_V80_IDENTITY);
  });

  it("is expand only: it replaces, removes, renames and retires nothing", () => {
    const step = STATE_SCHEMA_MIGRATIONS.find((candidate) => candidate.toVersion === 80)!;
    expect(step).toMatchObject({ fromVersion: 79, safety: "expand-only" });
    expect(step.replacesTables).toBeUndefined();
    expect(step.removesTables).toBeUndefined();
    expect(step.renamesTables).toBeUndefined();
    expect(step.retiresColumns).toBeUndefined();
  });

  it.each(["command-center-v13.db", "remote-v13.db"])("adds one empty table to %s and moves no kept row", async (name) => {
    const database = await openCopy(name);
    try {
      expect(migrateStateSchema(database, upTo(79, STATE_SCHEMA_V79_SQL))).toMatchObject({ schemaVersion: 79, ...STATE_SCHEMA_V79_IDENTITY });
      const before = contents(database);
      expect(migrateStateSchema(database, upTo(80, STATE_SCHEMA_V80_SQL))).toMatchObject({ schemaVersion: 80, ...STATE_SCHEMA_V80_IDENTITY });
      const { machine_peer_seen: seen, ...rest } = contents(database);
      expect(seen).toEqual([]);
      expect(rest).toEqual(before);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      database.close();
    }
  });
});
