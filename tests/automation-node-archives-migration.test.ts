/**
 * State migration 33 -> 34 adds `automation_node_archives` (plan 07): the
 * automations a node delete archived, so its undo restores exactly those.
 * Expand only. Proven on both shipped fixtures brought to version 33 by the
 * real steps: every row already held survives as it was, and the new table
 * starts empty and holds its keys.
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
  STATE_SCHEMA_V33_IDENTITY,
  STATE_SCHEMA_V34_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V33_SQL, STATE_SCHEMA_V34_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-automation-archives-migration-"));
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

const ID = "01M5ESKJFC1A88R1MH1NEZWJ2Q";

describe("state migration 33 -> 34 (automation node archives)", () => {
  it("freezes the witnesses the step starts from and ends at", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V33_SQL)).toEqual(STATE_SCHEMA_V33_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V34_SQL)).toEqual(STATE_SCHEMA_V34_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])("adds an empty archives table to %s and leaves every row as it was", async (fixture) => {
    const database = await openCopy(fixture);
    try {
      migrateStateSchema(database, planTo(33, STATE_SCHEMA_V33_SQL));
      const before = snapshot(database);

      const result = migrateStateSchema(database, planTo(34, STATE_SCHEMA_V34_SQL));
      expect(result).toMatchObject({ previousVersion: 33, schemaVersion: 34 });
      expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V34_IDENTITY);

      const { automation_node_archives: archives, ...rest } = snapshot(database);
      expect(rest).toEqual(before);
      expect(archives).toEqual([]);

      const insert = database.prepare("INSERT INTO automation_node_archives (canvas_name, node_id, automation_id) VALUES (?, ?, ?)");
      insert.run("factory", "automations-1", ID);
      expect(() => insert.run("factory", "automations-1", ID)).toThrow(/UNIQUE|PRIMARY KEY/);
      expect(() => insert.run("factory", "automations-1", "not-a-ulid")).toThrow(/CHECK/);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
