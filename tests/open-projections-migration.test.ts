/**
 * Step 73 keeps what is open in the work log beside it: `open_commands` and
 * `open_seat_controls`. Each shipped fixture is replayed to version 72 on the
 * production DDL, triggers active, and seeded with queued commands, rulings
 * and seat controls in the immutable log; the step fills both tables from it
 * and moves no other row. Every read the tables serve then equals the log
 * read it replaced, on the migrated data and again after the triggers follow
 * new facts and settles.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V72_IDENTITY,
  STATE_SCHEMA_V73_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationDatabase,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { migrateMachineNames } from "../src/main/junto/state/migrate-machine-names";
import { expectedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { OPEN_READS, openCommandsOf } from "../src/main/junto/work/open-projections-schema";
import { STATE_SCHEMA_V72_SQL, STATE_SCHEMA_V73_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-open-projections-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fileURLToPath(new URL(`./fixtures/state-v13/${fixture}`, import.meta.url)), path);
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
      : step,
  ),
});

const tables = (database: DatabaseSync): ReadonlyArray<string> =>
  (database.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'state_schema_identity' ORDER BY name`)
    .all() as unknown as ReadonlyArray<{ readonly name: SQLOutputValue }>).map(({ name }) => String(name));

const rows = (database: DatabaseSync, table: string) =>
  (database.prepare(`SELECT * FROM "${table}"`).all() as unknown as ReadonlyArray<Record<string, unknown>>)
    .map((row) => JSON.stringify(row))
    .sort();

const SHA = "c".repeat(64);

/** The log reads the open tables replaced, as they stood before step 73. */
const LOG_READS = {
  pendingSeatControls: `
    SELECT event.event_home AS writer, event.item_id AS control_id,
           event.origin_at, event.received_at, fact.result_json
    FROM work_events AS event
    JOIN work_facts AS fact USING (event_home, entity_home, seq)
    WHERE event.item_canvas_name = ?
      AND event.operation = 'seat.control'
      AND fact.predecessor_seq IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM seat_controls AS settled
        WHERE settled.canvas_name = event.item_canvas_name
          AND settled.firing_id = json_extract(fact.result_json, '$.firingId')
          AND settled.action_index = json_extract(fact.result_json, '$.actionIndex')
      )
    ORDER BY event.received_at DESC`,
  queueLoad: `
    SELECT count(*) AS rows, sum(length(CAST(fact.result_json AS BLOB))) AS bytes
    FROM work_events AS command INDEXED BY work_events_by_operation
    JOIN work_facts AS fact USING (event_home, entity_home, seq)
    WHERE command.event_home = ?2 AND command.entity_home = ?2 AND command.item_canvas_name = ?1
      AND command.operation = 'command.queued'
      AND NOT EXISTS (
        SELECT 1 FROM work_events AS ruling JOIN work_facts AS ruled USING (event_home, entity_home, seq)
        WHERE ruling.item_canvas_name = command.item_canvas_name AND ruling.item_node_id = command.item_node_id
          AND ruling.item_kind = 'ruling' AND ruling.item_id = command.item_id
          AND json_extract(ruled.result_json, '$.writer') = command.event_home
      )`,
  unruledCommands: `
    SELECT command.event_home AS writer, fact.result_json
    FROM work_events AS command INDEXED BY work_events_by_operation
    JOIN work_facts AS fact USING (event_home, entity_home, seq)
    WHERE command.item_canvas_name = ? AND command.operation = 'command.queued'
      AND command.event_home = command.entity_home
      AND NOT EXISTS (
        SELECT 1 FROM work_events AS ruling JOIN work_facts AS ruled USING (event_home, entity_home, seq)
        WHERE ruling.item_canvas_name = command.item_canvas_name AND ruling.item_node_id = command.item_node_id
          AND ruling.item_kind = 'ruling' AND ruling.item_id = command.item_id
          AND json_extract(ruled.result_json, '$.writer') = command.event_home
      )
    ORDER BY command.event_home, length(command.seq), command.seq`,
} as const;

const OP_UNRULED_LOG = `
  AND NOT EXISTS (
    SELECT 1 FROM resource_rulings AS ruled
    WHERE ruled.canvas_name = event.item_canvas_name AND ruled.writer = event.event_home AND ruled.op_id = event.item_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM work_events AS ruling JOIN work_facts AS ruled USING (event_home, entity_home, seq)
    WHERE ruling.item_canvas_name = event.item_canvas_name AND ruling.item_kind = 'ruling'
      AND ruling.item_id = event.item_id AND json_extract(ruled.result_json, '$.writer') = event.event_home
  )`;

/** The op reads (op-repository queued and unruled), log first, open table second. */
const opReads = (seat: string) => [
  {
    log: `SELECT event.item_id AS op_id FROM work_events AS event INDEXED BY work_events_by_operation
      JOIN work_facts AS fact USING (event_home, entity_home, seq)
      WHERE event.event_home = ?2 AND event.entity_home = ?2 AND event.item_canvas_name = ?1
        AND event.item_kind = 'command' AND event.operation = 'command.queued'
        AND json_extract(fact.result_json, '$.command.actor.kind') = 'seat'
        AND json_extract(fact.result_json, '$.command.actor.nodeId') = ?3
        ${OP_UNRULED_LOG}
      ORDER BY event.item_id DESC LIMIT 50`,
    open: `SELECT held.op_id ${openCommandsOf(`
        AND json_extract(fact.result_json, '$.command.actor.kind') = 'seat'
        AND json_extract(fact.result_json, '$.command.actor.nodeId') = ?3`)}
      ORDER BY held.op_id DESC LIMIT 50`,
    extra: [seat],
  },
  {
    log: `SELECT fact.result_json FROM work_events AS event INDEXED BY work_events_by_operation
      JOIN work_facts AS fact USING (event_home, entity_home, seq)
      WHERE event.event_home = ?2 AND event.entity_home = ?2 AND event.item_canvas_name = ?1
        AND event.item_kind = 'command' AND event.operation = 'command.queued'
        ${OP_UNRULED_LOG}
      ORDER BY length(event.seq), event.seq`,
    open: `SELECT fact.result_json ${openCommandsOf("")} ORDER BY length(held.seq), held.seq`,
    extra: [],
  },
];

const all = (database: DatabaseSync, sql: string, ...params: ReadonlyArray<SQLInputValue>) =>
  database.prepare(sql).all(...params);

/** Every read the open tables serve equals its log read, for every writer seen. */
const expectReadsMatch = (database: DatabaseSync, canvas: string, seat: string): number => {
  let compared = 0;
  const writers = (all(database, "SELECT DISTINCT event_home FROM work_events") as Array<{ event_home: string }>).map((row) => row.event_home);
  expect(all(database, OPEN_READS.pendingSeatControls, canvas)).toEqual(all(database, LOG_READS.pendingSeatControls, canvas));
  expect(all(database, OPEN_READS.unruledCommands, canvas)).toEqual(all(database, LOG_READS.unruledCommands, canvas));
  compared += 2;
  for (const writer of writers) {
    expect(all(database, OPEN_READS.queueLoad, canvas, writer)).toEqual(all(database, LOG_READS.queueLoad, canvas, writer));
    for (const read of opReads(seat)) {
      expect(all(database, read.open, canvas, writer, ...read.extra)).toEqual(all(database, read.log, canvas, writer, ...read.extra));
    }
    compared += 3;
  }
  return compared;
};

/** Facts in the log, as a machine that queues commands, rules some and admits seat controls writes them. */
const seeder = (database: DatabaseSync) => {
  const stored = database.prepare("SELECT canvas_name FROM canvases ORDER BY canvas_name LIMIT 1").get();
  const canvas = stored ? String(stored.canvas_name) : "main";
  if (!stored) {
    database.prepare("INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at, seq) VALUES (?, 'c', 't', 't', 0)").run(canvas);
  }
  const sequence = database
    .prepare("SELECT event_home, last_seq FROM work_event_sequences WHERE event_home = entity_home ORDER BY 1 LIMIT 1")
    .get()!;
  const home = String(sequence.event_home);
  let seq = BigInt(String(sequence.last_seq)) + 1000n;
  const event = database.prepare(
    `INSERT INTO work_events(event_home, entity_home, seq, protocol, record_type, item_kind, item_id, item_canvas_name,
      item_node_id, operation, content_sha256, origin_at, received_at)
      VALUES (?, ?, ?, 'junto/work/v1', 'fact', ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const fact = database.prepare(
    `INSERT INTO work_facts(event_home, entity_home, seq, result_json, basis_kind) VALUES (?, ?, ?, ?, 'historical')`,
  );
  const append = (kind: string, id: string, node: string, operation: string, body: Record<string, unknown>) => {
    seq += 1n;
    const at = `2026-10-30T00:${String(seq % 60n).padStart(2, "0")}:00.${String(seq).slice(-3).padStart(3, "0")}Z`;
    event.run(home, home, String(seq), kind, id, canvas, node, operation, SHA, at, at);
    fact.run(home, home, String(seq), JSON.stringify({ operation, ...body }));
  };
  const command = (opId: string, node: string, seat: string) =>
    append("command", opId, node, "command.queued", { command: { opId, actor: { kind: "seat", nodeId: seat } } });
  const ruling = (opId: string, node: string, writer = home) =>
    append("ruling", opId, node, "ruling.applied", { writer });
  const control = (firingId: string, actionIndex: number) =>
    append("seat-control", `${firingId}:${String(actionIndex)}`, "automation", "seat.control", { firingId, actionIndex });
  const settle = (firingId: string, actionIndex: number) =>
    database.prepare(`INSERT INTO seat_controls(canvas_name, firing_id, action_index, control_id, node_id, op, outcome, settled_at_epoch_ms)
      VALUES (?, ?, ?, ?, 'seat', 'start', 'applied', 1)`).run(canvas, firingId, actionIndex, `${firingId}:${String(actionIndex)}`);
  return { canvas, home, command, ruling, control, settle };
};

describe("state migration 72 -> 73 (what is open in the work log)", () => {
  it("starts from the version-72 witness and ends at the version-73 one, as a fresh install has it", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V72_SQL)).toEqual(STATE_SCHEMA_V72_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V73_SQL)).toEqual(STATE_SCHEMA_V73_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(STATE_SCHEMA_V73_IDENTITY);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "fills the open tables of %s from the log, moves no other row, and its reads equal the log's",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        expect(migrateStateSchema(database, upTo(72, STATE_SCHEMA_V72_SQL))).toMatchObject({ schemaVersion: 72, ...STATE_SCHEMA_V72_IDENTITY });
        const seed = seeder(database);
        seed.command("op-1", "board", "seat-a");
        seed.ruling("op-1", "board");
        seed.command("op-2", "board", "seat-a");
        seed.command("op-3", "other-board", "seat-b");
        // A ruling for another writer, or another node, answers nothing here.
        seed.ruling("op-2", "board", "someone-else");
        seed.ruling("op-3", "board");
        seed.control("firing-1", 0);
        seed.control("firing-2", 1);
        seed.settle("firing-2", 1);
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));

        expect(migrateStateSchema(database, upTo(73, STATE_SCHEMA_V73_SQL))).toMatchObject({ schemaVersion: 73, ...STATE_SCHEMA_V73_IDENTITY });

        const after = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        const { open_commands: commands, open_seat_controls: controls, ...rest } = after;
        expect(rest).toEqual(before);
        const openIds = (commands ?? []).map((row) => String(JSON.parse(row).op_id));
        expect(openIds).toEqual(expect.arrayContaining(["op-2", "op-3"]));
        expect(openIds).not.toContain("op-1");
        expect((controls ?? []).map((row) => String(JSON.parse(row).firing_id))).toContain("firing-1");
        expect((controls ?? []).map((row) => String(JSON.parse(row).firing_id))).not.toContain("firing-2");
        expect(expectReadsMatch(database, seed.canvas, "seat-a")).toBeGreaterThan(2);

        // The triggers follow new facts and settles in their own transactions.
        seed.command("op-4", "board", "seat-a");
        seed.ruling("op-2", "board");
        seed.control("firing-3", 0);
        seed.settle("firing-1", 0);
        // A ruling that lands before its command: the command is never open.
        seed.ruling("op-5", "board");
        seed.command("op-5", "board", "seat-a");
        const open = (all(database, "SELECT op_id FROM open_commands WHERE canvas_name = ? AND writer = ? ORDER BY op_id", seed.canvas, seed.home) as Array<{ op_id: string }>)
          .map((row) => row.op_id);
        expect(open).toContain("op-3");
        expect(open).toContain("op-4");
        expect(open).not.toContain("op-2");
        expect(open).not.toContain("op-5");
        const pending = (all(database, OPEN_READS.pendingSeatControls, seed.canvas) as Array<{ control_id: string }>).map((row) => row.control_id);
        expect(pending).toContain("firing-3:0");
        expect(pending).not.toContain("firing-1:0");
        expect(pending).not.toContain("firing-2:1");
        expectReadsMatch(database, seed.canvas, "seat-a");

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
