/**
 * State migration 22 -> 23 adds the harness model tables (expand only). Proven
 * on both shipped fixtures brought to version 22 by the real steps: every row
 * already held survives as it was, and the new tables start empty. There is
 * no importer: the cache is rebuilt from the harnesses, and the old
 * `harness-models.json` is never read. The step was amended in place before
 * any install ran it (operator, 2026-10-18).
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
import { STATE_SCHEMA_V22_SQL, STATE_SCHEMA_V23_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-harness-model-cache-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fileURLToPath(new URL(`./fixtures/state-v13/${fixture}`, import.meta.url)), path);
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

const planTo = (version: number, currentSchemaSql: string) => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version).map(named),
});

const TABLES = ["harness_model_efforts", "harness_models", "harness_profiles", "harness_scans"];

/** One harness's scan as the inventory writes it. */
const seed = (database: DatabaseSync): void => {
  database
    .prepare("INSERT INTO harness_scans(harness, fingerprint, version, source, scanned_at) VALUES (?, ?, ?, ?, ?)")
    .run("pi", "/bin/pi:10:20", "0.70.0", "command", 1_760_000_000_000);
  const model = database.prepare(
    "INSERT INTO harness_models(harness, model, provider, label, description, position) VALUES ('pi', ?, ?, ?, ?, ?)",
  );
  model.run("opencode-go/deepseek-v4-flash", "opencode-go", "deepseek-v4-flash", "opencode-go", 0);
  model.run("anthropic/claude-opus-5-5", "anthropic", "claude-opus-5-5", null, 1);
  database
    .prepare("INSERT INTO harness_model_efforts(harness, model, effort, position) VALUES ('pi', ?, ?, ?)")
    .run("anthropic/claude-opus-5-5", "high", 0);
  database.prepare("INSERT INTO harness_profiles(harness, profile, model, position) VALUES ('pi', 'work', NULL, 0)").run();
};

const found = (database: DatabaseSync, query: string) =>
  database
    .prepare(
      `SELECT m.model FROM harness_models_search JOIN harness_models m ON m.id = harness_models_search.rowid
        WHERE harness_models_search MATCH ? ORDER BY bm25(harness_models_search)`,
    )
    .all(query)
    .map((row) => row.model);

describe("state migration 22 -> 23 (harness model cache)", () => {
  it("freezes the witnesses the step starts from and ends at", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V22_SQL)).toEqual(STATE_SCHEMA_V22_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V23_SQL)).toEqual(STATE_SCHEMA_V23_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "adds the tables to %s and leaves every row already held as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, planTo(22, STATE_SCHEMA_V22_SQL));
        const before = snapshot(database);
        expect((before.work_events as unknown[]).length).toBeGreaterThan(0);

        const result = migrateStateSchema(database, planTo(23, STATE_SCHEMA_V23_SQL));
        expect(result).toMatchObject({ previousVersion: 22, schemaVersion: 23 });
        expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V23_IDENTITY);

        const after = snapshot(database);
        const added = Object.keys(after).filter((name) => name.startsWith("harness_"));
        expect(Object.fromEntries(Object.entries(after).filter(([name]) => !added.includes(name)))).toEqual(before);
        for (const table of TABLES) expect(after[table], table).toEqual([]);
        expect(after.harness_models_search).toEqual([]);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        database.close();
      }
    },
  );

  it("finds a model by any three letters of its id, provider, label or description", async () => {
    const database = await openCopy("command-center-v13.db");
    try {
      migrateStateSchema(database, planTo(23, STATE_SCHEMA_V23_SQL));
      seed(database);
      expect(found(database, "seek")).toEqual(["opencode-go/deepseek-v4-flash"]);
      expect(found(database, "OPUS")).toEqual(["anthropic/claude-opus-5-5"]);
      expect(found(database, "anthropic")).toEqual(["anthropic/claude-opus-5-5"]);
      // A renamed model is found by its new label only.
      database.prepare("UPDATE harness_models SET label = 'swift' WHERE model = 'opencode-go/deepseek-v4-flash'").run();
      expect(found(database, "swift")).toEqual(["opencode-go/deepseek-v4-flash"]);
      expect(found(database, `"v4-flash"`)).toEqual(["opencode-go/deepseek-v4-flash"]);
    } finally {
      database.close();
    }
  });

  it("clears a harness, its search entries with it, when its scan row goes", async () => {
    const database = await openCopy("command-center-v13.db");
    try {
      migrateStateSchema(database, planTo(23, STATE_SCHEMA_V23_SQL));
      seed(database);
      database.prepare("DELETE FROM harness_scans WHERE harness = 'pi'").run();
      for (const table of TABLES) expect(database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
      expect(found(database, "seek")).toEqual([]);
      expect(database.prepare("SELECT COUNT(*) AS n FROM harness_models_search_docsize").get()).toEqual({ n: 0 });
    } finally {
      database.close();
    }
  });

  it("refuses a model with no scan, an unknown source, and a second row for one model", async () => {
    const database = await openCopy("command-center-v13.db");
    try {
      migrateStateSchema(database, planTo(23, STATE_SCHEMA_V23_SQL));
      seed(database);
      expect(() =>
        database
          .prepare("INSERT INTO harness_models(harness, model, provider, label, description, position) VALUES ('codex', 'gpt', NULL, 'gpt', NULL, 0)")
          .run(),
      ).toThrow();
      expect(() =>
        database
          .prepare("INSERT INTO harness_scans(harness, fingerprint, version, source, scanned_at) VALUES ('codex', 'x', NULL, 'guess', 1)")
          .run(),
      ).toThrow();
      expect(() =>
        database
          .prepare("INSERT INTO harness_models(harness, model, provider, label, description, position) VALUES ('pi', 'anthropic/claude-opus-5-5', NULL, 'again', NULL, 2)")
          .run(),
      ).toThrow();
      expect(() =>
        database
          .prepare("INSERT INTO harness_model_efforts(harness, model, effort, position) VALUES ('pi', 'not-listed', 'high', 0)")
          .run(),
      ).toThrow();
    } finally {
      database.close();
    }
  });
});
