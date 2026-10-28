/**
 * Step 58 adds `machine_peers.binding` (0.11, 05 S5): which peers link only
 * through their link key. Proven on both shipped fixtures brought to version
 * 57 by the real steps: the step's schema hashes the same as the witness,
 * every row already held survives as it was, and every peer from before the
 * step keeps NULL, the account's own SSH access.
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
  STATE_SCHEMA_V57_IDENTITY,
  STATE_SCHEMA_V58_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, readRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V57_SQL, STATE_SCHEMA_V58_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-peer-binding-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fileURLToPath(new URL(`./fixtures/state-v13/${fixture}`, import.meta.url)), path);
  const database = new DatabaseSync(path, { open: true, readOnly: false, allowExtension: false, enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON");
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

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "adds the binding to %s, hashes as a fresh 58, and leaves every peer unbound and every row as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, upTo(57, STATE_SCHEMA_V57_SQL));
        database.prepare("INSERT INTO known_installations (installation_id, registered_at) VALUES ('mini-installation', 'now')").run();
        database.prepare("INSERT INTO machine_peers (machine_name, installation_id, bound_at) VALUES ('mini', 'mini-installation', 'now')").run();
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));

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

  it("holds only key or nothing", async () => {
    const database = await openCopy("remote-v13.db");
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
