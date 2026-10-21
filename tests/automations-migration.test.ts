/**
 * State migration 27 -> 28 adds the Automations node table and the automation
 * store (expand only). Proven on both shipped fixtures brought to version 27
 * by the real steps: every row already held survives as it was, and the new
 * tables start empty and hold their invariants.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateMachineNames } from "../src/main/junto/state/migrate-machine-names";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import {
  CURRENT_STATE_SCHEMA_IDENTITY,
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V27_IDENTITY,
  STATE_SCHEMA_V28_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V27_SQL, STATE_SCHEMA_V28_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-automations-migration-"));
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

const TABLES = ["automation_boards", "automations", "automation_cursors", "automation_firings"];
const AUTO = "01J0000000000000000000000A";

describe("state migration 27 -> 28 (automations)", () => {
  it("freezes the witness the step starts from and names the head", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V27_SQL)).toEqual(STATE_SCHEMA_V27_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V28_SQL)).toEqual(STATE_SCHEMA_V28_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(STATE_SCHEMA_V28_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(expectedStateSchemaIdentity(STATE_SCHEMA_SQL));
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "adds the tables to %s and leaves every row already held as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, planTo(27, STATE_SCHEMA_V27_SQL));
        const before = snapshot(database);
        expect((before.work_events as unknown[]).length).toBeGreaterThan(0);

        const result = migrateStateSchema(database, planTo(28, STATE_SCHEMA_V28_SQL));
        expect(result).toMatchObject({ previousVersion: 27, schemaVersion: 28 });
        expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V28_IDENTITY);

        const after = snapshot(database);
        expect(Object.fromEntries(Object.entries(after).filter(([name]) => !TABLES.includes(name)))).toEqual(before);
        for (const table of TABLES) expect(after[table], table).toEqual([]);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        database.close();
      }
    },
  );

  it("claims a firing slot once per automation", async () => {
    const database = await openCopy("command-center-v13.db");
    try {
      migrateStateSchema(database, planTo(28, STATE_SCHEMA_V28_SQL));
      const claim = (firingId: string) =>
        database
          .prepare(
            `INSERT INTO automation_firings (canvas_name, automation_id, cause_kind, claim_key, firing_id, at_epoch_ms, fired, firing_json)
             VALUES ('factory', ?, 'schedule', '60000', ?, 1, 1, '{}')`,
          )
          .run(AUTO, firingId);
      claim("01J0000000000000000000000B");
      expect(() => claim("01J0000000000000000000000C")).toThrow();
    } finally {
      database.close();
    }
  });
});
