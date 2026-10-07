import { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { expect, it } from "vitest";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";
import { readWorkActorPage } from "../src/main/junto/work/repository";
import { WorkActorPage } from "../src/shared/work-sinks";
import { ActorSeatId } from "../src/shared/actor-seat";

it("pages an actor's rows across live sinks with an exact cursor for repeated item ids", async () => {
  const db = new DatabaseSync(":memory:");
  const seat = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"a".repeat(64)}`);
  db.exec(`
    CREATE TABLE artifact_boards(canvas_name TEXT,id TEXT);
    INSERT INTO artifact_boards VALUES ('factory','a'),('factory','b');
    CREATE TABLE work_artifacts (
      canvas_name TEXT,node_id TEXT,artifact_id TEXT,actor_seat_id TEXT,
      name TEXT,parts_json TEXT,task_canvas_name TEXT,task_node_id TEXT,
      task_id TEXT,task_entity_home TEXT,metadata_json TEXT,origin_at TEXT
    );`);
  const insert = db.prepare("INSERT INTO work_artifacts VALUES ('factory',?,?,?,NULL,?,NULL,NULL,NULL,NULL,NULL,'2026-10-07')");
  insert.run("a", "2", seat, "[]"); insert.run("b", "2", seat, "[]");
  insert.run("a", "1", seat, "invalid JSON outside the page");
  insert.run("retired", "9", seat, "invalid orphan JSON");
  insert.run("a", "9", `seat_${"b".repeat(64)}`, "invalid other actor JSON");
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const sql = yield* makeSqliteClient(db);
      const first = yield* readWorkActorPage(sql, { canvasName: "factory", seatId: seat, kind: "artifacts", limit: 1 });
      expect(() => Schema.decodeUnknownSync(WorkActorPage)(first)).not.toThrow();
      expect(first.items.map((row) => row.nodeId)).toEqual(["a"]);
      const second = yield* readWorkActorPage(sql, { canvasName: "factory", seatId: seat, kind: "artifacts", limit: 1, beforeId: first.nextBeforeId, beforeNodeId: first.nextBeforeNodeId });
      expect(second.items.map((row) => row.nodeId)).toEqual(["b"]);
      expect(second.nextBeforeId).toBe("2");
      expect(second.nextBeforeNodeId).toBe("b");
    })).pipe(Effect.provide(Reactivity.layer)));
  } finally { db.close(); }
});
