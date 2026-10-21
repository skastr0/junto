/**
 * State migration 35 -> 36 rebuilds `task_heads` with `state_since`
 * (consolidate). Proven on both shipped fixtures brought to version 35 by the
 * real steps: every row comes through with its columns as they were, every
 * other table is untouched, and each task's state began at its last stored
 * transition, within its own created and updated times.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateMachineNames } from "../src/main/junto/state/migrate-machine-names";
import { TASK_TABLES_V31_SQL } from "../src/main/junto/state/migrate-task-model";
import { migrateTaskStateSince } from "../src/main/junto/state/migrate-task-state-since";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V35_IDENTITY,
  STATE_SCHEMA_V36_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V35_SQL, STATE_SCHEMA_V36_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-task-state-since-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fileURLToPath(new URL(`./fixtures/state-v13/${fixture}`, import.meta.url)), path);
  const database = new DatabaseSync(path, { open: true, readOnly: false, allowExtension: false, enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
};

const snapshot = (database: DatabaseSync) =>
  Object.fromEntries(
    (
      database
        .prepare(
          `SELECT name FROM sqlite_schema
            WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'state_schema_identity'
            ORDER BY name`,
        )
        .all() as unknown as ReadonlyArray<{ readonly name: SQLOutputValue }>
    ).map(({ name }) => [String(name), database.prepare(`SELECT * FROM "${String(name)}" ORDER BY 1, 2`).all()]),
  );

/** The real steps, with the name first boot would give fixed so the proof does not depend on where it runs. */
const named = <T extends { readonly toVersion: number; readonly migrate: (database: DatabaseSync) => void }>(step: T): T =>
  step.toVersion === 21 ? { ...step, migrate: (database: DatabaseSync) => migrateMachineNames(database, "macbook") } : step;

const planTo = (version: number, currentSchemaSql: string) => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version).map(named),
});

describe("state migration 35 -> 36 (task state since)", () => {
  it("freezes the witnesses the step starts from and ends at", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V35_SQL)).toEqual(STATE_SCHEMA_V35_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V36_SQL)).toEqual(STATE_SCHEMA_V36_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "carries every task of %s over with when its state began, and leaves every other row as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, planTo(35, STATE_SCHEMA_V35_SQL));
        const before = snapshot(database);

        const result = migrateStateSchema(database, planTo(36, STATE_SCHEMA_V36_SQL));
        expect(result).toMatchObject({ previousVersion: 35, schemaVersion: 36 });
        expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V36_IDENTITY);

        const { task_heads: heads, ...rest } = snapshot(database);
        const { task_heads: headsBefore, ...restBefore } = before;
        expect(rest).toEqual(restBefore);
        const rows = heads as ReadonlyArray<Record<string, number | string>>;
        expect(rows.map(({ state_since: _, ...row }) => row)).toEqual(headsBefore);
        for (const row of rows) {
          expect(row.state_since).toBeGreaterThanOrEqual(Number(row.created_at));
          expect(row.state_since).toBeLessThanOrEqual(Number(row.updated_at));
        }
        expect(database.prepare("PRAGMA foreign_key_check(task_layers)").all()).toEqual([]);
      } finally {
        database.close();
      }
    },
    30_000,
  );

  it("backfills each task's state from its last task transition, kept within its own times", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(TASK_TABLES_V31_SQL);
      // The columns of the old store's transitions the backfill reads.
      database.exec("CREATE TABLE work_task_transitions (canvas_name TEXT, item_id TEXT, lane TEXT, origin_at TEXT)");
      const head = database.prepare(`
        INSERT INTO task_heads (canvas_name, task_id, number, node_id, title, state, epoch, stamps_required, reviewers_json, depends_on_json, created_at, updated_at)
        VALUES ('factory', ?, ?, 'tasks-1', 'T', 'backlog', 0, 0, '[]', '[]', 1000, 9000)`);
      const step = database.prepare("INSERT INTO work_task_transitions VALUES ('factory', ?, ?, ?)");
      const at = (ms: number) => new Date(ms).toISOString();
      head.run("01JZ00000000000000000000T1", 1);
      step.run("01JZ00000000000000000000T1", "task", at(3000));
      step.run("01JZ00000000000000000000T1", "task", at(5000));
      step.run("01JZ00000000000000000000T1", "request", at(7000));
      head.run("01JZ00000000000000000000T2", 2);
      head.run("01JZ00000000000000000000T3", 3);
      step.run("01JZ00000000000000000000T3", "task", at(500));
      head.run("01JZ00000000000000000000T4", 4);
      step.run("01JZ00000000000000000000T4", "task", at(20000));

      migrateTaskStateSince(database);

      expect(database.prepare("SELECT task_id, state_since FROM task_heads ORDER BY number").all()).toEqual([
        { task_id: "01JZ00000000000000000000T1", state_since: 5000 },
        { task_id: "01JZ00000000000000000000T2", state_since: 9000 },
        { task_id: "01JZ00000000000000000000T3", state_since: 1000 },
        { task_id: "01JZ00000000000000000000T4", state_since: 9000 },
      ]);
    } finally {
      database.close();
    }
  });
});
