/**
 * Step 53 adds `artifact_labels`, one row per label an artifact's head carries
 * (0.11, 03), and nothing else moves: the step's schema hashes the same as
 * the witness, every row already held survives as it was, and a head written
 * before the step reads as no labels.
 *
 * The version-52 database is made at version 52 (a fresh database takes the
 * witness schema whole), not by replaying 13 -> 52 over a shipped fixture:
 * that replay ran seconds under a loaded full run. It lives in memory, so no
 * path is shared with any other test. The step is create-table only, so rows
 * seeded before it stand in for what a shipped database holds.
 */
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V52_IDENTITY,
  STATE_SCHEMA_V53_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, readRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V52_SQL, STATE_SCHEMA_V53_SQL } from "./fixtures/state-v13/schema";

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

const CANVAS = "main";
const ARTIFACT = "01M5EVKRB1X4P80GXRGDK8V5AS";

/** A version-52 database, fresh and in memory, holding a canvas, an Artifacts board and one artifact head. */
const openAt52 = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:", { allowExtension: false, enableForeignKeyConstraints: true });
  expect(migrateStateSchema(database, upTo(52, STATE_SCHEMA_V52_SQL))).toMatchObject({ schemaVersion: 52, ...STATE_SCHEMA_V52_IDENTITY });
  database.prepare("INSERT INTO canvases(canvas_name, canvas_id, created_at, updated_at, seq) VALUES (?, 'c', 't', 't', 0)").run(CANVAS);
  database
    .prepare(
      `INSERT INTO artifact_boards (canvas_name, id, x, y, width, height, z_index, color, created_at, updated_at, label)
       VALUES (?, 'artifacts-1', 0, 0, 10, 10, 0, NULL, 't', 't', 'Shelf')`,
    )
    .run(CANVAS);
  database
    .prepare(
      `INSERT INTO artifact_heads (canvas_name, artifact_id, node_id, type, title, version, created_by_json, updated_at, archived, task_ids_json)
       VALUES (?, ?, 'artifacts-1', 'document', 'Plan', 1, '{"kind":"operator"}', 1, 0, '[]')`,
    )
    .run(CANVAS, ARTIFACT);
  return database;
};

describe("state migration 52 -> 53 (the artifact labels)", () => {
  it("starts from the version-52 witness and ends at the version-53 witness", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V52_SQL)).toEqual(STATE_SCHEMA_V52_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V53_SQL)).toEqual(STATE_SCHEMA_V53_IDENTITY);
  });

  it(
    "adds an empty artifact_labels, hashes as a fresh 53, and leaves every row as it was",
    () => {
      const database = openAt52();
      try {
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        expect(Object.keys(before)).not.toContain("artifact_labels");
        expect(before.artifact_heads).toHaveLength(1);

        const result = migrateStateSchema(database, upTo(53, STATE_SCHEMA_V53_SQL));
        expect(result).toMatchObject({ previousVersion: 52, schemaVersion: 53, ...STATE_SCHEMA_V53_IDENTITY });
        expect(readRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V53_IDENTITY);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        const after = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        expect(Object.keys(after).filter((table) => table !== "artifact_labels")).toEqual(Object.keys(before));
        expect(after.artifact_labels).toEqual([]);
        for (const table of Object.keys(before)) expect(after[table], table).toEqual(before[table]);
      } finally {
        database.close();
      }
    },
  );

  it("keeps a head's label rows only while the head exists, and a head from before reads as none", () => {
    const database = openAt52();
    try {
      migrateStateSchema(database, upTo(53, STATE_SCHEMA_V53_SQL));
      const canvas = CANVAS;
      const artifact = ARTIFACT;
      // A head written before the step has no rows here: it reads as no labels.
      expect(database.prepare("SELECT label FROM artifact_labels WHERE artifact_id = ?").all(artifact)).toEqual([]);

      const insert = (label: string) =>
        database
          .prepare("INSERT INTO artifact_labels (canvas_name, artifact_id, label) VALUES (?, ?, ?)")
          .run(canvas, artifact, label);
      insert("docs");
      insert("project/junto");
      expect(rows(database, "artifact_labels")).toHaveLength(2);
      // The same label twice is the same row.
      expect(() => insert("docs")).toThrow();

      database.prepare("DELETE FROM artifact_heads WHERE canvas_name = ? AND artifact_id = ?").run(canvas, artifact);
      expect(rows(database, "artifact_labels")).toEqual([]);
    } finally {
      database.close();
    }
  });
});
