/**
 * Step 50 rebuilds `wires` with `derives` in its verb CHECK, copying every
 * wire as it was, and adds `derived_from` to `task_heads`, null on every task
 * already held. Seeded with a wire and a task: the migrated schema hashes the
 * same as a fresh 50, every kept row is unchanged, and a derives wire and a
 * derived task can then be stored.
 *
 * The version-49 database is made at version 49 (a fresh database takes the
 * witness schema whole), not by replaying 13 -> 49 over a shipped fixture:
 * that replay ran seconds under a loaded full run. It lives in memory, so no
 * path is shared with any other test, and rows seeded before the step stand in
 * for what a shipped database holds.
 */
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V49_IDENTITY,
  STATE_SCHEMA_V50_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, readRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V49_SQL, STATE_SCHEMA_V50_SQL } from "./fixtures/state-v13/schema";

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

/** A version-49 database, fresh and in memory. */
const openAt49 = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:", { allowExtension: false, enableForeignKeyConstraints: true });
  expect(migrateStateSchema(database, upTo(49, STATE_SCHEMA_V49_SQL))).toMatchObject({ schemaVersion: 49, ...STATE_SCHEMA_V49_IDENTITY });
  return database;
};

const ORIGIN = "01M5YC0000000000000000000A";
const DERIVED = "01M5YC0000000000000000000B";

/** A canvas, two flowing boards and one task, held before the step. */
const seed = (database: DatabaseSync, canvas: string): void => {
  database.prepare("INSERT INTO canvases(canvas_name, canvas_id, created_at, updated_at, seq) VALUES (?, 'c', 't', 't', 0)").run(canvas);
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
  it("starts from the version-49 witness and ends at the version-50 one", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V49_SQL)).toEqual(STATE_SCHEMA_V49_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V50_SQL)).toEqual(STATE_SCHEMA_V50_IDENTITY);
  });

  it(
    "copies every wire, adds an empty derived_from to every task, hashes as a fresh 50, and leaves the rest as it was",
    () => {
      const database = openAt49();
      try {
        const canvas = "main";
        seed(database, canvas);
        // A derives wire is refused before the step.
        expect(() =>
          database
            .prepare("INSERT INTO wires(canvas_name, id, from_id, to_id, verb, created_at, updated_at) VALUES (?, 'early', 'task-a', 'task-c', 'derives', 't', 't')")
            .run(canvas),
        ).toThrow(/CHECK/);
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));

        const result = migrateStateSchema(database, upTo(50, STATE_SCHEMA_V50_SQL));
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
        expect(before.task_heads!.length).toBeGreaterThan(0);

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
  );
});
