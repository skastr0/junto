/**
 * State step 46 to 47 gives a signal's files an owner kind of their own:
 * `content_refs` is rebuilt with `signal` in its owner kind CHECK, and each
 * `{ other, signal:<id> }` row becomes `{ signal, <id> }` in the same copy
 * (consolidate). Proven through the engine on a fixture with mixed rows.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateSignalContentOwner } from "../src/main/junto/state/migrate-signal-content-owner";
import {
  CURRENT_STATE_SCHEMA_IDENTITY,
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V46_IDENTITY,
  STATE_SCHEMA_V47_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { STATE_SCHEMA_V46_SQL, STATE_SCHEMA_V47_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const planTo = (version: number, currentSchemaSql: string) => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version),
});

const SHA = (n: number) => n.toString(16).padStart(64, "0");
const at = "2026-10-21T12:00:00.000Z";

/** A version-46 database, recorded as such, with refs of every owner kind it knows. */
const at46 = async (extra: ReadonlyArray<readonly [string, string]> = []): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-signal-owner-migration-"));
  const database = new DatabaseSync(join(dir, "junto.db"), { enableForeignKeyConstraints: true });
  // A fresh database comes up at the version it is told is the head.
  migrateStateSchema(database, planTo(46, STATE_SCHEMA_V46_SQL));
  const object = database.prepare("INSERT INTO content_objects (sha256, byte_length, created_at, verified_at) VALUES (?, 4, ?, ?)");
  const ref = database.prepare(`
    INSERT INTO content_refs (ref_id, sha256, byte_length, media_type, display_name, owner_kind, owner_canvas, owner_node, owner_record_id, created_at)
    VALUES (?, ?, 4, 'image/png', 'shot.png', ?, 'factory', 'peer', ?, ?)`);
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["task", "task-1"],
    ["message", "01M5F80000000000000000000C"],
    ["artifact", "art-1"],
    ["other", "staged:upload-1"],
    ["other", "signal:01M5F80000000000000000SIG"],
    ["other", "signal:01M5F80000000000000000SI2"],
    ["other", "signalled-not-a-signal"],
    ...extra,
  ];
  rows.forEach(([kind, record], index) => {
    object.run(SHA(index + 1), at, at);
    ref.run(`ref-${index + 1}`, SHA(index + 1), kind, record, at);
  });
  return database;
};

const refs = (database: DatabaseSync) =>
  database.prepare("SELECT ref_id, sha256, byte_length, media_type, display_name, owner_kind, owner_canvas, owner_node, owner_record_id, created_at FROM content_refs ORDER BY ref_id").all();

describe("state step 46 to 47: a signal's files under their own owner kind", () => {
  it("starts from the version-46 witness and ends at the version-47 one, which is the head", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V46_SQL)).toEqual(STATE_SCHEMA_V46_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V47_SQL)).toEqual(STATE_SCHEMA_V47_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(STATE_SCHEMA_V47_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(STATE_SCHEMA_V47_IDENTITY);
  });

  it("keeps every row, moves each signal's file to its own kind and id, and leaves every other row as it was", async () => {
    const database = await at46();
    try {
      const before = refs(database) as ReadonlyArray<Record<string, unknown>>;
      const result = migrateStateSchema(database, planTo(47, STATE_SCHEMA_V47_SQL));
      expect(result).toMatchObject({ previousVersion: 46, schemaVersion: 47 });
      expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V47_IDENTITY);
      const after = refs(database) as ReadonlyArray<Record<string, unknown>>;
      expect(after).toHaveLength(before.length);
      expect(after).toEqual(before.map((row) =>
        typeof row.owner_record_id === "string" && row.owner_kind === "other" && row.owner_record_id.startsWith("signal:")
          ? { ...row, owner_kind: "signal", owner_record_id: row.owner_record_id.slice("signal:".length) }
          : row));
      expect(after.filter((row) => row.owner_kind === "signal").map((row) => row.owner_record_id)).toEqual([
        "01M5F80000000000000000SIG",
        "01M5F80000000000000000SI2",
      ]);
      expect(database.prepare("SELECT name FROM sqlite_schema WHERE tbl_name = 'content_refs' AND type = 'index' AND sql IS NOT NULL ORDER BY name").all())
        .toEqual([{ name: "content_refs_by_object" }, { name: "content_refs_by_owner" }]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      // The new kind is one the table takes now.
      database.prepare(`INSERT INTO content_refs (ref_id, sha256, byte_length, media_type, owner_kind, owner_canvas, owner_node, owner_record_id, created_at)
        VALUES ('ref-new', ?, 4, 'text/plain', 'signal', 'factory', 'peer', 'sig-new', ?)`).run(SHA(1), at);
    } finally {
      database.close();
    }
  });

  it("refuses a signal row that names no signal id, and leaves the database at 46", async () => {
    const database = await at46([["other", "signal:"]]);
    try {
      const before = refs(database);
      expect(() => migrateStateSchema(database, planTo(47, STATE_SCHEMA_V47_SQL))).toThrow(/name no signal id/u);
      expect(Number((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version)).toBe(46);
      expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V46_IDENTITY);
      expect(refs(database)).toEqual(before);
    } finally {
      database.close();
    }
  });

  it("is a no-op run again: a migrated database moves nothing", async () => {
    const database = await at46();
    try {
      migrateStateSchema(database, planTo(47, STATE_SCHEMA_V47_SQL));
      const once = refs(database);
      const again = migrateStateSchema(database, planTo(47, STATE_SCHEMA_V47_SQL));
      expect(again).toMatchObject({ previousVersion: 47, schemaVersion: 47 });
      expect(refs(database)).toEqual(once);
      // The converter itself, run on rows it already moved, changes none.
      const copy = new DatabaseSync(":memory:");
      try {
        copy.exec("PRAGMA foreign_keys = OFF");
        copy.exec(STATE_SCHEMA_V47_SQL);
        const rows = once as ReadonlyArray<Record<string, string | number | null>>;
        const insert = copy.prepare(`INSERT INTO content_refs (ref_id, sha256, byte_length, media_type, display_name, owner_kind, owner_canvas, owner_node, owner_record_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const row of rows) insert.run(row.ref_id!, row.sha256!, row.byte_length!, row.media_type!, row.display_name, row.owner_kind!, row.owner_canvas!, row.owner_node!, row.owner_record_id!, row.created_at!);
        migrateSignalContentOwner(copy);
        expect(refs(copy)).toEqual(once);
      } finally {
        copy.close();
      }
    } finally {
      database.close();
    }
  });
});
