import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";

// The reads that ask the log by kind of fact must search an index, never walk
// every event on the canvas (protect the main thread, v72). Each shape below
// is the WHERE clause of a live read; the plan is asserted on the real schema.

const planOf = (database: DatabaseSync, sql: string, params: ReadonlyArray<string>): string =>
  (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map((row) => row.detail)
    .join("\n");

const open = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:");
  database.exec(STATE_SCHEMA_SQL);
  return database;
};

const SHAPES: ReadonlyArray<{ readonly name: string; readonly sql: string; readonly params: ReadonlyArray<string>; readonly index: string }> = [
  {
    name: "pending seat controls (repository pending)",
    sql: `SELECT event.item_id FROM work_events AS event
      WHERE event.item_canvas_name = ? AND event.operation = 'seat.control'`,
    params: ["factory"],
    index: "work_events_by_operation",
  },
  {
    name: "queued commands of one writer (op-repository unruled, queueLoadOf)",
    sql: `SELECT event.item_id FROM work_events AS event INDEXED BY work_events_by_operation
      WHERE event.event_home = ? AND event.entity_home = ? AND event.item_canvas_name = ?
        AND event.item_kind = 'command' AND event.operation = 'command.queued'
      ORDER BY length(event.seq), event.seq`,
    params: ["home", "home", "factory"],
    index: "work_events_by_operation",
  },
  {
    name: "the queued command a refusal names (refusedKindOf)",
    sql: `SELECT event.seq FROM work_events AS event INDEXED BY work_events_by_item
      WHERE event.event_home = ? AND event.entity_home = ? AND event.item_canvas_name = ?
        AND event.item_kind = 'command' AND event.operation = 'command.queued' AND event.item_id = ?`,
    params: ["home", "home", "factory", "op"],
    index: "work_events_by_item",
  },
  {
    name: "the ruling events of one op (UNRULED, ruling projection)",
    sql: `SELECT ruling.seq FROM work_events AS ruling
      WHERE ruling.item_canvas_name = ? AND ruling.item_kind = 'ruling' AND ruling.item_id = ?`,
    params: ["factory", "op"],
    index: "work_events_by_item",
  },
  {
    name: "a seat's recent mail by its writer",
    sql: `SELECT message_id FROM work_messages
      WHERE canvas_name = ? AND actor_seat_id = ? ORDER BY received_at DESC LIMIT 20`,
    params: ["factory", "seat"],
    index: "work_messages_actor",
  },
];

describe("v72 read indexes", () => {
  for (const shape of SHAPES) {
    test(`${shape.name} searches ${shape.index}`, () => {
      const plan = planOf(open(), shape.sql, shape.params);
      expect(plan).toMatch(new RegExp(`USING (COVERING )?INDEX ${shape.index} \\(`));
      expect(plan).not.toContain("TEMP B-TREE");
      expect(plan).not.toMatch(/\bSCAN (event|ruling|work_events|work_messages)\b/);
    });
  }
});
