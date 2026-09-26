/**
 * State migration 4 -> 5 adds portrait overrides and copies every seat
 * override the settings row held into it (expand, preserve). Proven on the
 * real shipped fixture brought to version 4 by the real steps, with the
 * production DDL and triggers live and rows in the immutable work logs: every
 * pre-existing row survives byte for byte, the settings row included, and
 * each existing override arrives as its own row.
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
  STATE_SCHEMA_V4_IDENTITY,
  STATE_SCHEMA_V5_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import {
  expectedStateSchemaIdentity,
  verifyRecordedStateSchemaIdentity,
} from "../src/main/junto/state/schema-identity";
import { normalizePortraitOverride } from "../src/shared/portrait-overrides";
import { STATE_SCHEMA_V4_SQL, STATE_SCHEMA_V5_SQL } from "./fixtures/state-v1/schema";

const fixture = fileURLToPath(new URL("./fixtures/state-v1/command-center-v1.db", import.meta.url));

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-portraits-migration-"));
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
    tableNames(database).map((table) => [table, database.prepare(`SELECT * FROM "${table}" ORDER BY 1`).all()]),
  );

const versionFivePlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 5,
  currentSchemaSql: STATE_SCHEMA_V5_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 5),
};

const versionFourPlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 4,
  currentSchemaSql: STATE_SCHEMA_V4_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 4),
};

// Overrides as the character editor wrote them into settings before 4 -> 5,
// plus entries no row could hold, which the step must skip, not fail on.
const bySeat = {
  "8a6b0c1e-seat-planner": { shape: "toast", topper: "cat", temperament: 0.6 },
  "0f3e9d2a-seat-builder": { bodyHue: "violet", eyes: "sparkle", blush: false },
  "seat-with-a-retired-option": { shape: "cloud-from-a-later-build", mouth: "grin" },
  "seat-not-an-object": "toast",
  "": { eyes: "dot" },
};

const writeSettingsRow = (database: DatabaseSync, body: Record<string, unknown>): void => {
  database
    .prepare(
      `INSERT INTO settings_preferences(singleton, version, body, updated_at)
       VALUES (1, 1, ?, '2026-09-25T00:00:00.000Z')
       ON CONFLICT(singleton) DO UPDATE SET body = excluded.body`,
    )
    .run(JSON.stringify(body));
};

const overrides = (database: DatabaseSync) =>
  Object.fromEntries(
    (
      database.prepare("SELECT seat_id, body_json FROM portrait_overrides ORDER BY seat_id").all() as unknown as ReadonlyArray<{
        readonly seat_id: string;
        readonly body_json: string;
      }>
    ).map((row) => [row.seat_id, JSON.parse(row.body_json)]),
  );

describe("state migration 4 -> 5 (portrait overrides)", () => {
  it("freezes the version-four witness the step starts from and the version-five one it ends at", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V4_SQL)).toEqual(STATE_SCHEMA_V4_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V5_SQL)).toEqual(STATE_SCHEMA_V5_IDENTITY);
  });

  it("copies every existing override forward and leaves every other row, settings included, untouched", async () => {
    const database = await openCopy();
    try {
      migrateStateSchema(database, versionFourPlan);
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
      writeSettingsRow(database, { appearance: { theme: "bright" }, portraits: { bySeat } });
      const before = snapshot(database);
      expect((before.work_events as unknown[]).length).toBeGreaterThan(0);
      expect(before).not.toHaveProperty("portrait_overrides");

      const result = migrateStateSchema(database, versionFivePlan);
      expect(result).toMatchObject({ previousVersion: 4, schemaVersion: 5 });
      expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V5_IDENTITY);

      const { portrait_overrides: _copied, ...rest } = snapshot(database);
      expect(rest).toEqual(before);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      expect(overrides(database)).toEqual({
        "0f3e9d2a-seat-builder": { bodyHue: "violet", eyes: "sparkle", blush: false },
        "8a6b0c1e-seat-planner": { shape: "toast", topper: "cat", temperament: 0.6 },
        "seat-with-a-retired-option": { shape: "cloud-from-a-later-build", mouth: "grin" },
      });
      // Each copied body reads back through the app's one normalizer intact.
      for (const [seat, body] of Object.entries(overrides(database))) {
        expect(normalizePortraitOverride(body)).toEqual(bySeat[seat as keyof typeof bySeat]);
      }
    } finally {
      database.close();
    }
  });

  it("adds an empty table when settings never held overrides, and bounds its rows", async () => {
    const database = await openCopy();
    try {
      migrateStateSchema(database, versionFourPlan);
      writeSettingsRow(database, { appearance: { theme: "dark" } });
      migrateStateSchema(database, versionFivePlan);
      expect(overrides(database)).toEqual({});
      const insert = database.prepare(
        "INSERT INTO portrait_overrides(seat_id, body_json, updated_at) VALUES (?, ?, 1)",
      );
      insert.run("seat-1", '{"eyes":"dot"}');
      expect(() => insert.run("seat-2", "[]")).toThrow();
      expect(() => insert.run("seat-3", "not json")).toThrow();
      expect(() => insert.run("", '{"eyes":"dot"}')).toThrow();
      expect(() => insert.run("seat-4", JSON.stringify({ eyes: "x".repeat(3000) }))).toThrow();
    } finally {
      database.close();
    }
  });
});
