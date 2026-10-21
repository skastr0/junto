/**
 * Step 40 lets a full touched-origin record admit an origin it already
 * holds: the limit trigger fired before ON CONFLICT DO NOTHING, so at 4096
 * rows even a recorded origin was refused, and so was every seat eval in it.
 * Proven on a fixture brought to version 39 by the real steps.
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
  STATE_SCHEMA_V39_IDENTITY,
  STATE_SCHEMA_V40_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { STATE_SCHEMA_V39_SQL, STATE_SCHEMA_V40_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-touched-origins-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fileURLToPath(new URL("./fixtures/state-v13/command-center-v13.db", import.meta.url)), path);
  const database = new DatabaseSync(path, { open: true, readOnly: false, allowExtension: false, enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
};

const named = <T extends { readonly toVersion: number; readonly migrate: (database: DatabaseSync) => void }>(step: T): T =>
  step.toVersion === 21 ? { ...step, migrate: (database: DatabaseSync) => migrateMachineNames(database, "macbook") } : step;

const upTo = (version: number, currentSchemaSql: string): StateSchemaMigrationPlan => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version).map(named),
});

const fill = (database: DatabaseSync): void => {
  database.exec(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4096)
    INSERT INTO browser_touched_origins (profile, origin)
    SELECT 'personal', 'https://filler-' || i || '.example.com' FROM n
  `);
};

const record = (database: DatabaseSync, origin: string): void => {
  database
    .prepare("INSERT INTO browser_touched_origins (profile, origin) VALUES ('personal', ?) ON CONFLICT (profile, origin) DO NOTHING")
    .run(origin);
};

describe("state step 39 to 40: the touched-origin limit", () => {
  it("starts from the version-39 witness and ends at the version-40 one, which is the head", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V39_SQL)).toEqual(STATE_SCHEMA_V39_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V40_SQL)).toEqual(STATE_SCHEMA_V40_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(STATE_SCHEMA_V40_IDENTITY);
  });

  it("at 4096 rows refuses a new origin and admits one it holds", async () => {
    const database = await openCopy();
    try {
      migrateStateSchema(database, upTo(39, STATE_SCHEMA_V39_SQL));
      fill(database);
      // Before the step a held origin was refused too.
      expect(() => record(database, "https://filler-7.example.com")).toThrow(/touched-origin limit reached/);

      expect(migrateStateSchema(database, upTo(40, STATE_SCHEMA_V40_SQL))).toMatchObject({ previousVersion: 39, schemaVersion: 40 });
      expect(() => record(database, "https://filler-7.example.com")).not.toThrow();
      expect(() => record(database, "https://new.example.com")).toThrow(/touched-origin limit reached/);
      expect(Number(database.prepare("SELECT count(*) AS n FROM browser_touched_origins").get()!.n)).toBe(4096);
    } finally {
      database.close();
    }
  });
});
