import { Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { WorkAttentionQuery } from "@shared/work-sinks";
import type { WorkSinkGlance } from "@shared/work-attention";

const CountRow = Schema.Struct({
  node_id: Schema.String,
  count: Schema.Int,
  input_required: Schema.Int,
  auth_required: Schema.Int,
  nonterminal: Schema.Int,
});
const lanes = [
  { table: "work_tasks", nodes: "task_boards", state: true, visible: "AND work.state != 'archived'" },
  { table: "work_requests", nodes: "request_boards", state: true, visible: "" },
  { table: "work_artifacts", nodes: "artifact_boards", state: false, visible: "" },
] as const;

/** SQL counts complete lanes; no message bodies, history or artifacts are read. */
export const readWorkGlances = Effect.fn("work.glance")(function* (
  reader: SqlClient.SqlClient,
  input: WorkAttentionQuery,
) {
  const query = yield* Schema.decodeUnknownEffect(WorkAttentionQuery)(input, { onExcessProperty: "error" });
  const rows = yield* SqlSchema.findAll({
    Request: Schema.Array(Schema.String),
    Result: CountRow,
    execute: (bindings) => reader.unsafe(lanes.map((lane) => `
      SELECT node.id AS node_id, COUNT(work.node_id) AS count,
        ${lane.state ? "COALESCE(SUM(work.state = 'input-required'),0)" : "0"} AS input_required,
        ${lane.state ? "COALESCE(SUM(work.state = 'auth-required'),0)" : "0"} AS auth_required,
        ${lane.state ? "COALESCE(SUM(work.state NOT IN ('completed','canceled','failed','rejected','archived')),0)" : "COUNT(work.node_id)"} AS nonterminal
      FROM ${lane.nodes} AS node
      LEFT JOIN ${lane.table} AS work ON work.canvas_name = node.canvas_name AND work.node_id = node.id ${lane.visible}
      WHERE node.canvas_name = ? ${query.nodeId === undefined ? "" : "AND node.id = ?"}
      GROUP BY node.id`).join(" UNION ALL "), bindings),
  })(lanes.flatMap(() => [query.canvasName, ...(query.nodeId === undefined ? [] : [query.nodeId])]));
  return rows.map((row): WorkSinkGlance => ({
    nodeId: row.node_id, count: row.count,
    needsHuman: row.input_required + row.auth_required > 0,
    allTerminal: row.nonterminal === 0,
    inputRequired: row.input_required, authRequired: row.auth_required,
  }));
});
