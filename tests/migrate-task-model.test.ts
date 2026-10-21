import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InstallationId } from "../src/shared/installation-id";
import { deriveActorSeatId } from "../src/main/junto/actor-seat-id";
import { migrateTaskModel, taskIdOf, titleAndBody } from "../src/main/junto/state/migrate-task-model";

// The old tables, cut to the columns the step reads.
const OLD_SCHEMA = `
  CREATE TABLE installation (singleton INTEGER PRIMARY KEY, installation_id TEXT NOT NULL);
  CREATE TABLE task_boards (canvas_name TEXT NOT NULL, id TEXT NOT NULL);
  CREATE TABLE seats (canvas_name TEXT NOT NULL, id TEXT NOT NULL, binding_id TEXT NOT NULL);
  CREATE TABLE work_tasks (
    canvas_name TEXT NOT NULL, node_id TEXT NOT NULL, task_id TEXT NOT NULL, actor_seat_id TEXT,
    state TEXT NOT NULL, brief_message_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE work_task_messages (
    canvas_name TEXT NOT NULL, node_id TEXT NOT NULL, parent_lane TEXT NOT NULL, item_id TEXT NOT NULL,
    message_id TEXT NOT NULL, parts_json TEXT NOT NULL
  );
  CREATE TABLE work_task_dependencies (
    canvas_name TEXT NOT NULL, node_id TEXT NOT NULL, task_id TEXT NOT NULL, depends_on_task_id TEXT NOT NULL,
    position INTEGER NOT NULL
  );
`;

const install = "mini" as InstallationId;
const seatId = (binding: string) => deriveActorSeatId(install, binding);
const id = (n: number) => `01JZ00000000000000000000${String(n).padStart(2, "0")}`;

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(OLD_SCHEMA);
  db.prepare("INSERT INTO installation VALUES (1, ?)").run(install);
  db.prepare("INSERT INTO task_boards VALUES ('factory', 'tasks-1'), ('factory', 'tasks-2')").run();
  db.prepare("INSERT INTO seats VALUES ('factory', 'seat-ada', 'bind-ada'), ('factory', 'seat-bo', 'bind-bo')").run();
});

afterEach(() => db.close());

const iso = (second: number) => new Date(Date.UTC(2026, 8, 1, 0, 0, second)).toISOString();

const task = (
  n: number,
  state: string,
  actor: string | null,
  brief: string,
  at = n,
  { node = "tasks-1", updated = 100 }: { readonly node?: string; readonly updated?: number } = {},
) => {
  db.prepare("INSERT INTO work_tasks VALUES ('factory', ?, ?, ?, ?, ?, ?, ?)").run(
    node,
    id(n),
    actor,
    state,
    `brief-${n}`,
    iso(at),
    iso(updated),
  );
  db.prepare("INSERT INTO work_task_messages VALUES ('factory', ?, 'task', ?, ?, ?)").run(
    node,
    id(n),
    `brief-${n}`,
    JSON.stringify([{ kind: "text", text: brief }]),
  );
};

const heads = () =>
  db.prepare("SELECT task_id, number, state, assignee_node_id, title, body, depends_on_json FROM task_heads ORDER BY number").all();

describe("task model migration", () => {
  it("remaps states, numbers in creation order and keeps titles and bodies", () => {
    task(2, "completed", seatId("bind-ada"), "Ship it\nwith notes", 2);
    task(1, "submitted", null, "Say hi", 1);
    task(3, "rejected", null, "Nope", 3);
    task(4, "working", seatId("bind-bo"), "Build", 4);
    migrateTaskModel(db);
    expect(heads()).toEqual([
      { task_id: id(1), number: 1, state: "backlog", assignee_node_id: null, title: "Say hi", body: null, depends_on_json: "[]" },
      { task_id: id(2), number: 2, state: "done", assignee_node_id: "seat-ada", title: "Ship it", body: "Ship it\nwith notes", depends_on_json: "[]" },
      { task_id: id(3), number: 3, state: "canceled", assignee_node_id: null, title: "Nope", body: null, depends_on_json: "[]" },
      { task_id: id(4), number: 4, state: "working", assignee_node_id: "seat-bo", title: "Build", body: null, depends_on_json: "[]" },
    ]);
    expect(db.prepare("SELECT next_number FROM task_numbers WHERE canvas_name = 'factory'").get()).toEqual({ next_number: 5 });
  });

  it("sends an open task whose seat is gone back to backlog", () => {
    task(1, "working", seatId("bind-gone"), "Orphan");
    migrateTaskModel(db);
    expect(heads()[0]).toMatchObject({ state: "backlog", assignee_node_id: null });
  });

  it("keeps one open task per seat: the oldest", () => {
    task(1, "working", seatId("bind-ada"), "First", 1);
    task(2, "input-required", seatId("bind-ada"), "Second", 2);
    migrateTaskModel(db);
    expect(heads().map((row) => [row.state, row.assignee_node_id])).toEqual([
      ["working", "seat-ada"],
      ["backlog", null],
    ]);
  });

  it("copies dependencies on tasks that exist, in order", () => {
    task(1, "submitted", null, "a", 1);
    task(2, "submitted", null, "b", 2);
    task(3, "submitted", null, "c", 3);
    const dep = db.prepare("INSERT INTO work_task_dependencies VALUES ('factory', 'tasks-1', ?, ?, ?)");
    dep.run(id(3), id(2), 0);
    dep.run(id(3), "01JZ0000000000000000000099", 1);
    dep.run(id(3), id(1), 2);
    migrateTaskModel(db);
    expect(JSON.parse(String(heads()[2]!.depends_on_json))).toEqual([id(2), id(1)]);
  });

  it("makes a task sent on one head, on its newest node, with each earlier row a closed layer", () => {
    task(1, "completed", seatId("bind-ada"), "Build then test", 1, { node: "tasks-1", updated: 10 });
    task(1, "working", seatId("bind-bo"), "Build then test", 10, { node: "tasks-2", updated: 20 });
    task(2, "submitted", null, "later", 5);
    const dep = db.prepare("INSERT INTO work_task_dependencies VALUES ('factory', ?, ?, ?, ?)");
    dep.run("tasks-1", id(1), id(2), 0);
    migrateTaskModel(db);
    expect(heads()).toEqual([
      { task_id: id(1), number: 1, state: "working", assignee_node_id: "seat-bo", title: "Build then test", body: null, depends_on_json: "[]" },
      { task_id: id(2), number: 2, state: "backlog", assignee_node_id: null, title: "later", body: null, depends_on_json: "[]" },
    ]);
    const layers = db.prepare("SELECT ordinal, node_id, layer_json, closed_at FROM task_layers").all();
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatchObject({ ordinal: 0, node_id: "tasks-1", closed_at: Date.parse(iso(10)) });
    expect(JSON.parse(String(layers[0]!.layer_json))).toMatchObject({ state: "done", node: "tasks-1", assignee: "seat-ada" });
  });

  it("keys dependencies by the head's node", () => {
    task(1, "submitted", null, "a", 1);
    task(2, "submitted", null, "b", 2, { node: "tasks-2" });
    db.prepare("INSERT INTO work_task_dependencies VALUES ('factory', 'tasks-2', ?, ?, 0)").run(id(2), id(1));
    db.prepare("INSERT INTO work_task_dependencies VALUES ('factory', 'tasks-1', ?, ?, 0)").run(id(2), "x");
    migrateTaskModel(db);
    expect(JSON.parse(String(heads()[1]!.depends_on_json))).toEqual([id(1)]);
  });

  it("migrates a task whose node is gone as history: one not yet closed is canceled, keeping any assignee", () => {
    task(1, "working", seatId("bind-ada"), "Lost", 1, { node: "tasks-gone" });
    task(2, "completed", seatId("bind-bo"), "Old", 2, { node: "tasks-gone" });
    task(3, "working", seatId("bind-ada"), "Live", 3);
    task(4, "submitted", null, "Waiting", 4, { node: "tasks-gone" });
    migrateTaskModel(db);
    expect(heads().map((row) => [row.state, row.assignee_node_id])).toEqual([
      ["canceled", "seat-ada"],
      ["done", "seat-bo"],
      ["working", "seat-ada"],
      ["canceled", null],
    ]);
  });

  it("gives a task id from before ULIDs a ULID from its time and old id, and moves dependencies with it", () => {
    db.prepare("INSERT INTO work_tasks VALUES ('factory', 'tasks-1', 'task-old', NULL, 'submitted', 'b', ?, ?)").run(iso(1), iso(2));
    task(2, "submitted", null, "b", 2);
    db.prepare("INSERT INTO work_task_dependencies VALUES ('factory', 'tasks-1', ?, 'task-old', 0)").run(id(2));
    migrateTaskModel(db);
    const derived = taskIdOf("factory", "task-old", Date.parse(iso(1)));
    expect(derived).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(derived).toBe(taskIdOf("factory", "task-old", Date.parse(iso(1))));
    expect(heads().map((row) => row.task_id)).toEqual([derived, id(2)]);
    expect(JSON.parse(String(heads()[1]!.depends_on_json))).toEqual([derived]);
    expect(taskIdOf("factory", id(2), 0)).toBe(id(2));
  });

  it("titles an empty brief with the task id and cuts long titles at 200", () => {
    expect(titleAndBody("", "T")).toEqual({ title: "T" });
    const long = "x".repeat(250);
    expect(titleAndBody(long, "T")).toEqual({ title: "x".repeat(200), body: long });
  });
});
