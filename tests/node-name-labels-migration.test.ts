/**
 * Step 49 adds `label` as the last column of `pages`, `file_cards` and
 * `link_cards`, empty on every row already held, and nothing else moves.
 * Proven on both fixtures brought to version 48 by the real steps: the
 * migrated schema hashes the same as a fresh 49, so an upgraded database and
 * a new one are the same shape.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { nodeFromRow, nodeToRow } from "../src/main/junto/model/rows";
import { migrateMachineNames } from "../src/main/junto/state/migrate-machine-names";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V48_IDENTITY,
  STATE_SCHEMA_V49_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, readRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V48_SQL, STATE_SCHEMA_V49_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-node-name-labels-migration-"));
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

const NAMED = ["pages", "file_cards", "link_cards"] as const;

/** One page, one file and one link, held before the step. */
const seed = (database: DatabaseSync): void => {
  const canvas = database.prepare("SELECT canvas_name FROM canvases ORDER BY canvas_name LIMIT 1").get();
  const name = canvas
    ? String(canvas.canvas_name)
    : (database
        .prepare("INSERT INTO canvases(canvas_name, canvas_id, created_at, updated_at, seq) VALUES ('main', 'c', 't', 't', 0)")
        .run(),
      "main");
  const place = "canvas_name, id, x, y, width, height, z_index, created_at, updated_at";
  const at = "?, ?, 0, 0, 200, 100, 0, 't', 't'";
  database.prepare(`INSERT INTO pages(${place}, url, profile, on_remove) VALUES (${at}, 'https://docs.example', 'work', 'detach')`).run(name, "page-before");
  database.prepare(`INSERT INTO file_cards(${place}, path) VALUES (${at}, '/tmp/plan.md')`).run(name, "file-before");
  database.prepare(`INSERT INTO link_cards(${place}, url) VALUES (${at}, 'https://example.test')`).run(name, "link-before");
};

describe("state migration 48 -> 49 (a page, a file and a link can be named)", () => {
  it("starts from the version-48 witness and ends at the version-49 one", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V48_SQL)).toEqual(STATE_SCHEMA_V48_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V49_SQL)).toEqual(STATE_SCHEMA_V49_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "adds an empty label to every page, file and link in %s, hashes as a fresh 49, and leaves the rest as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, upTo(48, STATE_SCHEMA_V48_SQL));
        seed(database);
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));

        const result = migrateStateSchema(database, upTo(49, STATE_SCHEMA_V49_SQL));
        expect(result).toMatchObject({ previousVersion: 48, schemaVersion: 49, ...STATE_SCHEMA_V49_IDENTITY });
        expect(readRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V49_IDENTITY);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        const after = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        expect(Object.keys(after)).toEqual(Object.keys(before));
        for (const table of Object.keys(before)) {
          const expected = NAMED.includes(table as (typeof NAMED)[number])
            ? before[table]!.map((row) => ({ ...row, label: null }))
            : before[table];
          expect(after[table], table).toEqual(expected);
        }
      } finally {
        database.close();
      }
    },
    60_000,
  );
});

describe("a page, a file and a link keep the name the operator wrote", () => {
  const place = { id: "n", x: 0, y: 0, width: 200, height: 100, z: 0 };
  it.each([
    ["page", { kind: "page", url: "https://docs.example", profile: "work", onRemove: "detach" }],
    ["file", { kind: "file", path: "/tmp/plan.md" }],
    ["link", { kind: "link", url: "https://example.test" }],
  ] as const)("round-trips a %s label, and an absent one stays absent", (kind, fields) => {
    const labelled = { ...place, ...fields, label: "Roadmap" };
    const row = nodeToRow("main", labelled as never) as Record<string, unknown>;
    expect(row.label).toBe("Roadmap");
    expect(nodeFromRow(kind, row as never)).toMatchObject({ label: "Roadmap" });
    const bare = nodeToRow("main", { ...place, ...fields } as never) as Record<string, unknown>;
    expect(bare.label).toBeNull();
    expect(nodeFromRow(kind, bare as never)).not.toHaveProperty("label");
  });
});
