/**
 * Step 50 rebuilds `wires` with `derives` in its verb CHECK, copying every
 * wire as it was, and adds `derived_from` to `task_heads`, null on every task
 * already held. Proven on both fixtures brought to version 49 by the real
 * steps, seeded with a wire and a task: the migrated schema hashes the same as
 * a fresh 50, every kept row is unchanged, and a derives wire and a derived
 * task can then be stored.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateMachineNames } from "../src/main/junto/state/migrate-machine-names";
import {
  CURRENT_STATE_SCHEMA_IDENTITY,
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V49_IDENTITY,
  STATE_SCHEMA_V50_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { expectedStateSchemaIdentity, readRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V49_SQL, STATE_SCHEMA_V50_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-derives-verb-migration-"));
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

const ORIGIN = "01M5YC0000000000000000000A";
const DERIVED = "01M5YC0000000000000000000B";

const canvasOf = (database: DatabaseSync): string => {
  const canvas = database.prepare("SELECT canvas_name FROM canvases ORDER BY canvas_name LIMIT 1").get();
  if (canvas) return String(canvas.canvas_name);
  database.prepare("INSERT INTO canvases(canvas_name, canvas_id, created_at, updated_at, seq) VALUES ('main', 'c', 't', 't', 0)").run();
  return "main";
};

/** Two flowing boards and one task, held before the step. */
const seed = (database: DatabaseSync, canvas: string): void => {
  database
    .prepare("INSERT INTO wires(canvas_name, id, from_id, to_id, verb, created_at, updated_at) VALUES (?, 'wire-flows', 'task-a', 'task-b', 'flows', 't', 't')")
    .run(canvas);
  database
    .prepare(
      `INSERT INTO task_heads(canvas_name, task_id, number, node_id, title, state, epoch, stamps_required,
         reviewers_json, checks_json, depends_on_json, created_at, updated_at, state_since)
       VALUES (?, ?, 9001, 'task-a', 'origin', 'done', 0, 0, '[]', '[]', '[]', 1, 2, 2)`,
    )
    .run(canvas, ORIGIN);
};

describe("state migration 49 -> 50 (a task board derives into another)", () => {
  it("starts from the version-49 witness and ends at the head, which a fresh database matches", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V49_SQL)).toEqual(STATE_SCHEMA_V49_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V50_SQL)).toEqual(STATE_SCHEMA_V50_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(STATE_SCHEMA_V50_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(STATE_SCHEMA_V50_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "copies every wire, adds an empty derived_from to every task in %s, hashes as a fresh 50, and leaves the rest as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, upTo(49, STATE_SCHEMA_V49_SQL));
        const canvas = canvasOf(database);
        seed(database, canvas);
        // A derives wire is refused before the step.
        expect(() =>
          database
            .prepare("INSERT INTO wires(canvas_name, id, from_id, to_id, verb, created_at, updated_at) VALUES (?, 'early', 'task-a', 'task-c', 'derives', 't', 't')")
            .run(canvas),
        ).toThrow(/CHECK/);
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));

        const result = migrateStateSchema(database, upTo(50, STATE_SCHEMA_SQL));
        expect(result).toMatchObject({ previousVersion: 49, schemaVersion: 50, ...STATE_SCHEMA_V50_IDENTITY });
        expect(readRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V50_IDENTITY);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        const after = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        expect(Object.keys(after)).toEqual(Object.keys(before));
        for (const table of Object.keys(before)) {
          const expected = table === "task_heads" ? before[table]!.map((row) => ({ ...row, derived_from: null })) : before[table];
          expect(after[table], table).toEqual(expected);
        }
        expect(before.wires!.length).toBeGreaterThan(0);

        database
          .prepare("INSERT INTO wires(canvas_name, id, from_id, to_id, verb, created_at, updated_at) VALUES (?, 'wire-derives', 'task-a', 'task-c', 'derives', 't', 't')")
          .run(canvas);
        database
          .prepare(
            `INSERT INTO task_heads(canvas_name, task_id, number, node_id, title, state, epoch, stamps_required,
               reviewers_json, checks_json, depends_on_json, created_at, updated_at, state_since, derived_from)
             VALUES (?, ?, 9002, 'task-c', 'origin', 'backlog', 0, 0, '[]', '[]', '[]', 3, 3, 3, ?)`,
          )
          .run(canvas, DERIVED, ORIGIN);
        expect(
          database.prepare("SELECT task_id FROM task_heads WHERE canvas_name = ? AND derived_from = ?").all(canvas, ORIGIN),
        ).toEqual([{ task_id: DERIVED }]);
      } finally {
        database.close();
      }
    },
    60_000,
  );
});
