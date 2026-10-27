/**
 * Step 51 adds `file_trees`, the Files node's table (0.11), and nothing else
 * moves. Proven on both fixtures brought to version 50 by the real steps: the
 * migrated schema hashes the same as a fresh database, so an upgraded one and
 * a new one are the same shape, and a files node round-trips through its row.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { nodeFromRow, nodeToRow } from "../src/main/junto/model/rows";
import { KIND_TABLES } from "../src/main/junto/model/state-schema";
import { migrateMachineNames } from "../src/main/junto/state/migrate-machine-names";
import {
  CURRENT_STATE_SCHEMA_IDENTITY,
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V50_IDENTITY,
  STATE_SCHEMA_V51_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { expectedStateSchemaIdentity, readRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { decodeNode } from "../src/shared/model/kinds";
import { Effect } from "effect";
import { STATE_SCHEMA_V50_SQL, STATE_SCHEMA_V51_SQL } from "./fixtures/state-v13/schema";
import { files } from "./support/model-nodes";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-files-migration-"));
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
  database
    .prepare("INSERT INTO canvases(canvas_name, canvas_id, created_at, updated_at, seq) VALUES ('main', 'c', 't', 't', 0)")
    .run();
  return "main";
};

describe("state migration 50 -> 51 (the files node)", () => {
  it("starts from the version-50 witness and ends at the head, which a fresh database matches", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V50_SQL)).toEqual(STATE_SCHEMA_V50_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V51_SQL)).toEqual(STATE_SCHEMA_V51_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(STATE_SCHEMA_V51_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(STATE_SCHEMA_V51_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "adds an empty file_trees to %s, hashes as a fresh 51, and leaves every row as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, upTo(50, STATE_SCHEMA_V50_SQL));
        canvasOf(database);
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        expect(Object.keys(before)).not.toContain("file_trees");

        const result = migrateStateSchema(database, upTo(51, STATE_SCHEMA_SQL));
        expect(result).toMatchObject({ previousVersion: 50, schemaVersion: 51, ...STATE_SCHEMA_V51_IDENTITY });
        expect(readRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V51_IDENTITY);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        const after = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        expect(Object.keys(after).filter((table) => table !== "file_trees")).toEqual(Object.keys(before));
        expect(after.file_trees).toEqual([]);
        for (const table of Object.keys(before)) expect(after[table], table).toEqual(before[table]);
      } finally {
        database.close();
      }
    },
    60_000,
  );

  it("holds a files node in its own table, and its row reads back as the same node", async () => {
    const database = await openCopy("command-center-v13.db");
    try {
      migrateStateSchema(database, upTo(51, STATE_SCHEMA_SQL));
      const canvas = canvasOf(database);
      const node = files("files-1", { label: "Junto", root: "/Users/me/Projects/junto" });
      const row = { ...(nodeToRow(canvas, node) as Record<string, unknown>), created_at: "t", updated_at: "t" };
      const columns = Object.keys(row);
      database
        .prepare(`INSERT INTO ${KIND_TABLES.files}(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
        .run(...(Object.values(row) as never[]));
      const stored = database.prepare(`SELECT * FROM ${KIND_TABLES.files} WHERE id = 'files-1'`).get() as never;
      const read = nodeFromRow("files", stored);
      expect(read).toEqual(node);
      expect(Effect.runSync(decodeNode(read))).toEqual(node);

      const bare = nodeFromRow("files", nodeToRow(canvas, files("files-2")) as never);
      expect(bare).not.toHaveProperty("label");
    } finally {
      database.close();
    }
  });
});
