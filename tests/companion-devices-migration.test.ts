/**
 * State migration 5 -> 6 adds companion devices (expand only). Proven on the
 * real shipped fixture brought to version 5 by the real steps, with the
 * production DDL and triggers live and rows in the immutable work logs: every
 * pre-existing row survives byte for byte, and the new table holds what the
 * registry needs and refuses what it must not.
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
  STATE_SCHEMA_V5_IDENTITY,
  STATE_SCHEMA_V6_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { STATE_SCHEMA_V5_SQL } from "./fixtures/state-v1/schema";

const fixture = fileURLToPath(new URL("./fixtures/state-v1/command-center-v1.db", import.meta.url));

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-companion-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fixture, path);
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
    tableNames(database).map((table) => [table, database.prepare(`SELECT * FROM "${table}" ORDER BY 1`).all()]),
  );

const versionFivePlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 5,
  currentSchemaSql: STATE_SCHEMA_V5_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 5),
};

const DEV = "dev_01J9Z3K4M5N6P7Q8R9S0T1V2W3";

describe("state migration 5 -> 6 (companion devices)", () => {
  it("freezes the version-five witness the step starts from and names the head", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V5_SQL)).toEqual(STATE_SCHEMA_V5_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(STATE_SCHEMA_V6_IDENTITY);
  });

  it("adds the table and leaves every existing row, immutable logs included, untouched", async () => {
    const database = await openCopy();
    try {
      migrateStateSchema(database, versionFivePlan);
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 5 });
      const before = snapshot(database);
      expect((before.work_events as unknown[]).length).toBeGreaterThan(0);
      expect(before).not.toHaveProperty("companion_devices");

      const result = migrateStateSchema(database);
      expect(result).toMatchObject({ previousVersion: 5, schemaVersion: 6 });
      expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V6_IDENTITY);

      const { companion_devices: added, ...rest } = snapshot(database);
      expect(rest).toEqual(before);
      expect(added).toEqual([]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("holds a pairing and a paired device, and refuses inconsistent rows", async () => {
    const database = await openCopy();
    try {
      migrateStateSchema(database);
      const insert = database.prepare(
        `INSERT INTO companion_devices(device_id, name, state, public_key, pairing_expires_at, created_at, paired_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, NULL)`,
      );
      insert.run(DEV, "", "pairing", "ssh-ed25519 AAAA", 600_000, null);
      insert.run(DEV.replace("W3", "W4"), "My iPhone", "paired", "ecdsa-sha2-nistp256 AAAA", null, 2);
      // A pairing device without an expiry, a paired one without a pairing time, a bad id, an unknown state.
      expect(() => insert.run(DEV.replace("W3", "W5"), "", "pairing", "k", null, null)).toThrow();
      expect(() => insert.run(DEV.replace("W3", "W6"), "x", "paired", "k", null, null)).toThrow();
      expect(() => insert.run("device-1", "", "pairing", "k", 1, null)).toThrow();
      expect(() => insert.run(DEV.replace("W3", "W7"), "", "revoked", "k", null, null)).toThrow();
      expect(() => insert.run(DEV.replace("W3", "W8"), "n".repeat(101), "paired", "k", null, 1)).toThrow();
    } finally {
      database.close();
    }
  });
});
