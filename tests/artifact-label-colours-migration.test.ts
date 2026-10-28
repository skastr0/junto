/**
 * Step 54 adds `artifact_label_colours`, one row per (Artifacts node, label)
 * with a colour (0.11, 03 Colours), and nothing else moves. Proven on both
 * shipped fixtures brought to version 53 by the real steps: the step's schema
 * hashes the same as the witness, every row already held survives as it was,
 * and the table takes only the eight names.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
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

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-artifact-label-colours-migration-"));
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

describe("state migration 53 -> 54 (the artifact label colours)", () => {
  it("starts from the version-53 witness and ends at the head, which a fresh database matches", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V53_SQL)).toEqual(STATE_SCHEMA_V53_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V54_SQL)).toEqual(STATE_SCHEMA_V54_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "adds an empty artifact_label_colours to %s, hashes as a fresh 54, and leaves every row as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, upTo(53, STATE_SCHEMA_V53_SQL));
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        expect(Object.keys(before)).not.toContain("artifact_label_colours");

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
    60_000,
  );

  it("holds one colour per node and label, by name only, with no artifact behind it", async () => {
    const database = await openCopy("command-center-v13.db");
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
