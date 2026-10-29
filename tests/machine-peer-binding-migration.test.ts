/**
 * Step 58 adds `machine_peers.binding` (0.11, 05 S5): which peers link only
 * through their link key: the step's schema hashes the same as the witness,
 * every row already held survives as it was, and every peer from before the
 * step keeps NULL, the account's own SSH access.
 *
 * The version-57 database is made at version 57 (a fresh database takes the
 * witness schema whole), not by replaying 13 -> 57 over a shipped fixture:
 * that replay ran seconds under a loaded full run. It lives in memory, so no
 * path is shared with any other test, and rows seeded before the step stand in
 * for what a shipped database holds.
 */
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V57_IDENTITY,
  STATE_SCHEMA_V58_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, readRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V57_SQL, STATE_SCHEMA_V58_SQL } from "./fixtures/state-v13/schema";

/** A version-57 database, fresh and in memory. */
const openAt57 = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:", { allowExtension: false, enableForeignKeyConstraints: true });
  expect(migrateStateSchema(database, upTo(57, STATE_SCHEMA_V57_SQL))).toMatchObject({ schemaVersion: 57, ...STATE_SCHEMA_V57_IDENTITY });
  return database;
};

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

describe("state migration 57 -> 58 (a peer bound to its link key)", () => {
  it("starts from the version-57 witness and ends at the version-58 one", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V57_SQL)).toEqual(STATE_SCHEMA_V57_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V58_SQL)).toEqual(STATE_SCHEMA_V58_IDENTITY);
  });

  it(
    "adds the binding, hashes as a fresh 58, and leaves every peer unbound and every row as it was",
    () => {
      const database = openAt57();
      try {
        database.exec(`
          INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at) VALUES ('factory', 'canvas-1', 'now', 'now');
          INSERT INTO known_installations (installation_id, registered_at) VALUES ('mini-installation', 'now');
          INSERT INTO known_installations (installation_id, registered_at) VALUES ('studio-installation', 'now');
          INSERT INTO machine_peers (machine_name, installation_id, bound_at) VALUES ('mini', 'mini-installation', 'now');
          INSERT INTO machine_peers (machine_name, installation_id, bound_at) VALUES ('studio', 'studio-installation', 'now');
        `);
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        expect(before.machine_peers).toHaveLength(2);

        const result = migrateStateSchema(database, upTo(58, STATE_SCHEMA_V58_SQL));
        expect(result).toMatchObject({ previousVersion: 57, schemaVersion: 58, ...STATE_SCHEMA_V58_IDENTITY });
        expect(readRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V58_IDENTITY);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        const after = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        expect(Object.keys(after)).toEqual(Object.keys(before));
        expect(after.machine_peers).toEqual(before.machine_peers!.map((row) => ({ ...row, binding: null })));
        for (const table of Object.keys(before).filter((table) => table !== "machine_peers")) expect(after[table], table).toEqual(before[table]);
      } finally {
        database.close();
      }
    },
    60_000,
  );

  it("holds only key or nothing", () => {
    const database = openAt57();
    try {
      migrateStateSchema(database, upTo(58, STATE_SCHEMA_V58_SQL));
      database.prepare("INSERT INTO known_installations (installation_id, registered_at) VALUES ('mini-installation', 'now')").run();
      expect(() => database.prepare("INSERT INTO machine_peers (machine_name, installation_id, bound_at, binding) VALUES ('mini', 'mini-installation', 'now', 'account')").run()).toThrow();
      database.prepare("INSERT INTO machine_peers (machine_name, installation_id, bound_at, binding) VALUES ('mini', 'mini-installation', 'now', 'key')").run();
      expect(rows(database, "machine_peers")).toMatchObject([{ machine_name: "mini", binding: "key" }]);
    } finally {
      database.close();
    }
  });
});
