/**
 * State migration 22 -> 23 adds the harness model cache (expand only). Proven
 * on both shipped fixtures brought to version 22 by the real steps: every row
 * already held survives as it was, and the one new table starts empty. There
 * is no importer: the cache is rebuilt from the harnesses, and the old
 * `harness-models.json` is never read.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateMachineNames } from "../src/main/junto/state/migrate-machine-names";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V22_IDENTITY,
  STATE_SCHEMA_V23_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V22_SQL, STATE_SCHEMA_V23_SQL } from "./fixtures/state-v1/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-harness-model-cache-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fileURLToPath(new URL(`./fixtures/state-v1/${fixture}`, import.meta.url)), path);
  const database = new DatabaseSync(path, { open: true, readOnly: false, allowExtension: false, enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
};

const snapshot = (database: DatabaseSync) =>
  Object.fromEntries(
    (
      database
        .prepare(
          `SELECT name FROM sqlite_schema
            WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'state_schema_identity'
            ORDER BY name`,
        )
        .all() as unknown as ReadonlyArray<{ readonly name: SQLOutputValue }>
    ).map(({ name }) => [String(name), database.prepare(`SELECT * FROM "${String(name)}" ORDER BY 1, 2`).all()]),
  );

/** The real steps, with the name first boot would give fixed so the proof does not depend on where it runs. */
const named = <T extends { readonly toVersion: number; readonly migrate: (database: DatabaseSync) => void }>(step: T): T =>
  step.toVersion === 21 ? { ...step, migrate: (database: DatabaseSync) => migrateMachineNames(database, "macbook") } : step;

const versionTwentyTwoPlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 22,
  currentSchemaSql: STATE_SCHEMA_V22_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 22).map(named),
};

const versionTwentyThreePlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 23,
  currentSchemaSql: STATE_SCHEMA_V23_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 23).map(named),
};

describe("state migration 22 -> 23 (harness model cache)", () => {
  it("freezes the witnesses the step starts from and ends at", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V22_SQL)).toEqual(STATE_SCHEMA_V22_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V23_SQL)).toEqual(STATE_SCHEMA_V23_IDENTITY);
  });

  it.each(["command-center-v1.db", "remote-v1.db"])(
    "adds the one table to %s and leaves every row already held as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, versionTwentyTwoPlan);
        const before = snapshot(database);
        expect((before.work_events as unknown[]).length).toBeGreaterThan(0);
        expect(before).not.toHaveProperty("harness_model_cache");

        const result = migrateStateSchema(database, versionTwentyThreePlan);
        expect(result).toMatchObject({ previousVersion: 22, schemaVersion: 23 });
        expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V23_IDENTITY);

        const { harness_model_cache: cache, ...rest } = snapshot(database);
        expect(rest).toEqual(before);
        expect(cache).toEqual([]);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        database.close();
      }
    },
  );

  it("holds one list per harness and refuses a row that is not one", async () => {
    const database = await openCopy("command-center-v1.db");
    try {
      migrateStateSchema(database, versionTwentyThreePlan);
      const insert = database.prepare(
        `INSERT INTO harness_model_cache(harness, fingerprint, scanned_at, version, result, profiles)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const result = JSON.stringify({ models: [], source: "empty", efforts: [] });
      insert.run("claude", "/bin/claude:10:20", 1, "2.1.300", result, null);
      insert.run("hermes", "/bin/hermes:10:20", 1, null, result, JSON.stringify([{ name: "work" }]));
      expect(database.prepare("SELECT COUNT(*) AS n FROM harness_model_cache").get()).toEqual({ n: 2 });

      expect(() => insert.run("claude", "/bin/claude:10:21", 2, null, result, null)).toThrow();
      expect(() => insert.run("", "/bin/x:1:1", 1, null, result, null)).toThrow();
      expect(() => insert.run("codex", "", 1, null, result, null)).toThrow();
      expect(() => insert.run("codex", "/bin/codex:1:1", -1, null, result, null)).toThrow();
      expect(() => insert.run("codex", "/bin/codex:1:1", 1, "", result, null)).toThrow();
      expect(() => insert.run("codex", "/bin/codex:1:1", 1, null, "not json", null)).toThrow();
      expect(() => insert.run("codex", "/bin/codex:1:1", 1, null, result, "not json")).toThrow();
    } finally {
      database.close();
    }
  });
});
