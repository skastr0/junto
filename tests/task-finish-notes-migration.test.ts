/**
 * State migration 44 -> 45 rebuilds `task_heads` with `evidence_json` and
 * `handoff` (consolidate). Proven on both shipped fixtures brought to version
 * 44 by the real steps: every row comes through with its columns as they
 * were, every other table is untouched, and no task holds a finish's notes.
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
  STATE_SCHEMA_V44_IDENTITY,
  STATE_SCHEMA_V45_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V44_SQL, STATE_SCHEMA_V45_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-task-finish-notes-migration-"));
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

describe("state migration 44 -> 45 (finish notes)", () => {
  it("freezes the witnesses the step starts from and ends at", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V44_SQL)).toEqual(STATE_SCHEMA_V44_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V45_SQL)).toEqual(STATE_SCHEMA_V45_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "carries every task of %s over with no finish notes, and leaves every other row as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, planTo(44, STATE_SCHEMA_V44_SQL));
        const before = snapshot(database);

        const result = migrateStateSchema(database, planTo(45, STATE_SCHEMA_V45_SQL));
        expect(result).toMatchObject({ previousVersion: 44, schemaVersion: 45 });
        expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V45_IDENTITY);

        const { task_heads: heads, ...rest } = snapshot(database);
        const { task_heads: headsBefore, ...restBefore } = before;
        expect(rest).toEqual(restBefore);
        const rows = heads as ReadonlyArray<Record<string, number | string>>;
        expect(rows.map(({ evidence_json: _e, handoff: _h, ...row }) => row)).toEqual(headsBefore);
        expect(rows.every((row) => row.evidence_json === null && row.handoff === null)).toBe(true);
        expect(database.prepare("PRAGMA foreign_key_check(task_layers)").all()).toEqual([]);
      } finally {
        database.close();
      }
    },
    30_000,
  );
});
