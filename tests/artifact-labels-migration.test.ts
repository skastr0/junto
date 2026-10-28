/**
 * Step 53 adds `artifact_labels`, one row per label an artifact's head carries
 * (0.11, 03), and nothing else moves. Proven on both shipped fixtures brought
 * to version 52 by the real steps: the step's schema hashes the same as the
 * witness, every row already held survives as it was, and a head written
 * before the step reads as no labels.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURRENT_STATE_SCHEMA_IDENTITY,
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V52_IDENTITY,
  STATE_SCHEMA_V53_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { expectedStateSchemaIdentity, readRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V52_SQL, STATE_SCHEMA_V53_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-artifact-labels-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fileURLToPath(new URL(`./fixtures/state-v13/${fixture}`, import.meta.url)), path);
  const database = new DatabaseSync(path, { open: true, readOnly: false, allowExtension: false, enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
};

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

const canvasOf = (database: DatabaseSync): string => {
  const canvas = database.prepare("SELECT canvas_name FROM canvases ORDER BY canvas_name LIMIT 1").get();
  if (canvas) return String(canvas.canvas_name);
  database.prepare("INSERT INTO canvases(canvas_name, canvas_id, created_at, updated_at, seq) VALUES ('main', 'c', 't', 't', 0)").run();
  return "main";
};

describe("state migration 52 -> 53 (the artifact labels)", () => {
  it("starts from the version-52 witness and ends at the head, which a fresh database matches", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V52_SQL)).toEqual(STATE_SCHEMA_V52_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V53_SQL)).toEqual(STATE_SCHEMA_V53_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(STATE_SCHEMA_V53_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(STATE_SCHEMA_V53_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "adds an empty artifact_labels to %s, hashes as a fresh 53, and leaves every row as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, upTo(52, STATE_SCHEMA_V52_SQL));
        canvasOf(database);
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        expect(Object.keys(before)).not.toContain("artifact_labels");

        const result = migrateStateSchema(database, upTo(53, STATE_SCHEMA_SQL));
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
    60_000,
  );

  it("keeps a head's label rows only while the head exists, and a head from before reads as none", async () => {
    const database = await openCopy("command-center-v13.db");
    try {
      migrateStateSchema(database, upTo(53, STATE_SCHEMA_SQL));
      const canvas = canvasOf(database);
      const artifact = "01M5EVKRB1X4P80GXRGDK8V5AS";
      database
        .prepare(
          `INSERT INTO artifact_heads (canvas_name, artifact_id, node_id, type, title, version, created_by_json, updated_at, archived, task_ids_json)
           VALUES (?, ?, 'artifacts-1', 'document', 'Plan', 1, '{"kind":"operator"}', 1, 0, '[]')`,
        )
        .run(canvas, artifact);
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
