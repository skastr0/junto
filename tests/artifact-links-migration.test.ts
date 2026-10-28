/**
 * Step 52 adds `work_artifact_links`, the artifact body backlinks (0.11), and
 * nothing else moves. Proven on both shipped fixtures brought to version 51
 * by the real steps: the step's schema hashes the same as the witness, every
 * row already held survives as it was, and the new table starts empty — a
 * body's links project from its next edit, and the rebuild from bodies
 * projects the rest.
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
  STATE_SCHEMA_V51_IDENTITY,
  STATE_SCHEMA_V52_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, readRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V51_SQL, STATE_SCHEMA_V52_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-artifact-links-migration-"));
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

const named = <T extends { readonly toVersion: number; readonly migrate: (database: DatabaseSync) => void }>(step: T): T =>
  step.toVersion === 21 ? { ...step, migrate: (database: DatabaseSync) => migrateMachineNames(database, "macbook") } : step;

const upTo = (version: number, currentSchemaSql: string): StateSchemaMigrationPlan => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version).map(named),
});

const canvasOf = (database: DatabaseSync): string => {
  const canvas = database.prepare("SELECT canvas_name FROM canvases ORDER BY canvas_name LIMIT 1").get();
  if (canvas) return String(canvas.canvas_name);
  database.prepare("INSERT INTO canvases(canvas_name, canvas_id, created_at, updated_at, seq) VALUES ('main', 'c', 't', 't', 0)").run();
  return "main";
};

describe("state migration 51 -> 52 (the artifact body links)", () => {
  it("starts from the version-51 witness and ends at the head, which a fresh database matches", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V51_SQL)).toEqual(STATE_SCHEMA_V51_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V52_SQL)).toEqual(STATE_SCHEMA_V52_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "adds an empty work_artifact_links to %s, hashes as a fresh 52, and leaves every row as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, upTo(51, STATE_SCHEMA_V51_SQL));
        canvasOf(database);
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        expect(Object.keys(before)).not.toContain("work_artifact_links");

        const result = migrateStateSchema(database, upTo(52, STATE_SCHEMA_V52_SQL));
        expect(result).toMatchObject({ previousVersion: 51, schemaVersion: 52, ...STATE_SCHEMA_V52_IDENTITY });
        expect(readRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V52_IDENTITY);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        const after = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        expect(Object.keys(after).filter((table) => table !== "work_artifact_links")).toEqual(Object.keys(before));
        expect(after.work_artifact_links).toEqual([]);
        for (const table of Object.keys(before)) expect(after[table], table).toEqual(before[table]);
      } finally {
        database.close();
      }
    },
    60_000,
  );

  it("keeps a link row only while its source artifact exists", async () => {
    const database = await openCopy("command-center-v13.db");
    try {
      migrateStateSchema(database, upTo(52, STATE_SCHEMA_V52_SQL));
      const canvas = canvasOf(database);
      const insert = (artifact: string, target: string) =>
        database
          .prepare(
            `INSERT INTO work_artifact_links (canvas_name, source_artifact_id, target_node_id, target_artifact_id, line, source_version)
             VALUES (?, ?, 'artifacts-1', ?, 'a line', 1)`,
          )
          .run(canvas, artifact, target);
      database
        .prepare(
          `INSERT INTO artifact_heads (canvas_name, artifact_id, node_id, type, title, version, created_by_json, updated_at, archived, task_ids_json)
           VALUES (?, ?, 'artifacts-1', 'document', 'Plan', 1, '{"kind":"operator"}', 1, 0, '[]')`,
        )
        .run(canvas, "01M5EVKRB1X4P80GXRGDK8V5AS");
      insert("01M5EVKRB1X4P80GXRGDK8V5AS", "01M5EVKRB1X4P80GXRGDK8V5AT");
      expect(rows(database, "work_artifact_links")).toHaveLength(1);
      // A target that is gone is no row: the table's own key covers source and
      // target, and the head's delete takes its links with it.
      database.prepare("DELETE FROM artifact_heads WHERE canvas_name = ? AND artifact_id = ?").run(canvas, "01M5EVKRB1X4P80GXRGDK8V5AS");
      expect(rows(database, "work_artifact_links")).toEqual([]);
    } finally {
      database.close();
    }
  });
});
