/**
 * State migration 15 -> 16 adds the row exchange cursors (expand only).
 * Proven on both shipped fixtures brought to version 15 by the real steps:
 * every row already held survives, and the one new table starts empty and
 * holds a cursor only for a writer this machine knows.
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
  STATE_SCHEMA_V15_IDENTITY,
  STATE_SCHEMA_V16_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V15_SQL, STATE_SCHEMA_V16_SQL } from "./fixtures/state-v1/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-exchange-cursors-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fileURLToPath(new URL(`./fixtures/state-v1/${fixture}`, import.meta.url)), path);
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
    ).map(({ name }) => [String(name), database.prepare(`SELECT * FROM "${String(name)}"`).all()]),
  );

const versionFifteenPlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 15,
  currentSchemaSql: STATE_SCHEMA_V15_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 15),
};

const versionSixteenPlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 16,
  currentSchemaSql: STATE_SCHEMA_V16_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 16),
};

describe("state migration 15 -> 16 (row exchange cursors)", () => {
  it("freezes the witnesses the step starts from and ends at", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V15_SQL)).toEqual(STATE_SCHEMA_V15_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V16_SQL)).toEqual(STATE_SCHEMA_V16_IDENTITY);
  });

  it.each(["command-center-v1.db", "remote-v1.db"])(
    "adds the one table to %s and leaves every row already held as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, versionFifteenPlan);
        const before = snapshot(database);
        expect((before.work_facts as unknown[]).length).toBeGreaterThan(0);
        expect(before).not.toHaveProperty("work_exchange_cursors");

        const result = migrateStateSchema(database, versionSixteenPlan);
        expect(result).toMatchObject({ previousVersion: 15, schemaVersion: 16 });
        expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V16_IDENTITY);
        const { work_exchange_cursors: cursors, ...rest } = snapshot(database);
        expect(rest).toEqual(before);
        expect(cursors).toEqual([]);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        const writer = String(database.prepare("SELECT installation_id FROM station_known_installations LIMIT 1").get()!.installation_id);
        const insert = database.prepare(
          `INSERT INTO work_exchange_cursors(canvas_name, writer, through, last_basis_seq, updated_at)
           VALUES ('factory', ?, ?, ?, '2026-10-09T00:00:00.000Z')`,
        );
        insert.run(writer, "9007199254740993", 4);
        // One cursor per canvas and writer, a canonical sequence, and only for a known writer.
        expect(() => insert.run(writer, "1", 0)).toThrow();
        expect(() => database.prepare("UPDATE work_exchange_cursors SET through = '007'").run()).toThrow();
        expect(() => database.prepare("UPDATE work_exchange_cursors SET last_basis_seq = -1").run()).toThrow();
        expect(() => insert.run("a-machine-nobody-registered", "1", 0)).toThrow();
      } finally {
        database.close();
      }
    },
  );
});
