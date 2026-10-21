/**
 * State migration 25 -> 26 adds versioned artifacts and the shared resource
 * rulings (expand only). Proven on both shipped fixtures brought to version
 * 25 by the real steps: every row already held survives as it was, and the
 * new tables start empty and hold their invariants.
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
  STATE_SCHEMA_V25_IDENTITY,
  STATE_SCHEMA_V26_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V25_SQL, STATE_SCHEMA_V26_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-artifacts-migration-"));
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
    ).map(({ name }) => [String(name), database.prepare(`SELECT * FROM "${String(name)}" ORDER BY 1, 2`).all()]),
  );

/** The real steps, with the name first boot would give fixed so the proof does not depend on where it runs. */
const named = <T extends { readonly toVersion: number; readonly migrate: (database: DatabaseSync) => void }>(step: T): T =>
  step.toVersion === 21 ? { ...step, migrate: (database: DatabaseSync) => migrateMachineNames(database, "macbook") } : step;

const planTo = (version: number, currentSchemaSql: string) => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version).map(named),
});

const TABLES = ["artifact_heads", "artifact_versions", "resource_rulings"];
const ID = "01J0000000000000000000000A";
const OP = "01J0000000000000000000000B";

const insertHead = (database: DatabaseSync, id = ID) =>
  database
    .prepare(
      `INSERT INTO artifact_heads (canvas_name, artifact_id, node_id, type, title, version,
        created_by_json, updated_at, archived, task_ids_json)
       VALUES ('factory', ?, 'artifacts-1', 'document', 'Notes', 1, '{"kind":"operator"}', 1, 0, '[]')`,
    )
    .run(id);

const insertVersion = (database: DatabaseSync, version: number, edit: string | null) =>
  database
    .prepare(
      `INSERT INTO artifact_versions (canvas_name, artifact_id, version, op_id, author_json, at, edit_json, body_json)
       VALUES ('factory', ?, ?, ?, '{"kind":"operator"}', 1, ?, '{"type":"document","markdown":""}')`,
    )
    .run(ID, version, OP, edit);

describe("state migration 25 -> 26 (artifacts and resource rulings)", () => {
  it("freezes the witness the step starts from and the one it ends at", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V25_SQL)).toEqual(STATE_SCHEMA_V25_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V26_SQL)).toEqual(STATE_SCHEMA_V26_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "adds the tables to %s and leaves every row already held as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, planTo(25, STATE_SCHEMA_V25_SQL));
        const before = snapshot(database);
        expect((before.work_events as unknown[]).length).toBeGreaterThan(0);

        const result = migrateStateSchema(database, planTo(26, STATE_SCHEMA_V26_SQL));
        expect(result).toMatchObject({ previousVersion: 25, schemaVersion: 26 });
        expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V26_IDENTITY);

        const after = snapshot(database);
        expect(Object.fromEntries(Object.entries(after).filter(([name]) => !TABLES.includes(name)))).toEqual(before);
        for (const table of TABLES) expect(after[table], table).toEqual([]);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        database.close();
      }
    },
  );

  it("keeps a version under its head, an edit on every version but the first, and one ruling per op", async () => {
    const database = await openCopy("command-center-v13.db");
    try {
      migrateStateSchema(database, planTo(26, STATE_SCHEMA_V26_SQL));
      // A version needs its head.
      expect(() => insertVersion(database, 1, null)).toThrow();
      insertHead(database);
      insertVersion(database, 1, null);
      // Version 1 is the create and carries no edit; every later one does.
      expect(() => insertVersion(database, 2, null)).toThrow();
      insertVersion(database, 2, '{"kind":"replace"}');
      // A head id is a ULID.
      expect(() => insertHead(database, "short")).toThrow();
      const ruling = database.prepare(
        `INSERT INTO resource_rulings (canvas_name, writer, op_id, kind, ruling_json) VALUES ('factory', 'mini', ?, ?, '{}')`,
      );
      ruling.run(OP, "applied");
      expect(() => ruling.run(OP, "applied")).toThrow();
      expect(() => ruling.run(ID, "maybe")).toThrow();
      database.prepare("DELETE FROM artifact_heads WHERE artifact_id = ?").run(ID);
      expect(database.prepare("SELECT COUNT(*) AS n FROM artifact_versions").get()).toEqual({ n: 0 });
    } finally {
      database.close();
    }
  });
});
