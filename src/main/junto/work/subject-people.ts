/**
 * What main knows of a comment's resource beside the comment (03 section 4):
 * the people told of each comment on it, and the name a thread on it is
 * listed under. A task's people are read from the task store, and its name
 * from the task's own row, held per task version; an artifact or a page names
 * its node, and its people wait on the artifact ruler.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Canvas, Files, Node } from "@shared/model";
import { titleOf } from "@shared/model/title";
import type { NodeId } from "@shared/physics/schema";
import { taskName, taskPeopleOf } from "@shared/task-notices";
import type { ResourceSubject } from "@shared/thread-subject";
import { taskNodeId, taskNumber } from "@shared/task-model";
import type { WorkErrorBody } from "@shared/work-control";
import { liveTaskPorts } from "./task-control";

/**
 * The seats told of each comment on the subject: a task's assignee and seat
 * reviewers. A task subject is admitted only when its task is held at the
 * subject's node: reach is checked against that node, so a task on another
 * node, or an id no task holds, is refused alike, never named.
 */
export const subjectPeopleAt = (board: Canvas, canvasName: string, subject: ResourceSubject): Effect.Effect<ReadonlyArray<NodeId>, WorkErrorBody> =>
  subject.kind !== "task"
    ? Effect.succeed([])
    : Effect.flatMap(liveTaskPorts.find(board, canvasName, { kind: "id", taskId: subject.taskId }), (view) =>
      view === undefined || view.current.node !== taskNodeId(subject.nodeId)
        ? Effect.fail<WorkErrorBody>({
          type: "UnknownTarget",
          message: `no task "${subject.taskId}" on "${subject.nodeId}"`,
          details: { path: "taskId", target: subject.taskId, retryable: false, next_step: "name a task on that node: junto task list" },
        })
        : Effect.succeed(taskPeopleOf(view.current)));

/**
 * The name a thread on the subject is listed under: `#42 fix tabs`, or the
 * node's title for an artifact or a page, or the path in it for a file. A
 * Files node is named by its label, else the word "files": never its root,
 * whose last segment is part of the path a thread already names
 * (remote-lead, 0.11 F7), and never on a machine that holds only a stub.
 */
const subjectNodeName = (node: Node): string => (node.kind === "files" ? filesNodeName(node) : titleOf(node));

/** A Files node's public name: its label, else "files" (see subjectNodeName). */
export const filesNodeName = (node: Pick<Files, "label">): string =>
  node.label === undefined || node.label.trim() === "" ? "files" : node.label.trim();

/** The columns a task's thread is named from, and the version they were read at. */
const TASK_NAME_COLUMNS = `task_id, number, title, updated_at`;

type TaskNameRow = { readonly task_id: string; readonly number: number; readonly title: string; readonly updated_at: number };

/** A task's name as held (absent when no task row holds it), and the epoch it was read at. */
type HeldTaskName = { readonly epoch: number; readonly name: string | undefined };

type NamesHeld = {
  /** The canvas these names were read from: another board is other tasks. */
  readonly board: Canvas;
  readonly epoch: number;
  readonly tasks: Map<string, HeldTaskName>;
};

/** Task writes heard per canvas (the store announces them): any may move a name. */
const taskEpochs = new Map<string, number>();
liveTaskPorts.changes((canvasName) => taskEpochs.set(canvasName, (taskEpochs.get(canvasName) ?? 0) + 1));

const namesHeld = new Map<string, NamesHeld>();

const namesHeldFor = (canvasName: string, board: Canvas): NamesHeld => {
  const epoch = taskEpochs.get(canvasName) ?? 0;
  const was = namesHeld.get(canvasName);
  if (was !== undefined && was.board === board && was.epoch === epoch) return was;
  // Names of tasks already read stay warm across an epoch; a board change is another store's tasks.
  const next: NamesHeld = { board, epoch, tasks: was?.board === board ? was.tasks : new Map() };
  namesHeld.set(canvasName, next);
  return next;
};

const readTaskNames = (canvasName: string, taskIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<TaskNameRow>`
      SELECT ${sql.literal(TASK_NAME_COLUMNS)} FROM task_heads
      WHERE canvas_name = ${canvasName} AND ${sql.in("task_id", taskIds)}`;
  });

/** The name a node gives a subject, read from the canvas: no store, no query. */
const nodeNameOf = (board: Canvas, subject: ResourceSubject): string | undefined => {
  if (subject.kind === "task") return undefined;
  const node = board.nodes.get(subject.nodeId);
  if (node === undefined) return undefined;
  return subject.kind === "artifact"
    ? `${subject.artifactId} on ${subjectNodeName(node)}`
    : subject.kind === "page"
      ? subjectNodeName(node)
      : subject.kind === "file"
        ? `${subject.path} in ${subjectNodeName(node)}`
        : undefined;
};

/**
 * The names of the subjects a read is about to list, by subject key. Only the
 * subjects asked for are read, in one statement however many they are, and
 * only those whose task moved since the last read; a store that cannot be
 * read leaves every name out, so a thread falls back to its subject's label.
 */
export const subjectNamesAt = (
  board: Canvas,
  canvasName: string,
  subjects: ReadonlyArray<readonly [string, ResourceSubject]>,
): Effect.Effect<ReadonlyMap<string, string>, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const held = namesHeldFor(canvasName, board);
    const names = new Map<string, string>();
    const tasks: Array<readonly [string, Extract<ResourceSubject, { kind: "task" }>]> = [];
    for (const [key, subject] of subjects) {
      if (subject.kind === "task") tasks.push([key, subject]);
      else {
        const name = nodeNameOf(board, subject);
        if (name !== undefined) names.set(key, name);
      }
    }
    if (tasks.length > 0) {
      const moved = [...new Set(tasks.filter(([, task]) => held.tasks.get(task.taskId)?.epoch !== held.epoch).map(([, task]) => task.taskId))];
      if (moved.length > 0) {
        const rows = yield* readTaskNames(canvasName, moved).pipe(Effect.orElseSucceed((): ReadonlyArray<TaskNameRow> => []));
        const found = new Set(rows.map((row) => row.task_id));
        for (const row of rows) {
          held.tasks.set(row.task_id, { epoch: held.epoch, name: taskName({ number: taskNumber(row.number), title: row.title }) });
        }
        // A task with no row has no name at this epoch: held as absent, so it is not asked for again.
        for (const taskId of moved) if (!found.has(taskId)) held.tasks.set(taskId, { epoch: held.epoch, name: undefined });
      }
      for (const [key, task] of tasks) {
        const name = held.tasks.get(task.taskId)?.name;
        if (name !== undefined) names.set(key, name);
      }
    }
    return names;
  });
