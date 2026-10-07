import { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { expect, it } from "vitest";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";
import { readWorkAttention } from "../src/main/junto/work/repository";
import { readWorkGlances } from "../src/main/junto/work/glance";
import { WorkSinkGlance } from "../src/shared/work-attention";

it("counts a whole sink while excluding unrelated work contents and old-kind rows", async () => {
  const database = new DatabaseSync(":memory:");
  const queries: string[] = [];
  database.exec(`
    CREATE TABLE task_boards(canvas_name TEXT,id TEXT);
    CREATE TABLE request_boards(canvas_name TEXT,id TEXT);
    CREATE TABLE artifact_boards(canvas_name TEXT,id TEXT);
    CREATE TABLE work_tasks(canvas_name TEXT,node_id TEXT,state TEXT);
    CREATE TABLE work_requests(canvas_name TEXT,node_id TEXT,state TEXT);
    CREATE TABLE work_artifacts(canvas_name TEXT,node_id TEXT);
    INSERT INTO task_boards VALUES ('factory','tasks'),('factory','empty');
    INSERT INTO request_boards VALUES ('factory','asks');
    INSERT INTO artifact_boards VALUES ('factory','artifacts');
    INSERT INTO work_requests VALUES ('factory','asks','completed');
    INSERT INTO work_artifacts VALUES ('factory','artifacts'),('factory','tasks');
  `);
  const insert = database.prepare("INSERT INTO work_tasks VALUES ('factory','tasks',?)");
  for (let index = 0; index < 1000; index++) insert.run("completed");
  insert.run("input-required"); insert.run("auth-required"); insert.run("archived");
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const sql = yield* makeSqliteClient(database, undefined, (query) => queries.push(query));
      const glances = yield* readWorkGlances(sql, { canvasName: "factory" });
      expect(() => Schema.decodeUnknownSync(Schema.Array(WorkSinkGlance))(glances)).not.toThrow();
      expect(glances.find((glance) => glance.nodeId === "tasks")).toEqual({ nodeId: "tasks", count: 1002, needsHuman: true, allTerminal: false, inputRequired: 1, authRequired: 1 });
      expect(glances.find((glance) => glance.nodeId === "empty")).toMatchObject({ count: 0, allTerminal: true, needsHuman: false });
      expect(glances.find((glance) => glance.nodeId === "asks")).toMatchObject({ count: 1, allTerminal: true });
      expect(glances.find((glance) => glance.nodeId === "artifacts")).toMatchObject({ count: 1, allTerminal: false });
      const targeted = yield* readWorkGlances(sql, { canvasName: "factory", nodeId: "tasks" });
      expect(targeted).toEqual([glances.find((glance) => glance.nodeId === "tasks")]);
      expect(queries).toHaveLength(2);
      expect(queries.every((query) => !query.includes("parts_json") && !query.includes("metadata_json"))).toBe(true);
    })).pipe(Effect.provide(Reactivity.layer)));
  } finally { database.close(); }
});

it("returns every human wait and active claim with only their first-line brief", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE task_boards(canvas_name TEXT,id TEXT);
    CREATE TABLE request_boards(canvas_name TEXT,id TEXT);
    CREATE TABLE work_task_messages(canvas_name TEXT,node_id TEXT,parent_lane TEXT,item_id TEXT,position INT,parts_json TEXT);
    CREATE TABLE work_tasks(canvas_name TEXT,node_id TEXT,task_id TEXT,state TEXT,actor_seat_id TEXT,metadata_json TEXT,origin_at TEXT);
    CREATE TABLE work_requests(canvas_name TEXT,node_id TEXT,request_id TEXT,state TEXT,actor_seat_id TEXT,metadata_json TEXT,origin_at TEXT);
    INSERT INTO task_boards VALUES ('factory','tasks');
    INSERT INTO request_boards VALUES ('factory','asks');
  `);
  const seat = `seat_${"a".repeat(64)}`;
  const insert = database.prepare("INSERT INTO work_tasks VALUES ('factory',?,? ,?, ?,NULL,'2026-10-07T12:00:00.000Z')");
  for (let index = 0; index < 1000; index++) insert.run("tasks", String(index), "submitted", null);
  insert.run("tasks", "needs-input", "input-required", seat);
  insert.run("tasks", "needs-auth", "auth-required", seat);
  insert.run("tasks", "claim", "working", seat);
  database.prepare("INSERT INTO work_task_messages VALUES ('factory','tasks','task','claim',0,?)").run(JSON.stringify([{ kind: "url", url: "https://example.test" }, { kind: "text", text: "First line\nFull body" }]));
  database.prepare("INSERT INTO work_task_messages VALUES ('factory','tasks','task','claim',1,?)").run("invalid later history");

  insert.run("tasks", "unclaimed", "working", null);
  insert.run("retired-node", "orphan", "input-required", seat);
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const sql = yield* makeSqliteClient(database);
      const rows = yield* readWorkAttention(sql, { canvasName: "factory" });
      expect(rows.map((row) => row.item.id).sort()).toEqual(["claim", "needs-auth", "needs-input"]);
      expect(rows.find((row) => row.item.id === "claim")?.item.metadata?.title).toBe("First line");
      expect(rows.every((row) => row.item.history.length === 0 && row.item.claimedBy === seat)).toBe(true);
    })).pipe(Effect.provide(Reactivity.layer)));
  } finally { database.close(); }
});
