/**
 * State migration 65 -> 66 keeps the operator's read point in each mail
 * thread (0.11.3): `operator_mail_reads` is added, empty, and nothing else
 * changes. The version-65 database is made at version 65 in memory, as the
 * step 65 test does; the step is create-table only.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V65_IDENTITY,
  STATE_SCHEMA_V66_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { expectedStateSchemaIdentity, readRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V65_SQL, STATE_SCHEMA_V66_SQL } from "./fixtures/state-v13/schema";

const upTo = (version: number, currentSchemaSql: string): StateSchemaMigrationPlan => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version),
});

const tables = (database: DatabaseSync): ReadonlyArray<string> =>
  (database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as unknown as ReadonlyArray<{ name: string }>).map(
    (row) => row.name,
  );

const counts = (database: DatabaseSync): Readonly<Record<string, number>> =>
  Object.fromEntries(tables(database).map((name) => [name, Number((database.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n)]));

describe("state migration 65 -> 66 (the operator's mail read points)", () => {
  it("starts from the version-65 witness and ends at the version-66 witness", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V65_SQL)).toEqual(STATE_SCHEMA_V65_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V66_SQL)).toEqual(STATE_SCHEMA_V66_IDENTITY);
  });

  it("adds operator_mail_reads, empty, keeps every row held, and its rows go with their canvas", () => {
    const database = new DatabaseSync(":memory:", { allowExtension: false, enableForeignKeyConstraints: true });
    try {
      expect(migrateStateSchema(database, upTo(65, STATE_SCHEMA_V65_SQL))).toMatchObject({ schemaVersion: 65, ...STATE_SCHEMA_V65_IDENTITY });
      database.exec(`
        INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at) VALUES ('main', 'canvas-1', 'now', 'now');
        INSERT INTO view_sections (section, open) VALUES ('artifact-comments', 1);
      `);
      const before = counts(database);
      const result = migrateStateSchema(database, upTo(66, STATE_SCHEMA_V66_SQL));
      expect(result).toMatchObject({ previousVersion: 65, schemaVersion: 66, ...STATE_SCHEMA_V66_IDENTITY });
      expect(readRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V66_IDENTITY);
      expect(counts(database)).toEqual({ ...before, operator_mail_reads: 0 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      database.exec(`INSERT INTO operator_mail_reads (canvas_name, thread_id, through_message_id, through_at, read_at)
        VALUES ('main', 'thread-1', 'mail-1', 1, 2)`);
      database.exec("DELETE FROM canvases WHERE canvas_name = 'main'");
      expect(counts(database).operator_mail_reads).toBe(0);
    } finally {
      database.close();
    }
  });
});
