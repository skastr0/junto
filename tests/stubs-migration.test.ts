/**
 * State migration 29 -> 30 adds stubs (expand only): the files, links,
 * repositories and pages of another machine's canvas, as a machine holding a
 * copy sees them. Proven on both shipped fixtures brought to version 29 by the
 * real steps: every row already held survives, the one new table starts
 * empty, and a stub is stored and read back as a stub, with no path or
 * address and a machine only on a page.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { Result, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { migrateMachineNames } from "../src/main/junto/state/migrate-machine-names";
import { nodeFromRow, nodeToRow } from "../src/main/junto/model/rows";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V29_IDENTITY,
  STATE_SCHEMA_V30_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { Node } from "../src/shared/model";
import { STATE_SCHEMA_V29_SQL, STATE_SCHEMA_V30_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-stubs-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fileURLToPath(new URL(`./fixtures/state-v13/${fixture}`, import.meta.url)), path);
  const database = new DatabaseSync(path, { open: true, readOnly: false, allowExtension: false, enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
};

const snapshot = (database: DatabaseSync) =>
  Object.fromEntries(
    (
      database
        .prepare(
          `SELECT name FROM sqlite_schema
            WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'state_schema_identity'
            ORDER BY name`,
        )
        .all() as unknown as ReadonlyArray<{ readonly name: SQLOutputValue }>
    ).map(({ name }) => [String(name), database.prepare(`SELECT * FROM "${String(name)}"`).all()]),
  );

/** Step 21 names this machine; a fixture names it the way the real app would. */
const named = <T extends { readonly toVersion: number; readonly migrate: (database: DatabaseSync) => void }>(step: T): T =>
  step.toVersion === 21 ? { ...step, migrate: (database: DatabaseSync) => migrateMachineNames(database, "macbook") } : step;

const planAt = (version: number, sql: string) => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql: sql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version).map(named),
});

const decode = Schema.decodeUnknownResult(Node);
const place = { x: 10, y: 20, width: 240, height: 100, z: 3 };
const stubs = [
  { kind: "stub", id: "spec", of: "file", ...place },
  { kind: "stub", id: "repo", of: "git", label: "Junto source", ...place },
  { kind: "stub", id: "browser", of: "page", host: "macbook", ...place },
].map((input) => Schema.decodeUnknownSync(Node)(input));

describe("state migration 29 -> 30 (stubs)", () => {
  it("freezes the witnesses the step starts from and ends at", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V29_SQL)).toEqual(STATE_SCHEMA_V29_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V30_SQL)).toEqual(STATE_SCHEMA_V30_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "adds the one table to %s and leaves every row already held as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, planAt(29, STATE_SCHEMA_V29_SQL));
        const before = snapshot(database);
        expect(before).not.toHaveProperty("stubs");

        const result = migrateStateSchema(database, planAt(30, STATE_SCHEMA_V30_SQL));
        expect(result).toMatchObject({ previousVersion: 29, schemaVersion: 30 });
        expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V30_IDENTITY);
        const { stubs: held, ...rest } = snapshot(database);
        expect(rest).toEqual(before);
        expect(held).toEqual([]);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        database.close();
      }
    },
  );

  it("stores each stub in its own table and reads it back as itself, with no path or address", async () => {
    const database = await openCopy("command-center-v13.db");
    try {
      migrateStateSchema(database, planAt(30, STATE_SCHEMA_V30_SQL));
      const canvas = String(database.prepare("SELECT canvas_name FROM canvases LIMIT 1").get()!.canvas_name);
      for (const stub of stubs) {
        const row = { ...nodeToRow(canvas, stub), created_at: "2026-10-21T00:00:00.000Z", updated_at: "2026-10-21T00:00:00.000Z" };
        const columns = Object.keys(row);
        database
          .prepare(`INSERT INTO stubs(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
          .run(...(Object.values(row) as SQLOutputValue[]));
        const stored = database.prepare("SELECT * FROM stubs WHERE id = ?").get(stub.id)!;
        expect(Object.keys(stored).sort()).toEqual(
          ["canvas_name", "color", "created_at", "height", "host", "id", "label", "stub_of", "updated_at", "width", "x", "y", "z_index"].sort(),
        );
        expect(nodeFromRow("stub", stored as never)).toEqual(stub);
      }
      // The table holds what the kind holds: a machine on a page and only there, and no label on a page.
      expect(() => database.prepare("UPDATE stubs SET host = 'mini' WHERE id = 'spec'").run()).toThrow();
      expect(() => database.prepare("UPDATE stubs SET host = NULL WHERE id = 'browser'").run()).toThrow();
      expect(() => database.prepare("UPDATE stubs SET label = 'x' WHERE id = 'browser'").run()).toThrow();
      expect(() => database.prepare("UPDATE stubs SET stub_of = 'note' WHERE id = 'spec'").run()).toThrow();
    } finally {
      database.close();
    }
  });
});

describe("a stub as the model reads it", () => {
  it.each([
    ["a page with no machine", { of: "page" }],
    ["a file that names a machine", { of: "file", host: "macbook" }],
    ["a page with a label", { of: "page", host: "macbook", label: "docs" }],
    ["a kind that never crosses as a stub", { of: "note" }],
    ["a path", { of: "file", path: "/Users/op/spec.md" }],
  ])("refuses %s", (_case, fields) => {
    expect(Result.isFailure(decode({ kind: "stub", id: "s", ...place, ...fields }, { onExcessProperty: "error" }))).toBe(true);
  });
});
