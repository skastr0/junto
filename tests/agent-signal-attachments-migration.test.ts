/**
 * State migration 8 -> 9 adds signal attachments (expand only). Proven on the
 * real shipped fixture brought to version 8 by the real steps: every
 * pre-existing row survives byte for byte, and the new table holds a signal's
 * files in order and lets them go with their signal.
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
  STATE_SCHEMA_V8_IDENTITY,
  STATE_SCHEMA_V9_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { STATE_SCHEMA_V8_SQL } from "./fixtures/state-v1/schema";

const fixture = fileURLToPath(new URL("./fixtures/state-v1/command-center-v1.db", import.meta.url));

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-signal-attachments-migration-"));
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

const versionEightPlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 8,
  currentSchemaSql: STATE_SCHEMA_V8_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 8),
};

const SHA = "a".repeat(64);

describe("state migration 8 -> 9 (signal attachments)", () => {
  it("freezes the version-eight witness the step starts from and names the head", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V8_SQL)).toEqual(STATE_SCHEMA_V8_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(STATE_SCHEMA_V9_IDENTITY);
  });

  it("adds the table and leaves every existing row, immutable logs included, untouched", async () => {
    const database = await openCopy();
    try {
      migrateStateSchema(database, versionEightPlan);
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 8 });
      const before = snapshot(database);
      expect((before.work_events as unknown[]).length).toBeGreaterThan(0);
      expect(before).not.toHaveProperty("agent_signal_attachments");

      const result = migrateStateSchema(database);
      expect(result).toMatchObject({ previousVersion: 8, schemaVersion: 9 });
      expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V9_IDENTITY);

      const { agent_signal_attachments: added, ...rest } = snapshot(database);
      expect(rest).toEqual(before);
      expect(added).toEqual([]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("holds a signal's files in order, refuses anything malformed, and lets them go with the signal", async () => {
    const database = await openCopy();
    try {
      migrateStateSchema(database);
      database
        .prepare(
          `INSERT INTO agent_signals(signal_id, canvas_name, node_id, kind, text, created_at, state)
           VALUES ('sig-1', 'factory', 'atlas', 'feedback', 'ready', 1, 'open')`,
        )
        .run();
      const insert = database.prepare(
        `INSERT INTO agent_signal_attachments(signal_id, position, sha256, byte_length, media_type, display_name, caption)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run("sig-1", 0, SHA, 10, "image/png", "before.png", "Before");
      insert.run("sig-1", 1, SHA, 10, "image/png", "after.png", null);
      // The same place twice, a place past the last, a signal that does not exist.
      expect(() => insert.run("sig-1", 0, SHA, 10, "image/png", "again.png", null)).toThrow();
      expect(() => insert.run("sig-1", 12, SHA, 10, "image/png", "late.png", null)).toThrow();
      expect(() => insert.run("sig-none", 0, SHA, 10, "image/png", "a.png", null)).toThrow();
      // A digest that is not one, a negative size, no name, an empty caption.
      expect(() => insert.run("sig-1", 2, "A".repeat(64), 10, "image/png", "a.png", null)).toThrow();
      expect(() => insert.run("sig-1", 2, SHA, -1, "image/png", "a.png", null)).toThrow();
      expect(() => insert.run("sig-1", 2, SHA, 10, "image/png", "", null)).toThrow();
      expect(() => insert.run("sig-1", 2, SHA, 10, "image/png", "a.png", "")).toThrow();

      expect(
        database.prepare("SELECT display_name FROM agent_signal_attachments ORDER BY position").all(),
      ).toEqual([{ display_name: "before.png" }, { display_name: "after.png" }]);
      database.prepare("DELETE FROM agent_signals WHERE signal_id = 'sig-1'").run();
      expect(database.prepare("SELECT COUNT(*) AS n FROM agent_signal_attachments").get()).toEqual({ n: 0 });
    } finally {
      database.close();
    }
  });
});
