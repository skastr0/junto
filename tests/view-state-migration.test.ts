/**
 * Step 55 adds the view-state tables (0.11, 04): how the operator arranged
 * Junto, machine-local. Proven on both shipped fixtures brought to version 54
 * by the real steps: the step's schema hashes the same as the witness, every
 * row already held survives as it was, and the new tables start empty.
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
  STATE_SCHEMA_V54_IDENTITY,
  STATE_SCHEMA_V55_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { expectedStateSchemaIdentity, readRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V54_SQL, STATE_SCHEMA_V55_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-view-state-migration-"));
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

const VIEW_TABLES = [
  "view_command_extras",
  "view_command_slot_members",
  "view_command_slots",
  "view_artifacts_filter_labels",
  "view_artifacts_filters",
  "view_collapsed_sidebars",
  "view_expanded_folders",
  "view_focus_sizes",
  "view_open_items",
  "view_sections",
  "view_tasks_filters",
] as const;

describe("state migration 54 -> 55 (the operator's view state)", () => {
  it("starts from the version-54 witness and ends at the head, which a fresh database matches", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V54_SQL)).toEqual(STATE_SCHEMA_V54_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V55_SQL)).toEqual(STATE_SCHEMA_V55_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(STATE_SCHEMA_V55_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(STATE_SCHEMA_V55_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "adds the empty view tables to %s, hashes as a fresh 55, and leaves every row as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, upTo(54, STATE_SCHEMA_V54_SQL));
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        for (const table of VIEW_TABLES) expect(Object.keys(before)).not.toContain(table);

        const result = migrateStateSchema(database, upTo(55, STATE_SCHEMA_SQL));
        expect(result).toMatchObject({ previousVersion: 54, schemaVersion: 55, ...STATE_SCHEMA_V55_IDENTITY });
        expect(readRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V55_IDENTITY);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        const after = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        expect(Object.keys(after).filter((table) => !(VIEW_TABLES as ReadonlyArray<string>).includes(table))).toEqual(
          Object.keys(before),
        );
        for (const table of VIEW_TABLES) expect(after[table], table).toEqual([]);
        for (const table of Object.keys(before)) expect(after[table], table).toEqual(before[table]);
      } finally {
        database.close();
      }
    },
    60_000,
  );

  it("holds a slot's kind and node together, a colour-free focus size, and a row per thing", async () => {
    const database = await openCopy("command-center-v13.db");
    try {
      migrateStateSchema(database, upTo(55, STATE_SCHEMA_SQL));
      database
        .prepare("INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at) VALUES ('main', 'c1', 'now', 'now')")
        .run();
      const slot = database.prepare("INSERT INTO view_command_slots (canvas_name, slot, kind, node_id) VALUES ('main', 0, ?, ?)");
      slot.run("fixed", "agent-1");
      expect(() => slot.run("fixed", null)).toThrow();
      expect(() => slot.run("group", "agent-1")).toThrow();
      expect(() => database.prepare("INSERT INTO view_focus_sizes (surface, width, height) VALUES ('Tasks', 0, 10)").run()).toThrow();
      expect(() => database.prepare("INSERT INTO view_focus_sizes (surface, width, height) VALUES ('Tasks', 10.5, 10)").run()).toThrow();
      database.prepare("INSERT INTO view_focus_sizes (surface, width, height) VALUES ('Tasks', 10, 20)").run();
      database.prepare("INSERT INTO view_sections (section, open) VALUES ('artifact-comments', 0)").run();
      expect(rows(database, "view_focus_sizes")).toEqual([{ surface: "Tasks", width: 10, height: 20 }]);
    } finally {
      database.close();
    }
  });
});
