import type { InstallationId } from "@shared/installation-id";
import { LEGACY_TASK_STATES, isOpenTaskState, remapLegacyTaskState, type LegacyTaskState } from "@shared/task-model";
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
 *   this installation. A seat no longer on the canvas leaves none, so an open
 *   task it held goes back to backlog.
 * - A seat holds one open task: if a stored seat held more, the oldest keeps
 *   it and the rest go back to backlog.
 * - Numbers run per canvas in creation order, from 1.
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

  const dependencies = new Map<string, string[]>();
  for (const dep of database.prepare(
    "SELECT canvas_name, task_id, depends_on_task_id FROM work_task_dependencies ORDER BY canvas_name, task_id, position",
  ).all()) {
    const key = `${text(dep.canvas_name)}\u0000${text(dep.task_id)}`;
    const held = dependencies.get(key);
    if (held === undefined) dependencies.set(key, [text(dep.depends_on_task_id)]);
    else held.push(text(dep.depends_on_task_id));
  }

  const tasks = database.prepare(`
    SELECT t.canvas_name, t.node_id, t.task_id, t.actor_seat_id, t.state, t.created_at, t.updated_at, m.parts_json
    FROM work_tasks t
    LEFT JOIN work_task_messages m
      ON m.canvas_name = t.canvas_name AND m.node_id = t.node_id AND m.parent_lane = 'task'
        AND m.item_id = t.task_id AND m.message_id = t.brief_message_id
    ORDER BY t.canvas_name, t.created_at, t.task_id
  `).all();

  const insert = database.prepare(`
    INSERT INTO task_heads (canvas_name, task_id, number, node_id, title, body, state, assignee_node_id, epoch,
      stamps_required, reviewers_json, stamps_json, depends_on_json, next_node_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '[]', '[]', ?, NULL, ?, ?)
  `);
  const ids = new Set(tasks.map((task) => `${text(task.canvas_name)}\u0000${text(task.task_id)}`));
  const numbers = new Map<string, number>();
  const holding = new Set<string>();
  for (const task of tasks) {
    const canvas = text(task.canvas_name);
    const taskId = text(task.task_id);
    const stored = text(task.state);
    if (!isLegacyState(stored)) throw new Error(`task ${taskId} has unknown state ${stored}`);
    const seat = task.actor_seat_id === null ? undefined : seatNodes.get(`${canvas}\u0000${text(task.actor_seat_id)}`);
    let state = remapLegacyTaskState(stored, seat !== undefined);
    if (isOpenTaskState(state) && seat !== undefined) {
      const key = `${canvas}\u0000${seat}`;
      if (holding.has(key)) state = "backlog";
      else holding.add(key);
    }
    const number = (numbers.get(canvas) ?? 0) + 1;
    numbers.set(canvas, number);
    const { title, body } = titleAndBody(briefText(task.parts_json), taskId);
    const dependsOn = (dependencies.get(`${canvas}\u0000${taskId}`) ?? []).filter((id) => ids.has(`${canvas}\u0000${id}`));
    const createdAt = millis(task.created_at);
    insert.run(
      canvas,
      taskId,
      number,
      text(task.node_id),
      title,
      body ?? null,
      state,
      state === "backlog" ? null : (seat ?? null),
      JSON.stringify(dependsOn),
      createdAt,
      Math.max(createdAt, millis(task.updated_at)),
    );
  }

  const counter = database.prepare("INSERT INTO task_numbers (canvas_name, next_number) VALUES (?, ?)");
  for (const [canvas, last] of numbers) counter.run(canvas, last + 1);
};
