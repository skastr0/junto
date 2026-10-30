/**
 * Step 68 adds `automation_firings.rev` (0.11, 05 S3): the revision a firing
 * last carried across the exchange, 0 its first state worth showing. The
 * step's schema hashes the same as the witness, and every firing a database
 * already held keeps its bytes and reads rev 0 — it never crossed.
 *
 * The version-67 database is made at version 67 (a fresh database takes the
 * witness schema whole), not by replaying 13 -> 67 over a shipped fixture,
 * and it lives in memory, so no path is shared with any other test.
 */
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V67_IDENTITY,
  STATE_SCHEMA_V68_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, readRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V67_SQL, STATE_SCHEMA_V68_SQL } from "./fixtures/state-v13/schema";

const tables = (database: DatabaseSync): ReadonlyArray<string> =>
  (
    database
      .prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'state_schema_identity'
          ORDER BY name`,
      )
      .all() as unknown as ReadonlyArray<{ readonly name: SQLOutputValue }>
  ).map(({ name }) => String(name));

const rows = (database: DatabaseSync, table: string) =>
  database.prepare(`SELECT * FROM "${table}" ORDER BY 1, 2`).all() as unknown as ReadonlyArray<Record<string, unknown>>;

const upTo = (version: number, currentSchemaSql: string): StateSchemaMigrationPlan => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version),
});

/** A version-67 database, fresh and in memory. */
const openAt67 = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:", { allowExtension: false, enableForeignKeyConstraints: true });
  expect(migrateStateSchema(database, upTo(67, STATE_SCHEMA_V67_SQL))).toMatchObject({ schemaVersion: 67, ...STATE_SCHEMA_V67_IDENTITY });
  return database;
};

const AUTOMATION_ID = "01M62AAAAAAAAAAAAAAAAAAAAA";
const FIRING_ID = "01M62BBBBBBBBBBBBBBBBBBBBB";

describe("state migration 67 -> 68 (a firing's revision)", () => {
  it("starts from the version-67 witness and ends at the version-68 one", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V67_SQL)).toEqual(STATE_SCHEMA_V67_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V68_SQL)).toEqual(STATE_SCHEMA_V68_IDENTITY);
  });

  it("adds rev at 0 to every firing already held, and leaves every row as it was", () => {
    const database = openAt67();
    try {
      database.exec(`
        INSERT INTO automation_firings (canvas_name, automation_id, cause_kind, claim_key, firing_id, at_epoch_ms, fired, firing_json)
          VALUES ('main', '${AUTOMATION_ID}', 'schedule', 'slot-1', '${FIRING_ID}', 1, 1, '{}');
      `);
      const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
      expect(before["automation_firings"]).toHaveLength(1);
      expect(Object.keys(before["automation_firings"]![0]!)).not.toContain("rev");

      const result = migrateStateSchema(database, upTo(68, STATE_SCHEMA_V68_SQL));
      expect(result).toMatchObject({ previousVersion: 67, schemaVersion: 68, ...STATE_SCHEMA_V68_IDENTITY });
      expect(readRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V68_IDENTITY);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      const after = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
      expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
      const firing = after["automation_firings"]![0]!;
      const { rev, ...rest } = firing;
      expect(rev).toBe(0);
      expect(rest).toEqual(before["automation_firings"]![0]);
      for (const table of Object.keys(before)) {
        if (table === "automation_firings") continue;
        expect(after[table], table).toEqual(before[table]);
      }
    } finally {
      database.close();
    }
  }, 60_000);
});
