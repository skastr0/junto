/**
 * State migration 64 -> 65 keeps quick capture's Inbox (0.11.2, 11 Q4):
 * `view_capture_inboxes` is added, empty, and nothing else changes.
 *
 * The version-64 database is made at version 64 (a fresh database takes the
 * witness schema whole), not by replaying 13 -> 64 over a shipped fixture:
 * that replay alone runs several seconds and timed out under a loaded full
 * run. It lives in memory, so no path is shared with any other test. The step
 * is create-table only, so rows seeded before it stand in for what a shipped
 * database holds.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
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

describe("state migration 64 -> 65 (quick capture's Inbox)", () => {
  it("starts from the version-64 witness and ends at the head, which a fresh database matches", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V64_SQL)).toEqual(STATE_SCHEMA_V64_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V65_SQL)).toEqual(STATE_SCHEMA_V65_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(STATE_SCHEMA_V65_IDENTITY);
  });

  it("adds view_capture_inboxes, empty, keeps every row held, and changes nothing else", () => {
    const database = new DatabaseSync(":memory:", { allowExtension: false, enableForeignKeyConstraints: true });
    try {
      expect(migrateStateSchema(database, upTo(64, STATE_SCHEMA_V64_SQL))).toMatchObject({ schemaVersion: 64, ...STATE_SCHEMA_V64_IDENTITY });
      database.exec(`
        INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at) VALUES ('main', 'canvas-1', 'now', 'now');
        INSERT INTO artifact_boards (canvas_name, id, x, y, width, height, z_index, color, created_at, updated_at, label)
          VALUES ('main', 'shelf', 0, 0, 10, 10, 0, NULL, 'now', 'now', 'Shelf');
        INSERT INTO view_sections (section, open) VALUES ('artifact-comments', 1);
      `);
      const before = counts(database);
      const result = migrateStateSchema(database, upTo(65, STATE_SCHEMA_V65_SQL));
      expect(result).toMatchObject({ previousVersion: 64, schemaVersion: 65, ...STATE_SCHEMA_V65_IDENTITY });
      expect(readRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V65_IDENTITY);
      expect(counts(database)).toEqual({ ...before, view_capture_inboxes: 0 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
