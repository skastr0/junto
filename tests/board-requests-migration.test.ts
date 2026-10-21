/**
 * Step 39 deletes the bulletin board and the requests node: their nodes,
 * tables and wires, the `participates` and `reviews` verbs, the board ports
 * and `verdict.post`,
 * the request lane of the old task store, the board owners of content refs,
 * and the journal rows of the retired operations. Proven on both fixtures
 * brought to version 38 by the real steps, with a row in every place the
 * step reaches and kept rows beside each.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateMachineNames } from "../src/main/junto/state/migrate-machine-names";
import {
  BOARD_REQUESTS_REMOVED_TABLES,
  BOARD_REQUESTS_RETIRED_OPERATIONS,
} from "../src/main/junto/state/migrate-board-requests";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V38_IDENTITY,
  STATE_SCHEMA_V39_IDENTITY,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { Port } from "../src/shared/physics/schema";
import { STATE_SCHEMA_V38_SQL, STATE_SCHEMA_V39_SQL } from "./fixtures/state-v13/schema";
import { appendTaskMessage } from "./support/append-task-message";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-board-requests-migration-"));
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

/** A table's rows in a stable order, whatever its key. */
const rows = (database: DatabaseSync, table: string) =>
  (database.prepare(`SELECT * FROM "${table}"`).all() as unknown as ReadonlyArray<Record<string, unknown>>)
    .map((row) => [JSON.stringify(row), row] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, row]) => row);

const named = <T extends { readonly toVersion: number; readonly migrate: (database: DatabaseSync) => void }>(step: T): T =>
  step.toVersion === 21 ? { ...step, migrate: (database: DatabaseSync) => migrateMachineNames(database, "macbook") } : step;

const upTo = (version: number, currentSchemaSql: string): StateSchemaMigrationPlan => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version).map(named),
});

const geometry = (id: string) => ({
  id, x: 0, y: 0, width: 10, height: 10, z_index: 1, color: null, created_at: "t", updated_at: "t",
});

const SEAT = `seat_${"a".repeat(64)}`;
const SHA = "b".repeat(64);

/** Stored masks before the step, and what each reads after it. */
const MASKS = [
  ["mask-none", null, null],
  ["mask-board", '["board.list"]', "[]"],
  ["mask-mixed", '["msg.send","board.post","board.mark_read","msg.list"]', '["msg.send","msg.list"]'],
  ["mask-verdict", '["verdict.post","msg.send"]', '["msg.send"]'],
  ["mask-kept", '["msg.send"]', '["msg.send"]'],
] as const;

/** Wires the step deletes: the retired verbs, and every wire that touches a removed node. */
const GONE_WIRES = ["wire-participates", "wire-reviews", "wire-to-board", "wire-from-requests"];

type Seeded = { readonly canvas: string; readonly home: string; readonly last: bigint };

/**
 * A board and a requests node with a wire each, a wire of each retired verb,
 * the masks above, a request with its brief and transition, a topic with a
 * post, a cursor and a content ref, and one journal fact of every retired
 * operation (the request's two chained) beside a kept fact after them.
 */
const seed = (database: DatabaseSync): Seeded => {
  const insert = (table: string, row: Record<string, string | number | bigint | null>) =>
    database
      .prepare(`INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`)
      .run(...Object.values(row));
  const stored = database.prepare("SELECT canvas_name FROM canvases ORDER BY canvas_name LIMIT 1").get();
  if (!stored) insert("canvases", { canvas_name: "main", canvas_id: "c", created_at: "t", updated_at: "t", seq: 0 });
  const canvas = stored ? String(stored.canvas_name) : "main";
  const sequence = database.prepare("SELECT event_home, last_seq FROM work_event_sequences WHERE event_home = entity_home ORDER BY 1 LIMIT 1").get()!;
  const home = String(sequence.event_home);
  const first = BigInt(String(sequence.last_seq)) + 1n;

  insert("boards", { canvas_name: canvas, ...geometry("board-1"), label: null });
  insert("request_boards", { canvas_name: canvas, ...geometry("requests-1"), name: null });
  const wire = (id: string, from: string, to: string, verb: string, mask: string | null = null) =>
    insert("wires", {
      canvas_name: canvas, id, from_id: from, to_id: to, verb, from_side: null, to_side: null,
      mask_json: mask, created_at: "t", updated_at: "t",
    });
  for (const [id, mask] of MASKS) wire(id, "seat-a", "seat-b", "messages", mask);
  wire("wire-participates", "seat-a", "seat-b", "participates");
  wire("wire-reviews", "seat-a", "seat-b", "reviews");
  wire("wire-to-board", "seat-a", "board-1", "messages");
  wire("wire-from-requests", "requests-1", "seat-b", "messages");

  const operations = [...BOARD_REQUESTS_RETIRED_OPERATIONS, "message.append"];
  operations.forEach((operation, index) => {
    const seq = String(first + BigInt(index));
    insert("work_events", {
      event_home: home, entity_home: home, seq, protocol: "junto/work/v1", record_type: "fact",
      item_kind: operation.split(".")[0]!, item_id: `item-${index}`, item_canvas_name: canvas, item_node_id: "n",
      operation, content_sha256: SHA, origin_at: "t", received_at: "t",
    });
    const chained = operation === "request.resolve";
    insert("work_facts", {
      event_home: home, entity_home: home, seq, record_type: "fact",
      predecessor_event_home: chained ? home : null,
      predecessor_entity_home: chained ? home : null,
      predecessor_seq: chained ? String(first + BigInt(operations.indexOf("request.create"))) : null,
      result_json: "{}", basis_kind: "historical", basis_canvas_name: null, basis_canvas_seq: null,
    });
  });
  const factOf = (operation: string) => ({
    fact_event_home: home, fact_entity_home: home, fact_seq: String(first + BigInt(operations.indexOf(operation))),
  });
  const last = first + BigInt(operations.length - 1);
  database.prepare("UPDATE work_event_sequences SET last_seq = ? WHERE event_home = ? AND entity_home = ?").run(String(last), home, home);

  insert("work_requests", {
    canvas_name: canvas, node_id: "requests-1", request_id: "req-1", entity_home: home, actor_seat_id: SEAT,
    ...factOf("request.create"), state: "completed", brief_message_id: "brief-1", artifact_ids_json: null,
    metadata_json: null, reason: null, response: "done", created_at: "t", updated_at: "t", origin_at: "t", received_at: "t",
  });
  insert("work_task_messages", {
    canvas_name: canvas, node_id: "requests-1", parent_lane: "request", item_id: "req-1", message_id: "brief-1",
    position: 0, message_kind: "brief", entity_home: home, ...factOf("request.create"), role: "user", parts_json: "[]",
    context_id: null, reference_task_ids_json: null, metadata_json: null, origin_at: "t", received_at: "t",
  });
  insert("work_task_transitions", {
    canvas_name: canvas, node_id: "requests-1", item_id: "req-1", ordinal: 0, lane: "request", entity_home: home,
    actor_seat_id: SEAT, ...factOf("request.resolve"), operation: "request.resolve", from_state: "input-required",
    to_state: "completed", origin_at: "t", received_at: "t",
  });
  const author = { author_kind: "operator", author_seat_id: null, author_node_id: null, author_label: null, parts_json: "[]" };
  insert("work_board_topics", {
    canvas_name: canvas, node_id: "board-1", topic_id: "topic-1", title: "T", state: "open", ...author,
    post_count: 1, last_activity_at: "t", created_at: "t", updated_at: "t",
  });
  insert("work_board_posts", {
    canvas_name: canvas, node_id: "board-1", topic_id: "topic-1", post_id: "post-1", position: 0, ...author,
    tags_json: null, created_at: "t",
  });
  insert("work_board_read_cursors", {
    canvas_name: canvas, node_id: "board-1", topic_id: "topic-1", principal_key: "operator", last_read_position: 0, updated_at: "t",
  });
  insert("content_objects", { sha256: SHA, byte_length: 1, created_at: "t", verified_at: "t" });
  const ref = (refId: string, ownerKind: string) =>
    insert("content_refs", {
      ref_id: refId, sha256: SHA, byte_length: 1, media_type: "text/plain", display_name: null, owner_kind: ownerKind,
      owner_canvas: canvas, owner_node: "board-1", owner_record_id: "post-1", created_at: "t",
    });
  ref("ref-post", "board_post");
  ref("ref-topic", "board_topic");
  ref("ref-kept", "other");
  return { canvas, home, last };
};

const count = (database: DatabaseSync, sql: string): number => Number(database.prepare(sql).get()!.n);

describe("state migration 38 -> 39 (the board and requests deletions)", () => {
  it("starts from the version-38 witness and ends at the version-39 one", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V38_SQL)).toEqual(STATE_SCHEMA_V38_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V39_SQL)).toEqual(STATE_SCHEMA_V39_IDENTITY);
  });

  it("no longer lists the board ports or verdict.post", () => {
    expect((Port.literals as ReadonlyArray<string>).filter((port) => port.startsWith("board.") || port === "verdict.post")).toEqual([]);
  });

  it.each(["command-center-v13.db", "remote-v13.db"])(
    "deletes the board and requests from %s and leaves everything else as it was",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, upTo(38, STATE_SCHEMA_V38_SQL));
        const { home, last } = seed(database);
        const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));

        const result = migrateStateSchema(database, upTo(39, STATE_SCHEMA_V39_SQL));
        expect(result).toMatchObject({ previousVersion: 38, schemaVersion: 39 });
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(database.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);

        const after = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));
        for (const table of BOARD_REQUESTS_REMOVED_TABLES) expect(after[table]).toBeUndefined();
        const changed = ["wires", "work_events", "work_facts", "work_task_messages", "work_task_transitions", "content_refs"];
        const pick = (snapshot: Record<string, unknown>) =>
          Object.fromEntries(
            Object.entries(snapshot).filter(
              ([table]) => !changed.includes(table) && !(BOARD_REQUESTS_REMOVED_TABLES as ReadonlyArray<string>).includes(table),
            ),
          );
        expect(pick(after)).toEqual(pick(before));

        const masked = new Map<string, string | null>(MASKS.map(([id, , expected]) => [id, expected]));
        expect(after.wires).toEqual(
          before
            .wires!.filter((row) => !GONE_WIRES.includes(String(row.id)))
            .map((row) => (masked.has(String(row.id)) ? { ...row, mask_json: masked.get(String(row.id)) } : row)),
        );
        const retired = new Set<string>(BOARD_REQUESTS_RETIRED_OPERATIONS);
        const retiredSeqs = new Set(
          before.work_events!.filter((row) => retired.has(String(row.operation))).map((row) => `${row.event_home}/${row.seq}`),
        );
        expect(retiredSeqs.size).toBe(BOARD_REQUESTS_RETIRED_OPERATIONS.length);
        expect(after.work_events).toEqual(before.work_events!.filter((row) => !retired.has(String(row.operation))));
        expect(after.work_facts).toEqual(
          before.work_facts!.filter((row) => !retiredSeqs.has(`${row.event_home}/${row.seq}`)),
        );
        expect(after.work_task_messages).toEqual(before.work_task_messages!.filter((row) => row.parent_lane === "task"));
        expect(after.work_task_transitions).toEqual(before.work_task_transitions!.filter((row) => row.lane === "task"));
        expect(after.content_refs).toEqual(before.content_refs!.filter((row) => row.ref_id === "ref-kept"));

        // The allocator keeps its count: the next fact never reuses a deleted seq.
        expect(
          database.prepare("SELECT last_seq FROM work_event_sequences WHERE event_home = ? AND entity_home = ?").get(home, home),
        ).toEqual({ last_seq: String(last) });
        // The journal still refuses a delete, and the verbs and owners are closed.
        expect(() => database.exec("DELETE FROM work_events")).toThrow(/immutable/);
        expect(() => database.exec("DELETE FROM work_facts")).toThrow(/immutable/);
        expect(() =>
          database.exec(
            "INSERT INTO wires(canvas_name, id, from_id, to_id, verb, created_at, updated_at) SELECT canvas_name, 'w', 'a', 'b', 'reviews', 't', 't' FROM canvases LIMIT 1",
          ),
        ).toThrow(/CHECK/);
        expect(count(database, "SELECT count(*) AS n FROM sqlite_schema WHERE sql LIKE '%board_post%' OR sql LIKE '%request_boards%'")).toBe(0);
        // The task message trigger no longer reads the dropped requests table.
        const messages = count(database, "SELECT count(*) AS n FROM work_task_messages");
        appendTaskMessage(database);
        expect(count(database, "SELECT count(*) AS n FROM work_task_messages")).toBe(messages + 1);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        database.close();
      }
    },
    60_000,
  );

  it("refuses the step, and changes nothing, when a kept fact names a retired one", async () => {
    const database = await openCopy("command-center-v13.db");
    try {
      migrateStateSchema(database, upTo(38, STATE_SCHEMA_V38_SQL));
      const { home, last, canvas } = seed(database);
      const seq = String(last + 1n);
      database
        .prepare(
          `INSERT INTO work_events(event_home, entity_home, seq, protocol, record_type, item_kind, item_id, item_canvas_name,
            item_node_id, operation, content_sha256, origin_at, received_at)
            VALUES (?, ?, ?, 'junto/work/v1', 'fact', 'task', 'x', ?, 'n', 'task.transition', ?, 't', 't')`,
        )
        .run(home, home, seq, canvas, SHA);
      const createSeq = database
        .prepare("SELECT seq FROM work_events WHERE operation = 'request.create' AND event_home = ?")
        .get(home)!.seq;
      database
        .prepare(
          `INSERT INTO work_facts(event_home, entity_home, seq, predecessor_event_home, predecessor_entity_home, predecessor_seq,
            result_json, basis_kind) VALUES (?, ?, ?, ?, ?, ?, '{}', 'historical')`,
        )
        .run(home, home, seq, home, home, String(createSeq));
      const before = Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]));

      expect(() => migrateStateSchema(database, upTo(39, STATE_SCHEMA_V39_SQL))).toThrow(/name a retired journal fact/);
      expect(Object.fromEntries(tables(database).map((table) => [table, rows(database, table)]))).toEqual(before);
    } finally {
      database.close();
    }
  }, 60_000);
});
