/**
 * Step 61 adds the fleet consensus tables (0.11, 06 F6). Proven on both
 * shipped fixtures brought to version 60 by the real steps: the step's schema
 * hashes the same as the witness, every row already held survives as it was,
 * and every canvas starts at term 1 with nothing committed and its editor its
 * one authority, this machine where none is named.
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
  STATE_SCHEMA_V60_IDENTITY,
  STATE_SCHEMA_V61_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, readRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V60_SQL, STATE_SCHEMA_V61_SQL } from "./fixtures/state-v13/schema";

const FLEET_TABLES = ["canvas_authorities", "canvas_consensus", "canvas_log", "canvas_log_members", "canvas_log_waiting"];

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-fleet-consensus-migration-"));
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

const addCanvas = (database: DatabaseSync, name: string, editor: string | null) =>
  database
    .prepare("INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at, seq, editor_installation_id) VALUES (?, ?, 'now', 'now', 3, ?)")
    .run(name, `id-${name}`, editor);

describe("state migration 60 -> 61 (each canvas's authority by quorum commit)", () => {
  it("starts from the version-60 witness and ends at the version-61 one", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V60_SQL)).toEqual(STATE_SCHEMA_V60_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V61_SQL)).toEqual(STATE_SCHEMA_V61_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "adds the tables to %s, hashes as a fresh 61, seeds each canvas at term 1 with its editor, and leaves every row as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, upTo(60, STATE_SCHEMA_V60_SQL));
        addCanvas(database, "fleet-mini", "mini-installation");
        addCanvas(database, "fleet-here", null);
        const self = String((database.prepare("SELECT installation_id FROM installation WHERE singleton = 1").get() as { installation_id: SQLOutputValue }).installation_id);
        const canvases = rows(database, "canvases");
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));

        const result = migrateStateSchema(database, upTo(61, STATE_SCHEMA_V61_SQL));
        expect(result).toMatchObject({ previousVersion: 60, schemaVersion: 61, ...STATE_SCHEMA_V61_IDENTITY });
        expect(readRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V61_IDENTITY);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        const after = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        expect(Object.keys(after).filter((table) => !FLEET_TABLES.includes(table))).toEqual(Object.keys(before));
        for (const table of Object.keys(before)) expect(after[table], table).toEqual(before[table]);

        expect(after.canvas_consensus).toEqual(
          canvases.map(({ canvas_name }) => ({
            canvas_name,
            current_term: 1,
            voted_for: null,
            commit_index: 0,
            applied_index: 0,
            sole_installation_id: null,
            last_applied_at_epoch_ms: null,
          })),
        );
        expect(after.canvas_authorities).toEqual(
          canvases.map(({ canvas_name, editor_installation_id }) => ({ canvas_name, position: 0, installation_id: editor_installation_id ?? self })),
        );
        expect(after.canvas_authorities).toEqual(expect.arrayContaining([
          { canvas_name: "fleet-mini", position: 0, installation_id: "mini-installation" },
          { canvas_name: "fleet-here", position: 0, installation_id: self },
        ]));
        for (const table of ["canvas_log", "canvas_log_members", "canvas_log_waiting"]) expect(after[table], table).toEqual([]);
      } finally {
        database.close();
      }
    },
    60_000,
  );
});
