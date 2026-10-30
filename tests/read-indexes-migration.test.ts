/**
 * Step 72 adds four indexes and nothing else (protect the main thread,
 * 0.11.7): `work_events_by_operation`, `work_events_by_item`,
 * `work_messages_actor` and `work_messages_sender_order`. Each shipped
 * fixture is replayed to version 71 on the production DDL, triggers active,
 * and seeded with facts in the immutable log; the step then moves no row, and
 * the reads it serves seek the new indexes on that database.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V71_IDENTITY,
  STATE_SCHEMA_V72_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { migrateMachineNames } from "../src/main/junto/state/migrate-machine-names";
import { expectedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V71_SQL, STATE_SCHEMA_V72_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-read-indexes-migration-"));
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
  (database.prepare(`SELECT * FROM "${table}"`).all() as unknown as ReadonlyArray<Record<string, unknown>>)
    .map((row) => JSON.stringify(row))
    .sort();

const upTo = (version: number, currentSchemaSql: string): StateSchemaMigrationPlan => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version).map((step) =>
    step.toVersion === 21 ? { ...step, migrate: (database: DatabaseSync) => migrateMachineNames(database, "macbook") } : step,
  ),
});

const SHA = "c".repeat(64);

/** Facts in the log, as a machine that queued commands and ruled them wrote them. */
const seedLog = (database: DatabaseSync): string => {
  const stored = database.prepare("SELECT canvas_name FROM canvases ORDER BY canvas_name LIMIT 1").get();
  const canvas = stored ? String(stored.canvas_name) : "main";
  if (!stored) {
    database.prepare("INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at, seq) VALUES (?, 'c', 't', 't', 0)").run(canvas);
  }
  const sequence = database
    .prepare("SELECT event_home, last_seq FROM work_event_sequences WHERE event_home = entity_home ORDER BY 1 LIMIT 1")
    .get()!;
  const home = String(sequence.event_home);
  let seq = BigInt(String(sequence.last_seq));
  const event = database.prepare(
    `INSERT INTO work_events(event_home, entity_home, seq, protocol, record_type, item_kind, item_id, item_canvas_name,
      item_node_id, operation, content_sha256, origin_at, received_at)
      VALUES (?, ?, ?, 'junto/work/v1', 'fact', ?, ?, ?, 'n', ?, ?, ?, ?)`,
  );
  const fact = database.prepare(
    `INSERT INTO work_facts(event_home, entity_home, seq, result_json, basis_kind) VALUES (?, ?, ?, ?, 'historical')`,
  );
  for (const [kind, id, operation] of [
    ["command", "op-1", "command.queued"],
    ["ruling", "op-1", "ruling.applied"],
    ["command", "op-2", "command.queued"],
  ] as const) {
    seq += 1n;
    event.run(home, home, String(seq), kind, id, canvas, operation, SHA, `2026-10-30T00:00:0${seq % 10n}Z`, "t");
    fact.run(home, home, String(seq), JSON.stringify({ operation }));
  }
  return canvas;
};

const indexes = (database: DatabaseSync) =>
  (database.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT GLOB 'sqlite_*' ORDER BY name").all() as unknown as ReadonlyArray<{ readonly name: SQLOutputValue }>)
    .map(({ name }) => String(name));

const plan = (database: DatabaseSync, sql: string, ...params: Array<string>) =>
  (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as unknown as ReadonlyArray<{ readonly detail: SQLOutputValue }>)
    .map(({ detail }) => String(detail))
    .join("\n");

const ADDED = ["task_heads_by_state", "work_events_by_item", "work_events_by_operation", "work_messages_actor", "work_messages_sender_order"];

describe("state migration 71 -> 72 (the read indexes)", () => {
  it("starts from the version-71 witness and ends at the version-72 one", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V71_SQL)).toEqual(STATE_SCHEMA_V71_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V72_SQL)).toEqual(STATE_SCHEMA_V72_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "adds the five indexes to %s and moves no row",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        expect(migrateStateSchema(database, upTo(71, STATE_SCHEMA_V71_SQL))).toMatchObject({ schemaVersion: 71, ...STATE_SCHEMA_V71_IDENTITY });
        const canvas = seedLog(database);
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        const indexesBefore = indexes(database);

        expect(migrateStateSchema(database, upTo(72, STATE_SCHEMA_V72_SQL))).toMatchObject({ schemaVersion: 72, ...STATE_SCHEMA_V72_IDENTITY });

        expect(Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]))).toEqual(before);
        expect(indexes(database)).toEqual([...indexesBefore, ...ADDED].sort());
        expect(
          plan(database, `SELECT seq FROM work_events INDEXED BY work_events_by_operation
            WHERE item_canvas_name = ? AND operation = 'command.queued'`, canvas),
        ).toContain("USING COVERING INDEX work_events_by_operation (item_canvas_name=? AND operation=?)");
        expect(
          database.prepare(`SELECT item_id FROM work_events INDEXED BY work_events_by_operation
            WHERE item_canvas_name = ? AND operation = 'command.queued' ORDER BY item_id`).all(canvas),
        ).toEqual([{ item_id: "op-1" }, { item_id: "op-2" }]);
        expect(
          database.prepare(`SELECT operation FROM work_events INDEXED BY work_events_by_item
            WHERE item_canvas_name = ? AND item_kind = 'ruling' AND item_id = 'op-1'`).all(canvas),
        ).toEqual([{ operation: "ruling.applied" }]);
        // The log still refuses a change.
        expect(() => database.exec("DELETE FROM work_events")).toThrow(/immutable/);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        database.close();
      }
    },
    60_000,
  );
});
