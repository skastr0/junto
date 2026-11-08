import type { DatabaseSync } from "node:sqlite";

const SHA = "b".repeat(64);

/**
 * A new message on a task already in the store, as the old task store wrote
 * one: its own fact at the home's next seq, then the message row, which the
 * exact-parent trigger checks against the task.
 */
export const appendTaskMessage = (database: DatabaseSync): void => {
  const task = database.prepare("SELECT canvas_name, node_id, task_id, entity_home FROM work_tasks ORDER BY 1, 2, 3 LIMIT 1").get()!;
  const home = String(task.entity_home);
  const last = database.prepare("SELECT last_seq FROM work_event_sequences WHERE event_home = ? AND entity_home = ?").get(home, home)!;
  const seq = String(BigInt(String(last.last_seq)) + 1n);
  database.prepare("UPDATE work_event_sequences SET last_seq = ? WHERE event_home = ? AND entity_home = ?").run(seq, home, home);
  database
    .prepare(
      `INSERT INTO work_events(event_home, entity_home, seq, protocol, record_type, item_kind, item_id, item_canvas_name,
        item_node_id, operation, content_sha256, origin_at, received_at)
        VALUES (?, ?, ?, 'junto/work/v1', 'fact', 'task', ?, ?, ?, 'message.append', ?, 't', 't')`,
    )
    .run(home, home, seq, String(task.task_id), String(task.canvas_name), String(task.node_id), SHA);
  database
    .prepare("INSERT INTO work_facts(event_home, entity_home, seq, result_json, basis_kind) VALUES (?, ?, ?, '{}', 'historical')")
    .run(home, home, seq);
  const position = Number(
    database
      .prepare(
        `SELECT coalesce(max(position) + 1, 0) AS n FROM work_task_messages
          WHERE canvas_name = ? AND node_id = ? AND parent_lane = 'task' AND item_id = ?`,
      )
      .get(String(task.canvas_name), String(task.node_id), String(task.task_id))!.n,
  );
  database
    .prepare(
      `INSERT INTO work_task_messages(canvas_name, node_id, parent_lane, item_id, message_id, position, message_kind,
        entity_home, fact_event_home, fact_entity_home, fact_seq, role, parts_json, origin_at, received_at)
        VALUES (?, ?, 'task', ?, ?, ?, 'history', ?, ?, ?, ?, 'agent', '[]', 't', 't')`,
    )
    .run(String(task.canvas_name), String(task.node_id), String(task.task_id), `after-step-${seq}`, position, home, home, home, seq);
};
