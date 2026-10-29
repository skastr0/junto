/**
 * Step 54 adds `artifact_label_colours`, one row per (Artifacts node, label)
 * with a colour (0.11, 03 Colours), and nothing else moves: the step's schema
 * hashes the same as the witness, every row already held survives as it was,
 * and the table takes only the eight names.
 *
 * The version-53 database is made at version 53 (a fresh database takes the
 * witness schema whole), not by replaying 13 -> 53 over a shipped fixture:
 * that replay ran seconds under a loaded full run. It lives in memory, so no
 * path is shared with any other test. The step is create-table only, so rows
 * seeded before it stand in for what a shipped database holds.
 */
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V53_IDENTITY,
  STATE_SCHEMA_V54_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, readRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V53_SQL, STATE_SCHEMA_V54_SQL } from "./fixtures/state-v13/schema";

const tables = (database: DatabaseSync): ReadonlyArray<string> =>
  (
    database
      .prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'state_schema_identity'
          ORDER BY name`,
      )
      .all() as unknown as ReadonlyArray<{ readonly name: SQLOutputValue }>
  ).map(({ name }) => String(name));

const rows = (database: DatabaseSync, table: string) =>
  database.prepare(`SELECT * FROM "${table}" ORDER BY 1, 2`).all() as unknown as ReadonlyArray<Record<string, unknown>>;

const upTo = (version: number, currentSchemaSql: string): StateSchemaMigrationPlan => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version),
});

/** A version-53 database, fresh and in memory. */
const openAt53 = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:", { allowExtension: false, enableForeignKeyConstraints: true });
  expect(migrateStateSchema(database, upTo(53, STATE_SCHEMA_V53_SQL))).toMatchObject({ schemaVersion: 53, ...STATE_SCHEMA_V53_IDENTITY });
  return database;
};

describe("state migration 53 -> 54 (the artifact label colours)", () => {
  it("starts from the version-53 witness and ends at the head, which a fresh database matches", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V53_SQL)).toEqual(STATE_SCHEMA_V53_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V54_SQL)).toEqual(STATE_SCHEMA_V54_IDENTITY);
  });

  it(
    "adds an empty artifact_label_colours, hashes as a fresh 54, and leaves every row as it was",
    () => {
      const database = openAt53();
      try {
        database.exec(`
          INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at) VALUES ('main', 'canvas-1', 'now', 'now');
          INSERT INTO artifact_boards (canvas_name, id, x, y, width, height, z_index, color, created_at, updated_at, label)
            VALUES ('main', 'artifacts-1', 0, 0, 10, 10, 0, NULL, 'now', 'now', 'Shelf');
        `);
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        expect(Object.keys(before)).not.toContain("artifact_label_colours");
        expect(before.canvases).toHaveLength(1);
        expect(before.artifact_boards).toHaveLength(1);

        const result = migrateStateSchema(database, upTo(54, STATE_SCHEMA_V54_SQL));
        expect(result).toMatchObject({ previousVersion: 53, schemaVersion: 54, ...STATE_SCHEMA_V54_IDENTITY });
        expect(readRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V54_IDENTITY);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        const after = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        expect(Object.keys(after).filter((table) => table !== "artifact_label_colours")).toEqual(Object.keys(before));
        expect(after.artifact_label_colours).toEqual([]);
        for (const table of Object.keys(before)) expect(after[table], table).toEqual(before[table]);
      } finally {
        database.close();
      }
    },
  );

  it("holds one colour per node and label, by name only, with no artifact behind it", () => {
    const database = openAt53();
    try {
      migrateStateSchema(database, upTo(54, STATE_SCHEMA_V54_SQL));
      const insert = (node: string, label: string, colour: string) =>
        database
          .prepare("INSERT INTO artifact_label_colours (canvas_name, node_id, label, colour) VALUES ('main', ?, ?, ?)")
          .run(node, label, colour);
      insert("artifacts-1", "docs", "teal");
      insert("artifacts-2", "docs", "red");
      insert("artifacts-1", "project/junto", "pink");
      expect(rows(database, "artifact_label_colours")).toHaveLength(3);
      // One colour per (node, label), and a colour is one of the eight names.
      expect(() => insert("artifacts-1", "docs", "blue")).toThrow();
      expect(() => insert("artifacts-1", "spare", "#00ffff")).toThrow();
      expect(() => insert("artifacts-1", "spare", "grey")).toThrow();
    } finally {
      database.close();
    }
  });
});
