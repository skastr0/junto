/**
 * State migration 30 -> 31 adds the 0.10 task tables and copies every stored
 * task into them (expand only). Proven on both shipped fixtures brought to
 * version 30 by the real steps: every row already held survives as it was,
 * and each stored task becomes one head, numbered once per canvas.
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
  STATE_SCHEMA_V30_IDENTITY,
  STATE_SCHEMA_V31_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V30_SQL, STATE_SCHEMA_V31_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-task-model-migration-"));
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

const TABLES = ["task_heads", "task_layers", "task_numbers"];

describe("state migration 30 -> 31 (tasks)", () => {
  it("freezes the witnesses the step starts from and ends at", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V30_SQL)).toEqual(STATE_SCHEMA_V30_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V31_SQL)).toEqual(STATE_SCHEMA_V31_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "copies every task of %s into the task tables and leaves every row already held as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, planTo(30, STATE_SCHEMA_V30_SQL));
        const before = snapshot(database);
        const stored = database.prepare("SELECT count(DISTINCT canvas_name || ' ' || task_id) AS n FROM work_tasks").get();

        const result = migrateStateSchema(database, planTo(31, STATE_SCHEMA_V31_SQL));
        expect(result).toMatchObject({ previousVersion: 30, schemaVersion: 31 });
        expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V31_IDENTITY);

        const after = snapshot(database);
        expect(Object.fromEntries(Object.entries(after).filter(([name]) => !TABLES.includes(name)))).toEqual(before);
        expect(database.prepare("SELECT count(*) AS n FROM task_heads").get()).toEqual(stored);
        expect(
          database.prepare(
            `SELECT count(*) AS n FROM task_heads h JOIN task_numbers c USING (canvas_name) WHERE h.number >= c.next_number`,
          ).get(),
        ).toEqual({ n: 0 });
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        database.close();
      }
    },
  );
});
