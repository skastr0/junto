/**
 * State migration 68 -> 69 keeps quick capture's desk (0.12, the Cmd+T
 * triage desk): `view_capture_desks` is added, empty, and nothing else
 * changes.
 *
 * The version-68 database is made at version 68 (a fresh database takes the
 * witness schema whole), not by replaying 13 -> 68 over a shipped fixture,
 * as the Inbox step's test does. The step is create-table only, so rows
 * seeded before it stand in for what a shipped database holds.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V68_IDENTITY,
  STATE_SCHEMA_V69_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { VIEW_CAPTURE_DESK_SCHEMA_SQL } from "../src/main/junto/view-state/state-schema";
import { expectedStateSchemaIdentity, readRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V68_SQL, STATE_SCHEMA_V69_SQL } from "./fixtures/state-v13/schema";

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

describe("state migration 68 -> 69 (quick capture's desk)", () => {
  it("starts from the version-68 witness and ends at the version-69 witness", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V68_SQL)).toEqual(STATE_SCHEMA_V68_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V69_SQL)).toEqual(STATE_SCHEMA_V69_IDENTITY);
  });

  it("is in the production DDL a fresh database is made from", () => {
    expect(STATE_SCHEMA_SQL).toContain(VIEW_CAPTURE_DESK_SCHEMA_SQL);
  });

  it("adds view_capture_desks, empty, keeps every row held, and changes nothing else", () => {
    const database = new DatabaseSync(":memory:", { allowExtension: false, enableForeignKeyConstraints: true });
    try {
      expect(migrateStateSchema(database, upTo(68, STATE_SCHEMA_V68_SQL))).toMatchObject({ schemaVersion: 68, ...STATE_SCHEMA_V68_IDENTITY });
      database.exec(`
        INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at) VALUES ('main', 'canvas-1', 'now', 'now');
        INSERT INTO artifact_boards (canvas_name, id, x, y, width, height, z_index, color, created_at, updated_at, label)
          VALUES ('main', 'shelf', 0, 0, 10, 10, 0, NULL, 'now', 'now', 'Shelf');
        INSERT INTO view_capture_inboxes (canvas_name, node_id) VALUES ('main', 'shelf');
      `);
      const before = counts(database);
      const result = migrateStateSchema(database, upTo(69, STATE_SCHEMA_V69_SQL));
      expect(result).toMatchObject({ previousVersion: 68, schemaVersion: 69, ...STATE_SCHEMA_V69_IDENTITY });
      expect(readRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V69_IDENTITY);
      expect(counts(database)).toEqual({ ...before, view_capture_desks: 0 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("refuses a draft longer than a document may be, and a row for a canvas that is not held", () => {
    const database = new DatabaseSync(":memory:", { allowExtension: false, enableForeignKeyConstraints: true });
    try {
      migrateStateSchema(database, upTo(69, STATE_SCHEMA_V69_SQL));
      database.exec("INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at) VALUES ('main', 'canvas-1', 'now', 'now')");
      const insert = database.prepare("INSERT INTO view_capture_desks (canvas_name, draft_text) VALUES (?, ?)");
      expect(() => insert.run("main", "x".repeat(512_001))).toThrow();
      expect(() => insert.run("elsewhere", "words")).toThrow();
      insert.run("main", "x".repeat(512_000));
    } finally {
      database.close();
    }
  });
});
