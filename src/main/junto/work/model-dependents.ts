import { Effect, Layer, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { ModelDependents } from "../model/dependents";
import { afterSqlCommit } from "../state/sql-commit";
import { unjournaledWorkMutationEffect } from "./mutation-seam";
import { workProjectionChanges } from "./projection-changes";

/** Child tables first; historical records and review provenance are retained. */
const currentTables = [
  "work_board_read_cursors", "work_board_posts", "work_board_topics",
  "work_pad_read_cursors", "work_pad_posts", "work_pad_pins",
  "work_pad_images", "work_pad_shapes", "work_pad_edges", "work_pad_inks", "work_pad_meta",
  "work_artifacts", "work_task_dependencies", "work_task_finish",
  "work_task_messages", "work_task_transitions", "work_tasks", "work_requests", "work_messages",
] as const;

export const WorkModelDependentsLive = Layer.effect(ModelDependents, Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = workProjectionChanges(sql);
  const remove = Effect.fn("work.model.remove")(function* (canvas: string, ids?: ReadonlyArray<string>) {
    if (ids?.length === 0) return;
    const nodeClause = ids === undefined ? "" : ` AND node_id IN (${ids.map(() => "?").join(",")})`;
    const bindings = [canvas, ...(ids ?? [])];
    // A source task is FK authority for linked current artifacts. Remove these
    // dependents as well, while their original publish facts retain provenance.
    const linked = yield* SqlSchema.findAll({
      Request: Schema.Array(Schema.String),
      Result: Schema.Struct({ canvas_name: Schema.String, node_id: Schema.String }),
      execute: (values) => sql.unsafe(`SELECT DISTINCT canvas_name,node_id FROM work_artifacts
        WHERE task_canvas_name=? ${ids === undefined ? "" : `AND task_node_id IN (${ids.map(() => "?").join(",")})`}`, values),
    })(bindings);
    yield* sql.unsafe(`DELETE FROM work_artifacts WHERE task_canvas_name=?
      ${ids === undefined ? "" : `AND task_node_id IN (${ids.map(() => "?").join(",")})`}`, bindings);
    for (const table of currentTables)
      yield* sql.unsafe(`DELETE FROM ${table} WHERE canvas_name=?${nodeClause}`, bindings);
    yield* sql.unsafe(`DELETE FROM work_delivery_receipts WHERE delivered_canvas_name=?
      ${ids === undefined ? "" : `AND delivered_node_id IN (${ids.map(() => "?").join(",")})`}`, bindings);
    if (ids === undefined) yield* sql`DELETE FROM work_canvas_revisions WHERE canvas_name=${canvas}`;
    yield* afterSqlCommit(sql, () => {
      for (const sink of linked) changes.notify({ canvasName: sink.canvas_name, nodeId: sink.node_id });
      for (const nodeId of ids ?? []) {
        changes.notify({ canvasName: canvas, nodeId });
        changes.notify({ canvasName: canvas, nodeId }, "mail");
      }
    });
  });
  return ModelDependents.of({
    removeCanvas: (canvas) => unjournaledWorkMutationEffect("work.model.remove", remove(canvas)),
    removeNodes: (canvas, ids) => unjournaledWorkMutationEffect("work.model.remove", remove(canvas, ids)),
  });
}));
