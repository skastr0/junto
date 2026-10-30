/**
 * State migration 66 -> 67 keeps each structure entry's change (0.12, 06 F4):
 * `canvas_log_structure` and `canvas_log_waiting_structure` are added, empty,
 * and nothing else changes.
 *
 * The version-66 database is made at version 66 (a fresh database takes the
 * witness schema whole), not by replaying 13 -> 66 over a shipped fixture. It
 * lives in memory, so no path is shared with any other test. The step is
 * create-table only, so rows seeded before it stand in for what a shipped
 * database holds.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V66_IDENTITY,
  STATE_SCHEMA_V67_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { expectedStateSchemaIdentity, readRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V66_SQL, STATE_SCHEMA_V67_SQL } from "./fixtures/state-v13/schema";

const upTo = (version: number, currentSchemaSql: string): StateSchemaMigrationPlan => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version),
});

const tables = (database: DatabaseSync): ReadonlyArray<string> =>
  (database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as unknown as ReadonlyArray<{ name: string }>).map(
    (row) => row.name,
  );

const counts = (database: DatabaseSync): Readonly<Record<string, number>> =>
  Object.fromEntries(tables(database).map((name) => [name, Number((database.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n)]));

describe("state migration 66 -> 67 (each structure entry's change)", () => {
  it("starts from the version-66 witness and ends at the head, which a fresh database matches", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V66_SQL)).toEqual(STATE_SCHEMA_V66_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V67_SQL)).toEqual(STATE_SCHEMA_V67_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(STATE_SCHEMA_V67_IDENTITY);
    expect(STATE_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS canvas_log_structure");
    expect(STATE_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS canvas_log_waiting_structure");
  });

  it("adds both tables, empty, keeps every row held, and changes nothing else", () => {
    const database = new DatabaseSync(":memory:", { allowExtension: false, enableForeignKeyConstraints: true });
    try {
      expect(migrateStateSchema(database, upTo(66, STATE_SCHEMA_V66_SQL))).toMatchObject({ schemaVersion: 66, ...STATE_SCHEMA_V66_IDENTITY });
      database.exec(`
        INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at) VALUES ('main', 'canvas-1', 'now', 'now');
        INSERT INTO canvas_consensus (canvas_name, current_term, voted_for, commit_index, applied_index) VALUES ('main', 1, NULL, 1, 1);
        INSERT INTO canvas_log (canvas_name, log_index, term, kind) VALUES ('main', 1, 1, 'list');
        INSERT INTO canvas_log (canvas_name, log_index, term, kind, structure_seq) VALUES ('main', 2, 1, 'structure.changed', 4);
      `);
      const before = counts(database);
      const result = migrateStateSchema(database, upTo(67, STATE_SCHEMA_V67_SQL));
      expect(result).toMatchObject({ previousVersion: 66, schemaVersion: 67, ...STATE_SCHEMA_V67_IDENTITY });
      expect(readRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V67_IDENTITY);
      expect(counts(database)).toEqual({ ...before, canvas_log_structure: 0, canvas_log_waiting_structure: 0 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("a change goes with its entry, and names one that exists", () => {
    const database = new DatabaseSync(":memory:", { allowExtension: false, enableForeignKeyConstraints: true });
    try {
      migrateStateSchema(database, upTo(67, STATE_SCHEMA_V67_SQL));
      database.exec(`
        INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at) VALUES ('main', 'canvas-1', 'now', 'now');
        INSERT INTO canvas_consensus (canvas_name, current_term, voted_for, commit_index, applied_index) VALUES ('main', 1, NULL, 0, 0);
        INSERT INTO canvas_log (canvas_name, log_index, term, kind, structure_seq) VALUES ('main', 2, 1, 'structure.changed', 4);
        INSERT INTO canvas_log_structure (canvas_name, log_index, change_json) VALUES ('main', 2, '{"nodes":[]}');
      `);
      expect(() => database.exec(`INSERT INTO canvas_log_structure (canvas_name, log_index, change_json) VALUES ('main', 3, '{}')`)).toThrow(/FOREIGN KEY/);
      expect(() => database.exec(`INSERT INTO canvas_log_structure (canvas_name, log_index, change_json) VALUES ('main', 2, 'not json')`)).toThrow();
      database.exec("DELETE FROM canvas_log WHERE canvas_name = 'main' AND log_index >= 2");
      expect(counts(database).canvas_log_structure).toBe(0);
    } finally {
      database.close();
    }
  });
});
