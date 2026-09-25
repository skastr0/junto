/**
 * State migration 2 -> 3 adds agent signals, expand-only. Proven on the real
 * shipped fixture (brought to version 2 by the real 1 -> 2 step), with the
 * production DDL and triggers live and rows in the immutable work logs: every
 * pre-existing row survives byte for byte and the new table takes writes.
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
  STATE_SCHEMA_V2_IDENTITY,
  STATE_SCHEMA_V3_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import {
  expectedStateSchemaIdentity,
  verifyRecordedStateSchemaIdentity,
} from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V2_SQL } from "./fixtures/state-v1/schema";

const fixture = fileURLToPath(
  new URL("./fixtures/state-v1/command-center-v1.db", import.meta.url),
);

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-signals-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fixture, path);
  const database = new DatabaseSync(path, {
    open: true,
    readOnly: false,
    allowExtension: false,
    enableForeignKeyConstraints: true,
  });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
};

const tableNames = (database: DatabaseSync): string[] =>
  (
    database
      .prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name NOT GLOB 'sqlite_*'
            AND name <> 'state_schema_identity'
          ORDER BY name`,
      )
      .all() as unknown as ReadonlyArray<{ readonly name: SQLOutputValue }>
  ).map(({ name }) => String(name));

const snapshot = (database: DatabaseSync) =>
  Object.fromEntries(
    tableNames(database).map((table) => [
      table,
      database.prepare(`SELECT * FROM "${table}" ORDER BY 1`).all(),
    ]),
  );

const versionTwoPlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 2,
  currentSchemaSql: STATE_SCHEMA_V2_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 2),
};

describe("state migration 2 -> 3 (agent signals)", () => {
  it("freezes the version-two witness the step starts from", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V2_SQL)).toEqual(
      STATE_SCHEMA_V2_IDENTITY,
    );
  });

  it("keeps every existing row, immutable logs included, and adds the table", async () => {
    const database = await openCopy();
    try {
      migrateStateSchema(database, versionTwoPlan);
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
      const before = snapshot(database);
      expect((before.work_events as unknown[]).length).toBeGreaterThan(0);
      expect(before).not.toHaveProperty("agent_signals");

      const result = migrateStateSchema(database);
      expect(result).toMatchObject({ previousVersion: 2, schemaVersion: 3 });
      expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(
        STATE_SCHEMA_V3_IDENTITY,
      );

      const after = snapshot(database);
      const { agent_signals: signals, ...rest } = after;
      expect(rest).toEqual(before);
      expect(signals).toEqual([]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      database
        .prepare(
          `INSERT INTO agent_signals(signal_id, canvas_name, node_id, kind, text, created_at, state)
           VALUES ('s1', 'factory', 'agent-1', 'blocked', 'need a key', 1, 'open')`,
        )
        .run();
      expect(() =>
        database
          .prepare(
            `INSERT INTO agent_signals(signal_id, canvas_name, node_id, kind, text, created_at, state)
             VALUES ('s2', 'factory', 'agent-1', 'blocked', 'x', 1, 'answered')`,
          )
          .run(),
      ).toThrow();
    } finally {
      database.close();
    }
  });
});
