/**
 * State migration 62 -> 63 lets a Files node cross as a stub (0.11, F1).
 * `stubs` is rebuilt with `files` in its `stub_of` CHECK. Proven on both
 * shipped fixtures brought to version 62 by the real steps: the step's schema
 * hashes as the witness, every stub already held survives with every value it
 * had, every other table is untouched, a files stub then stores and reads back
 * with no host, and the page-only CHECKs still hold.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { migrateMachineNames } from "../src/main/junto/state/migrate-machine-names";
import { nodeFromRow, nodeToRow } from "../src/main/junto/model/rows";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V62_IDENTITY,
  STATE_SCHEMA_V63_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, readRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { Node } from "../src/shared/model";
import { STATE_SCHEMA_V62_SQL, STATE_SCHEMA_V63_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-stub-files-migration-"));
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

const canvasOf = (database: DatabaseSync): string => {
  const canvas = database.prepare("SELECT canvas_name FROM canvases ORDER BY canvas_name LIMIT 1").get();
  if (canvas) return String(canvas.canvas_name);
  database
    .prepare("INSERT INTO canvases(canvas_name, canvas_id, created_at, updated_at, seq) VALUES ('main', 'c', 't', 't', 0)")
    .run();
  return "main";
};

const place = { x: 10, y: 20, width: 240, height: 100, z: 3 };
const stamp = "2026-10-28T00:00:00.000Z";

const store = (database: DatabaseSync, canvas: string, input: object): void => {
  const row = { ...nodeToRow(canvas, Schema.decodeUnknownSync(Node)(input)), created_at: stamp, updated_at: stamp };
  const columns = Object.keys(row);
  database
    .prepare(`INSERT INTO stubs(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...(Object.values(row) as SQLOutputValue[]));
};

/** Stubs as a build before the step wrote them: every kind it allowed. */
const seedFromBeforeTheStep = (database: DatabaseSync, canvas: string): void => {
  store(database, canvas, { kind: "stub", id: "spec", of: "file", ...place });
  store(database, canvas, { kind: "stub", id: "docs", of: "link", label: "Team handbook", ...place, x: 300 });
  store(database, canvas, { kind: "stub", id: "repo", of: "git", label: "Junto source", ...place, z: 7 });
  store(database, canvas, { kind: "stub", id: "browser", of: "page", host: "macbook", ...place, y: 900 });
};

describe("state migration 62 -> 63 (a Files node crosses as a stub)", () => {
  it("starts from the version-62 witness and ends at the head, which a fresh database matches", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V62_SQL)).toEqual(STATE_SCHEMA_V62_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V63_SQL)).toEqual(STATE_SCHEMA_V63_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "keeps every stubs row of %s as it was, and every other table untouched",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, upTo(62, STATE_SCHEMA_V62_SQL));
        const canvas = canvasOf(database);
        seedFromBeforeTheStep(database, canvas);
        expect(() => store(database, canvas, { kind: "stub", id: "early", of: "files", ...place })).toThrow();
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));

        const result = migrateStateSchema(database, upTo(63, STATE_SCHEMA_V63_SQL));
        expect(result).toMatchObject({ previousVersion: 62, schemaVersion: 63, ...STATE_SCHEMA_V63_IDENTITY });
        expect(readRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V63_IDENTITY);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        const after = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        expect(after).toEqual(before);
        expect(after.stubs).toHaveLength(4);

        // A files stub stores now and reads back as itself: a label only, no host.
        const folder = Schema.decodeUnknownSync(Node)({ kind: "stub", id: "folder", of: "files", label: "Shared drafts", ...place });
        store(database, canvas, folder);
        store(database, canvas, { kind: "stub", id: "bare-folder", of: "files", ...place });
        const stored = database.prepare("SELECT * FROM stubs WHERE id = 'folder'").get()!;
        expect(stored.host).toBeNull();
        expect(nodeFromRow("stub", stored as never)).toEqual(folder);

        // The page-only CHECKs hold: a machine on a page and only there, no label on a page.
        expect(() => database.prepare("UPDATE stubs SET host = 'mini' WHERE id = 'folder'").run()).toThrow();
        expect(() => database.prepare("UPDATE stubs SET host = NULL WHERE id = 'browser'").run()).toThrow();
        expect(() => database.prepare("UPDATE stubs SET label = 'x' WHERE id = 'browser'").run()).toThrow();
        expect(() => database.prepare("UPDATE stubs SET stub_of = 'note' WHERE id = 'spec'").run()).toThrow();
      } finally {
        database.close();
      }
    },
    60_000,
  );
});
