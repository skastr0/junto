/**
 * State migration 13 -> 14 drops the trigger that pinned every mailbox row to
 * one machine. Proven on both shipped fixtures brought to
 * version 13 by the real steps, with rows already in the immutable work log:
 * every row survives byte for byte, the trigger is gone, and a mailbox row
 * homed on any machine is then held.
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
  STATE_SCHEMA_V13_IDENTITY,
  STATE_SCHEMA_V14_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { STATE_SCHEMA_V13_SQL } from "./fixtures/state-v1/schema";

const TRIGGER = "work_messages_require_cc_home";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-mail-home-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fileURLToPath(new URL(`./fixtures/state-v1/${fixture}`, import.meta.url)), path);
  const database = new DatabaseSync(path, { open: true, readOnly: false, allowExtension: false, enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
};

const tableNames = (database: DatabaseSync): string[] =>
  (
    database
      .prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'state_schema_identity'
          ORDER BY name`,
      )
      .all() as unknown as ReadonlyArray<{ readonly name: SQLOutputValue }>
  ).map(({ name }) => String(name));

const snapshot = (database: DatabaseSync) =>
  Object.fromEntries(
    tableNames(database).map((table) => [table, database.prepare(`SELECT * FROM "${table}" ORDER BY 1, 2`).all()]),
  );

const triggerCount = (database: DatabaseSync): number =>
  Number(database.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'trigger' AND name = ?").get(TRIGGER)!.n);

/**
 * One mailbox row homed on a machine the old trigger refused. Foreign
 * keys are off for the probe: it asks whether the trigger refuses the row, not
 * whether the row's fact exists.
 */
const insertForeignHomedMail = (database: DatabaseSync): void => {
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database
      .prepare(
        `INSERT INTO work_messages(
          canvas_name, node_id, message_id, position, entity_home, actor_seat_id,
          fact_event_home, fact_entity_home, fact_seq, role, parts_json, origin_at, received_at
        ) VALUES ('factory', 'mailbox-probe', 'probe-message', 0, 'another-machine', ?,
          'another-machine', 'another-machine', '1', 'agent', '[]', ?, ?)`,
      )
      .run(`seat_${"a".repeat(64)}`, "2026-10-09T00:00:00.000Z", "2026-10-09T00:00:00.000Z");
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
};

const versionThirteenPlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 13,
  currentSchemaSql: STATE_SCHEMA_V13_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 13),
};

describe("state migration 13 -> 14 (mail is not pinned to one machine)", () => {
  it("freezes the version-thirteen witness the step starts from and names the head", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V13_SQL)).toEqual(STATE_SCHEMA_V13_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(STATE_SCHEMA_V14_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(expectedStateSchemaIdentity(STATE_SCHEMA_SQL));
  });

  it.each(["command-center-v1.db", "remote-v1.db"])(
    "drops the trigger from %s and leaves every row already held as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, versionThirteenPlan);
        expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 13 });
        const before = snapshot(database);
        expect((before.work_events as unknown[]).length).toBeGreaterThan(0);
        expect((before.work_facts as unknown[]).length).toBeGreaterThan(0);
        expect(triggerCount(database)).toBe(1);
        expect(() => insertForeignHomedMail(database)).toThrow(/work mailbox messages must be Command Center-homed/u);

        const result = migrateStateSchema(database);
        expect(result).toMatchObject({ previousVersion: 13, schemaVersion: 14 });
        expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V14_IDENTITY);
        expect(snapshot(database)).toEqual(before);
        expect(triggerCount(database)).toBe(0);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        insertForeignHomedMail(database);
        expect(
          database.prepare("SELECT entity_home FROM work_messages WHERE message_id = 'probe-message'").get(),
        ).toEqual({ entity_home: "another-machine" });
      } finally {
        database.close();
      }
    },
  );
});
