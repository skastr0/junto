/**
 * State migration 6 -> 7 adds seat guidance (per-seat soul and instructions)
 * and agent profiles (expand only). Proven on the real shipped fixture brought
 * to version 6 by the real steps, with the production DDL and triggers live
 * and rows in the immutable work logs: every pre-existing row survives byte
 * for byte, and the new tables hold what the stores need and refuse what they
 * must not.
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
  STATE_SCHEMA_V6_IDENTITY,
  STATE_SCHEMA_V7_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { STATE_SCHEMA_V6_SQL } from "./fixtures/state-v1/schema";

const fixture = fileURLToPath(new URL("./fixtures/state-v1/command-center-v1.db", import.meta.url));

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-profiles-migration-"));
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

const versionSixPlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 6,
  currentSchemaSql: STATE_SCHEMA_V6_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 6),
};

describe("state migration 6 -> 7 (seat guidance and agent profiles)", () => {
  it("freezes the version-six witness the step starts from and names the head", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V6_SQL)).toEqual(STATE_SCHEMA_V6_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(STATE_SCHEMA_V7_IDENTITY);
  });

  it("adds both tables and leaves every existing row, immutable logs included, untouched", async () => {
    const database = await openCopy();
    try {
      migrateStateSchema(database, versionSixPlan);
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
      const before = snapshot(database);
      expect((before.work_events as unknown[]).length).toBeGreaterThan(0);
      expect(before).not.toHaveProperty("seat_guidance");
      expect(before).not.toHaveProperty("agent_profiles");

      const result = migrateStateSchema(database);
      expect(result).toMatchObject({ previousVersion: 6, schemaVersion: 7 });
      expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V7_IDENTITY);

      const { seat_guidance: guidance, agent_profiles: profiles, ...rest } = snapshot(database);
      expect(rest).toEqual(before);
      expect(guidance).toEqual([]);
      expect(profiles).toEqual([]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("holds a seat's soul or instructions and refuses an empty or oversized row", async () => {
    const database = await openCopy();
    try {
      migrateStateSchema(database);
      const insert = database.prepare(
        "INSERT INTO seat_guidance(seat_id, soul, instructions, updated_at) VALUES (?, ?, ?, 1)",
      );
      insert.run("agent-1", "Careful.", null);
      insert.run("agent-2", null, "Test first.");
      expect(() => insert.run("agent-3", null, null)).toThrow();
      expect(() => insert.run("agent-4", "", null)).toThrow();
      expect(() => insert.run("agent-5", "s".repeat(4001), null)).toThrow();
      expect(() => insert.run("agent-6", null, "i".repeat(8001))).toThrow();
    } finally {
      database.close();
    }
  });

  it("holds profiles with unique names regardless of case", async () => {
    const database = await openCopy();
    try {
      migrateStateSchema(database);
      const insert = database.prepare(
        "INSERT INTO agent_profiles(profile_id, name, body_json, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
      );
      insert.run("profile-1", "Reviewer", JSON.stringify({ name: "Reviewer", harness: "claude" }));
      expect(() => insert.run("profile-2", "reviewer", "{}")).toThrow();
      expect(() => insert.run("profile-3", "Other", "[]")).toThrow();
      expect(() => insert.run("profile-4", "   ", "{}")).toThrow();
    } finally {
      database.close();
    }
  });
});
