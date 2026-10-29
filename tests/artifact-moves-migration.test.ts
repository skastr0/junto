/**
 * State migration 63 -> 64 keeps where each artifact has been (0.11.1, 10 M1):
 * `artifact_moves` is added, empty, and nothing else changes.
 *
 * The version-63 database is made at version 63 (a fresh database takes the
 * witness schema whole), not by replaying 13 -> 63 over a shipped fixture:
 * that replay alone runs several seconds and timed out under a loaded run.
 * It lives in memory, so no path is shared with any other test. The step is
 * create-table only, so rows seeded before it stand in for what a shipped
 * database holds.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
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

describe("state migration 63 -> 64 (where each artifact has been)", () => {
  it("starts from the version-63 witness and ends at the version-64 one, which the head's schema carries forward", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V63_SQL)).toEqual(STATE_SCHEMA_V63_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V64_SQL)).toEqual(STATE_SCHEMA_V64_IDENTITY);
    expect(STATE_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS artifact_moves");
  });

  it("adds artifact_moves, empty, keeps every row held, and changes nothing else", () => {
    const database = new DatabaseSync(":memory:", { allowExtension: false, enableForeignKeyConstraints: true });
    try {
      expect(migrateStateSchema(database, upTo(63, STATE_SCHEMA_V63_SQL))).toMatchObject({ schemaVersion: 63, ...STATE_SCHEMA_V63_IDENTITY });
      database.exec(`
        INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at) VALUES ('main', 'canvas-1', 'now', 'now');
        INSERT INTO artifact_boards (canvas_name, id, x, y, width, height, z_index, color, created_at, updated_at, label)
          VALUES ('main', 'shelf', 0, 0, 10, 10, 0, NULL, 'now', 'now', 'Shelf');
        INSERT INTO artifact_label_colours (canvas_name, node_id, label, colour) VALUES ('main', 'shelf', 'design', 'teal');
      `);
      const before = counts(database);
      const result = migrateStateSchema(database, upTo(64, STATE_SCHEMA_V64_SQL));
      expect(result).toMatchObject({ previousVersion: 63, schemaVersion: 64, ...STATE_SCHEMA_V64_IDENTITY });
      expect(readRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V64_IDENTITY);
      expect(counts(database)).toEqual({ ...before, artifact_moves: 0 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
