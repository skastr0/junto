/**
 * Step 82 to 83 adds `canvas_removed_earlier`, filled once from the copy
 * history an earlier build left behind a canvas it removed (remote-security,
 * LOW 1 on 4689b5d6e). Expand only: one new table, and no kept row moves.
 * Proven on both shipped fixtures replayed to 82 on the production DDL.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V82_IDENTITY,
  STATE_SCHEMA_V83_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationDatabase,
  type StateSchemaMigrationPlan,
} from "../src/core/state/migrations";
import { migrateMachineNames } from "../src/core/state/migrate-machine-names";
import { expectedStateSchemaIdentity } from "../src/core/state/schema-identity";
import { STATE_SCHEMA_SQL } from "../src/core/state/schema";
import { STATE_SCHEMA_V82_SQL, STATE_SCHEMA_V83_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (name: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-canvas-removed-earlier-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fileURLToPath(new URL(`./fixtures/state-v13/${name}`, import.meta.url)), path);
  const database = new DatabaseSync(path, { open: true, readOnly: false, allowExtension: false, enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
};

const upTo = (version: number, currentSchemaSql: string): StateSchemaMigrationPlan => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version).map((step) =>
    step.toVersion === 21
      ? { ...step, migrate: (database: StateSchemaMigrationDatabase) => migrateMachineNames(database, "macbook") }
      : step),
});

/** Every kept table but the schema's own witness, which a step rewrites. */
const tables = (database: DatabaseSync): string[] =>
  database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'state_schema_identity' ORDER BY name").all().map((row) => String(row.name));
const contents = (database: DatabaseSync): Record<string, string[]> => Object.fromEntries(tables(database).map((table) => [
  table, database.prepare(`SELECT * FROM "${table}"`).all().map((row) => JSON.stringify(row)).sort(),
]));

describe("state migration 82 -> 83 (the canvases an earlier build removed here)", () => {
  it("starts from the version-82 witness and ends at the version-83 one, as a fresh install has it", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V82_SQL)).toEqual(STATE_SCHEMA_V82_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V83_SQL)).toEqual(STATE_SCHEMA_V83_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(STATE_SCHEMA_V83_IDENTITY);
  });

  it("is expand only: it replaces, removes, renames and retires nothing", () => {
    const step = STATE_SCHEMA_MIGRATIONS.find((candidate) => candidate.toVersion === 83)!;
    expect(step).toMatchObject({ fromVersion: 82, safety: "expand-only" });
    expect(step.replacesTables).toBeUndefined();
    expect(step.removesTables).toBeUndefined();
    expect(step.renamesTables).toBeUndefined();
    expect(step.retiresColumns).toBeUndefined();
  });

  it.each(["command-center-v13.db", "remote-v13.db"])("records in %s only the copy history of a canvas no longer held, and moves no kept row", async (name) => {
    const database = await openCopy(name);
    try {
      expect(migrateStateSchema(database, upTo(82, STATE_SCHEMA_V82_SQL))).toMatchObject({ schemaVersion: 82, ...STATE_SCHEMA_V82_IDENTITY });
      const held = database.prepare("SELECT canvas_name FROM canvases ORDER BY canvas_name LIMIT 1").get() as { canvas_name: string } | undefined;
      const sent = database.prepare("INSERT INTO canvas_copies_sent (canvas_name, target, seq, sent_at) VALUES (?, ?, 1, '2026-11-20T00:00:00.000Z')");
      // What an earlier build left behind a canvas it removed, for two machines; and the history of a canvas still here.
      sent.run("gone", "mini-installation");
      sent.run("gone", "studio-installation");
      if (held !== undefined) sent.run(held.canvas_name, "mini-installation");
      const before = contents(database);
      expect(migrateStateSchema(database, upTo(83, STATE_SCHEMA_V83_SQL))).toMatchObject({ schemaVersion: 83, ...STATE_SCHEMA_V83_IDENTITY });
      const { canvas_removed_earlier: earlier, ...rest } = contents(database);
      expect(earlier).toEqual([
        JSON.stringify({ canvas_name: "gone", target: "mini-installation" }),
        JSON.stringify({ canvas_name: "gone", target: "studio-installation" }),
      ]);
      expect(rest).toEqual(before);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      database.close();
    }
  });
});
