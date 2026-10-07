import { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { describe, expect, it } from "vitest";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";
import { readWorkSinkPage } from "../src/main/junto/work/repository";
import { WorkSinkPage } from "../src/shared/work-sinks";

describe("bounded work sink query", () => {
  it("hydrates only the artifact page and returns an exact continuation", async () => {
    const database = new DatabaseSync(":memory:");
    const queries: string[] = [];
    database.exec(`CREATE TABLE work_artifacts (
      canvas_name TEXT, node_id TEXT, artifact_id TEXT, actor_seat_id TEXT,
      name TEXT, parts_json TEXT, task_canvas_name TEXT, task_node_id TEXT,
      task_id TEXT, task_entity_home TEXT, metadata_json TEXT, origin_at TEXT
    );`);
    const insert = database.prepare("INSERT INTO work_artifacts VALUES ('factory','artifacts',?,?,NULL,?,NULL,NULL,NULL,NULL,NULL,'2026-10-07')");
    for (let index = 0; index < 1001; index++) insert.run(String(index).padStart(4, "0"), `seat_${"a".repeat(64)}`, index === 0 ? "invalid JSON outside page" : "[]");
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const sql = yield* makeSqliteClient(database, undefined, (query) => { queries.push(query); });
        const first = yield* readWorkSinkPage(sql, { kind: "artifacts", canvasName: "factory", nodeId: "artifacts", limit: 2 });
        expect(() => Schema.decodeUnknownSync(WorkSinkPage, { onExcessProperty: "error" })(first)).not.toThrow();
        if (first.kind !== "artifacts") throw new Error("expected artifacts");
        expect(first.items.map((item) => item.artifactId)).toEqual(["1000", "0999"]);
        expect(first.nextBeforeId).toBe("0999");
        const next = yield* readWorkSinkPage(sql, { kind: "artifacts", canvasName: "factory", nodeId: "artifacts", limit: 2, beforeId: first.nextBeforeId });
        if (next.kind !== "artifacts") throw new Error("expected artifacts");
        expect(next.items.map((item) => item.artifactId)).toEqual(["0998", "0997"]);
        expect(queries).toHaveLength(4);
        expect(queries.every((query) => query.includes("work_artifacts"))).toBe(true);
        expect(queries.filter((query) => query.includes("parts_json")).every((query) => query.includes("artifact_id IN"))).toBe(true);
      })).pipe(Effect.provide(Reactivity.layer)));
    } finally { database.close(); }
  });
});
