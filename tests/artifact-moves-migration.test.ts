/**
 * State migration 63 -> 64 keeps where each artifact has been (0.11.1, 10 M1):
 * `artifact_moves` is added, empty, and nothing else changes.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateMachineNames } from "../src/main/junto/state/migrate-machine-names";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V63_IDENTITY,
  STATE_SCHEMA_V64_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { expectedStateSchemaIdentity, readRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V63_SQL, STATE_SCHEMA_V64_SQL } from "./fixtures/state-v13/schema";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  const dir = await mkdtemp(join(tmpdir(), "junto-artifact-moves-"));
  dirs.push(dir);
  const path = join(dir, "junto.db");
  await copyFile(fileURLToPath(new URL(`./fixtures/state-v13/${fixture}`, import.meta.url)), path);
  return new DatabaseSync(path, { open: true, readOnly: false, allowExtension: false, enableForeignKeyConstraints: true });
};

const tables = (database: DatabaseSync): ReadonlyArray<string> =>
  (database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as ReadonlyArray<{ name: string }>).map(
    (row) => row.name,
  );

const named = <T extends { readonly toVersion: number; readonly migrate: (database: DatabaseSync) => void }>(step: T): T =>
  step.toVersion === 21 ? { ...step, migrate: (database: DatabaseSync) => migrateMachineNames(database, "macbook") } : step;

const upTo = (version: number, currentSchemaSql: string): StateSchemaMigrationPlan => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version).map(named),
});

describe("state migration 63 -> 64 (where each artifact has been)", () => {
  it("starts from the version-63 witness and ends at the head, which a fresh database matches", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V63_SQL)).toEqual(STATE_SCHEMA_V63_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V64_SQL)).toEqual(STATE_SCHEMA_V64_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(STATE_SCHEMA_V64_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])("adds artifact_moves to %s, empty, and only that", async (fixture) => {
    const database = await openCopy(fixture);
    try {
      migrateStateSchema(database, upTo(63, STATE_SCHEMA_V63_SQL));
      const before = tables(database);
      const result = migrateStateSchema(database, upTo(64, STATE_SCHEMA_V64_SQL));
      expect(result).toMatchObject({ previousVersion: 63, schemaVersion: 64, ...STATE_SCHEMA_V64_IDENTITY });
      expect(readRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V64_IDENTITY);
      expect(tables(database)).toEqual([...before, "artifact_moves"].sort());
      expect(database.prepare("SELECT count(*) AS n FROM artifact_moves").get()).toEqual({ n: 0 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
