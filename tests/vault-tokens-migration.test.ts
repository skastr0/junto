/**
 * Step 62 adds the vault tokens' scope records (0.11, 07 N5): which vault
 * each machine's token is for, with which permissions, minted or pasted.
 * Proven on both shipped fixtures brought to version 61 by the real steps: the
 * step's schema hashes the same as the witness, every row already held
 * survives as it was, and the table starts empty, so a machine from before
 * the step holds no vault token.
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
  STATE_SCHEMA_V61_IDENTITY,
  STATE_SCHEMA_V62_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, readRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V61_SQL, STATE_SCHEMA_V62_SQL } from "./fixtures/state-v13/schema";
import { MACHINE_VAULT_TOKEN_TABLES } from "../src/main/junto/vault/state-schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-vault-tokens-migration-"));
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

const TABLES: ReadonlyArray<string> = MACHINE_VAULT_TOKEN_TABLES;

const insert = (database: DatabaseSync, row: { machine: string; vault: string; permissions: string; origin: string; account: string | null }) =>
  database
    .prepare("INSERT INTO machine_vault_tokens (machine_name, vault, permissions, origin, account_name, set_at_epoch_ms) VALUES (?, ?, ?, ?, ?, 1)")
    .run(row.machine, row.vault, row.permissions, row.origin, row.account);

describe("state migration 61 -> 62 (each vault token's scope record)", () => {
  it("starts from the version-61 witness and ends at the version-62 one", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V61_SQL)).toEqual(STATE_SCHEMA_V61_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V62_SQL)).toEqual(STATE_SCHEMA_V62_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "adds the empty table to %s, hashes as a fresh 62, and leaves every row as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, upTo(61, STATE_SCHEMA_V61_SQL));
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        for (const table of TABLES) expect(Object.keys(before)).not.toContain(table);

        const result = migrateStateSchema(database, upTo(62, STATE_SCHEMA_V62_SQL));
        expect(result).toMatchObject({ previousVersion: 61, schemaVersion: 62, ...STATE_SCHEMA_V62_IDENTITY });
        expect(readRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V62_IDENTITY);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        const after = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        expect(Object.keys(after).filter((table) => !TABLES.includes(table))).toEqual(Object.keys(before));
        for (const table of TABLES) expect(after[table], table).toEqual([]);
        for (const table of Object.keys(before)) expect(after[table], table).toEqual(before[table]);
      } finally {
        database.close();
      }
    },
    60_000,
  );

  it("holds one record per machine, closed permissions, and an account name exactly when minted", async () => {
    const database = await openCopy("command-center-v13.db");
    try {
      migrateStateSchema(database, upTo(62, STATE_SCHEMA_V62_SQL));
      insert(database, { machine: "macbook", vault: "Junto", permissions: "read_items,write_items", origin: "minted", account: "junto-macbook-write" });
      insert(database, { machine: "mini", vault: "Junto", permissions: "read_items", origin: "pasted", account: null });
      expect(() => insert(database, { machine: "mini", vault: "Junto", permissions: "read_items", origin: "pasted", account: null })).toThrow();
      expect(() => insert(database, { machine: "vps", vault: "Junto", permissions: "write_items", origin: "pasted", account: null })).toThrow();
      expect(() => insert(database, { machine: "vps", vault: "Junto", permissions: "read_items", origin: "minted", account: null })).toThrow();
      expect(() => insert(database, { machine: "vps", vault: "Junto", permissions: "read_items", origin: "pasted", account: "someone" })).toThrow();
      // A name that would widen the mint's --vault argument is refused here too.
      expect(() => insert(database, { machine: "vps", vault: "Dev:write_items", permissions: "read_items", origin: "pasted", account: null })).toThrow();
      expect(() => insert(database, { machine: "vps", vault: "Dev,Other", permissions: "read_items", origin: "pasted", account: null })).toThrow();
      expect(() => insert(database, { machine: "local", vault: "Junto", permissions: "read_items", origin: "pasted", account: null })).toThrow();
      expect(rows(database, "machine_vault_tokens").map((row) => row.machine_name)).toEqual(["macbook", "mini"]);
    } finally {
      database.close();
    }
  });
});
