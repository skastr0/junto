/**
 * Step 35 takes the retired `relay.trigger` port out of every stored wire
 * mask, and nothing else moves. Proven on both fixtures brought to version 34
 * by the real steps, with masks of the shapes a live wire can hold: none, the
 * port alone, the port among others, and others only.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateMachineNames } from "../src/main/junto/state/migrate-machine-names";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V34_IDENTITY,
  STATE_SCHEMA_V35_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { Port } from "../src/shared/physics/schema";
import { STATE_SCHEMA_V34_SQL, STATE_SCHEMA_V35_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-relay-trigger-port-migration-"));
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

const named = <T extends { readonly toVersion: number; readonly migrate: (database: DatabaseSync) => void }>(step: T): T =>
  step.toVersion === 21 ? { ...step, migrate: (database: DatabaseSync) => migrateMachineNames(database, "macbook") } : step;

const upTo = (version: number, currentSchemaSql: string): StateSchemaMigrationPlan => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version).map(named),
});

/** Stored masks before the step, and what each reads after it. */
const MASKS = [
  ["mask-none", null, null],
  ["mask-relay", '["relay.trigger"]', "[]"],
  ["mask-mixed", '["msg.send","relay.trigger","msg.list"]', '["msg.send","msg.list"]'],
  ["mask-kept", '["msg.send"]', '["msg.send"]'],
] as const;

const seed = (database: DatabaseSync): void => {
  const canvas = database.prepare("SELECT canvas_name FROM canvases ORDER BY canvas_name LIMIT 1").get();
  const name = canvas
    ? String(canvas.canvas_name)
    : (database
        .prepare("INSERT INTO canvases(canvas_name, canvas_id, created_at, updated_at, seq) VALUES ('main', 'c', 't', 't', 0)")
        .run(),
      "main");
  const insert = database.prepare(
    `INSERT INTO wires(canvas_name, id, from_id, to_id, verb, mask_json, created_at, updated_at)
      VALUES (?, ?, 'a', 'b', 'messages', ?, 't', 't')`,
  );
  for (const [id, before] of MASKS) insert.run(name, id, before);
};

describe("state migration 34 -> 35 (relay.trigger leaves wire masks)", () => {
  it("starts from the version-34 witness and ends at the version-35 one, with the same text", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V34_SQL)).toEqual(STATE_SCHEMA_V34_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V35_SQL)).toEqual(STATE_SCHEMA_V35_IDENTITY);
    expect(STATE_SCHEMA_V35_IDENTITY).toEqual(STATE_SCHEMA_V34_IDENTITY);
  });

  it("no longer lists the port", () => {
    expect(Port.literals).not.toContain("relay.trigger");
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "takes the port out of every mask in %s and leaves everything else as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, upTo(34, STATE_SCHEMA_V34_SQL));
        seed(database);
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));

        const result = migrateStateSchema(database, upTo(35, STATE_SCHEMA_V35_SQL));
        expect(result).toMatchObject({ previousVersion: 34, schemaVersion: 35 });
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        const after = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        const { wires, ...rest } = after;
        const { wires: wiresBefore, ...restBefore } = before;
        expect(rest).toEqual(restBefore);
        const masked = new Map<string, string | null>(MASKS.map(([id, , expected]) => [id, expected]));
        expect(wires).toEqual(
          wiresBefore!.map((row) =>
            masked.has(String(row.id)) ? { ...row, mask_json: masked.get(String(row.id)) } : row),
        );
      } finally {
        database.close();
      }
    },
    60_000,
  );
});
