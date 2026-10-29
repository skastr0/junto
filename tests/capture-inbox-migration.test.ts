/**
 * State migration 64 -> 65 keeps quick capture's Inbox (0.11.2, 11 Q4):
 * `view_capture_inboxes` is added, empty, and nothing else changes.
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
  STATE_SCHEMA_V64_IDENTITY,
  STATE_SCHEMA_V65_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { expectedStateSchemaIdentity, readRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V64_SQL, STATE_SCHEMA_V65_SQL } from "./fixtures/state-v13/schema";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  const dir = await mkdtemp(join(tmpdir(), "junto-capture-inbox-"));
  dirs.push(dir);
  const path = join(dir, "junto.db");
  await copyFile(fileURLToPath(new URL(`./fixtures/state-v13/${fixture}`, import.meta.url)), path);
  return new DatabaseSync(path, { open: true, readOnly: false, allowExtension: false, enableForeignKeyConstraints: true });
};

const tables = (database: DatabaseSync): ReadonlyArray<string> =>
  (database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as unknown as ReadonlyArray<{ name: string }>).map(
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

describe("state migration 64 -> 65 (quick capture's Inbox)", () => {
  it("starts from the version-64 witness and ends at the head, which a fresh database matches", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V64_SQL)).toEqual(STATE_SCHEMA_V64_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V65_SQL)).toEqual(STATE_SCHEMA_V65_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(STATE_SCHEMA_V65_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])("adds view_capture_inboxes to %s, empty, and only that", async (fixture) => {
    const database = await openCopy(fixture);
    try {
      migrateStateSchema(database, upTo(64, STATE_SCHEMA_V64_SQL));
      const before = tables(database);
      const result = migrateStateSchema(database, upTo(65, STATE_SCHEMA_V65_SQL));
      expect(result).toMatchObject({ previousVersion: 64, schemaVersion: 65, ...STATE_SCHEMA_V65_IDENTITY });
      expect(readRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V65_IDENTITY);
      expect(tables(database)).toEqual([...before, "view_capture_inboxes"].sort());
      expect(database.prepare("SELECT count(*) AS n FROM view_capture_inboxes").get()).toEqual({ n: 0 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
