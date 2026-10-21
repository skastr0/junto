import type { InstallationId } from "@shared/installation-id";
import { LEGACY_TASK_STATES, isClosedTaskState, isOpenTaskState, remapLegacyTaskState, type LegacyTaskState } from "@shared/task-model";
import { deriveActorSeatId } from "../actor-seat-id";
import { TASKS_STATE_SCHEMA_SQL } from "../work/task-state-schema";
import type { StateSchemaMigrationDatabase } from "./migrations";

/**
 * The 0.10 task model step (plan 04): create the task tables and copy every
 * stored task into them. Expand only: the old rows stay until the old path is
 * deleted, and nothing here writes to a table that existed before.
 *
 * - The state goes through the contract's `remapLegacyTaskState`.
 * - The assignee is the seat node whose binding derives the stored seat id on
 *   this installation. A seat no longer on the canvas leaves none: an open
 *   task it held goes back to backlog, a closed one keeps no assignee.
 * - A task sent on was stored once per node it sat on. Its newest row is the
 *   head; each earlier row is a closed layer, closed when that row last
 *   changed.
 * - A task whose node is gone is history: one not yet closed is canceled,
 *   keeping any assignee as the record.
 * - A seat holds one open task: if a stored seat held more, the oldest keeps
 *   it and the rest go back to backlog.
 * - Numbers run per canvas in order of each task's first row, from 1.
 * - The title is the brief's first line, at most 200 characters; the body is
 *   the brief when it says more than the title.
 * - Epochs start at 0 with no reviewers or stamps: nothing in the old rows is
 *   a stamp.
 */

const TITLE_MAX = 200;

type Row = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

const isLegacyState = (value: string): value is LegacyTaskState =>
  (LEGACY_TASK_STATES as ReadonlyArray<string>).includes(value);

/** The brief's text parts, joined, or "" when it has none. */
const briefText = (partsJson: unknown): string => {
  try {
    const parts: unknown = JSON.parse(text(partsJson));
    if (!Array.isArray(parts)) return "";
    return parts
      .flatMap((part: unknown) =>
        typeof part === "object" && part !== null && (part as Row).kind === "text" ? [text((part as Row).text)] : []
      )
      .join("\n")
      .trim();
  } catch {
    return "";
  }
};

/** Title and body from a brief; the task id stands in for an empty brief. */
export const titleAndBody = (brief: string, taskId: string): { readonly title: string; readonly body?: string } => {
  const first = brief.split("\n")[0]?.trim() ?? "";
  const title = (first.length > 0 ? first : taskId).slice(0, TITLE_MAX);
  return brief.length > 0 && brief !== title ? { title, body: brief } : { title };
};

const millis = (iso: unknown): number => {
  const at = Date.parse(text(iso));
  return Number.isFinite(at) && at >= 0 ? at : 0;
};

export const migrateTaskModel = (database: StateSchemaMigrationDatabase): void => {
  database.exec(TASKS_STATE_SCHEMA_SQL);

  const installation = database.prepare("SELECT installation_id FROM installation WHERE singleton = 1").get();
  const installationId = text(installation?.installation_id);
  const seatNodes = new Map<string, string>();
  if (installationId.length > 0) {
    for (const seat of database.prepare("SELECT canvas_name, id, binding_id FROM seats").all()) {
      const binding = text(seat.binding_id).trim();
      if (binding.length === 0) continue;
      seatNodes.set(`${text(seat.canvas_name)}\u0000${deriveActorSeatId(installationId as InstallationId, binding)}`, text(seat.id));
    }
  }

  const boards = new Set(
    database.prepare("SELECT canvas_name, id FROM task_boards").all().map((board) =>
      `${text(board.canvas_name)}\u0000${text(board.id)}`
    ),
  );

  // Keyed by (canvas, node, task): each stored row of a task sent on had its own.
  const dependencies = new Map<string, string[]>();
  for (const dep of database.prepare(
    "SELECT canvas_name, node_id, task_id, depends_on_task_id FROM work_task_dependencies ORDER BY canvas_name, node_id, task_id, position",
  ).all()) {
    const key = `${text(dep.canvas_name)}\u0000${text(dep.node_id)}\u0000${text(dep.task_id)}`;
    const held = dependencies.get(key);
    if (held === undefined) dependencies.set(key, [text(dep.depends_on_task_id)]);
    else held.push(text(dep.depends_on_task_id));
  }

  const rows = database.prepare(`
    SELECT t.canvas_name, t.node_id, t.task_id, t.actor_seat_id, t.state, t.created_at, t.updated_at, m.parts_json
    FROM work_tasks t
    LEFT JOIN work_task_messages m
      ON m.canvas_name = t.canvas_name AND m.node_id = t.node_id AND m.parent_lane = 'task'
        AND m.item_id = t.task_id AND m.message_id = t.brief_message_id
    ORDER BY t.canvas_name, t.created_at, t.task_id, t.updated_at
  `).all();

  // One task per (canvas, task id), its rows oldest first; tasks in order of their first row.
  const byTask = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${text(row.canvas_name)}\u0000${text(row.task_id)}`;
    const held = byTask.get(key);
    if (held === undefined) byTask.set(key, [row]);
    else held.push(row);
  }

  const insertHead = database.prepare(`
    INSERT INTO task_heads (canvas_name, task_id, number, node_id, title, body, state, assignee_node_id, epoch,
      stamps_required, reviewers_json, stamps_json, depends_on_json, next_node_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '[]', '[]', ?, NULL, ?, ?)
  `);
  const insertLayer = database.prepare(`
    INSERT INTO task_layers (canvas_name, task_id, ordinal, node_id, layer_json, closed_at) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const numbers = new Map<string, number>();
  const holding = new Set<string>();
  for (const taskRows of byTask.values()) {
    const canvas = text(taskRows[0]!.canvas_name);
    const taskId = text(taskRows[0]!.task_id);
    const seatOf = (row: Row) =>
      row.actor_seat_id === null ? undefined : seatNodes.get(`${canvas}\u0000${text(row.actor_seat_id)}`);
    const stateOf = (row: Row) => {
      const stored = text(row.state);
      if (!isLegacyState(stored)) throw new Error(`task ${taskId} has unknown state ${stored}`);
      return remapLegacyTaskState(stored, seatOf(row) !== undefined);
    };

    const head = taskRows[taskRows.length - 1]!;
    const node = text(head.node_id);
    const seat = seatOf(head);
    let state = stateOf(head);
    if (!isClosedTaskState(state) && !boards.has(`${canvas}\u0000${node}`)) state = "canceled";
    if (isOpenTaskState(state) && seat !== undefined) {
      const seatKey = `${canvas}\u0000${seat}`;
      if (holding.has(seatKey)) state = "backlog";
      else holding.add(seatKey);
    }
    const number = (numbers.get(canvas) ?? 0) + 1;
    numbers.set(canvas, number);
    const { title, body } = titleAndBody(briefText(taskRows[0]!.parts_json), taskId);
    const dependsOn = (dependencies.get(`${canvas}\u0000${node}\u0000${taskId}`) ?? []).filter((id) =>
      byTask.has(`${canvas}\u0000${id}`) && id !== taskId
    );
    const createdAt = millis(taskRows[0]!.created_at);
    insertHead.run(
      canvas,
      taskId,
      number,
      node,
      title,
      body ?? null,
      state,
      state === "backlog" ? null : (seat ?? null),
      JSON.stringify(dependsOn),
      createdAt,
      Math.max(createdAt, millis(head.updated_at)),
    );

    taskRows.slice(0, -1).forEach((row, ordinal) => {
      const layerSeat = seatOf(row);
      const layer = {
        state: stateOf(row),
        node: text(row.node_id),
        ...(layerSeat === undefined ? {} : { assignee: layerSeat }),
        epoch: 0,
        stampPolicy: { required: 0 },
        reviewers: [],
        stamps: [],
      };
      insertLayer.run(canvas, taskId, ordinal, layer.node, JSON.stringify(layer), millis(row.updated_at));
    });
  }

  const counter = database.prepare("INSERT INTO task_numbers (canvas_name, next_number) VALUES (?, ?)");
  for (const [canvas, last] of numbers) counter.run(canvas, last + 1);
};
