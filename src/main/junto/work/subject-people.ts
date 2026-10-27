/**
 * What main knows of a comment's resource beside the comment (03 section 4):
 * the people told of each comment on it, and the name a thread on it is
 * listed under. A task's are read from the task store; an artifact or a page
 * names its node, and its people wait on the artifact ruler.
 */
import { Effect } from "effect";
import type { Canvas, Node } from "@shared/model";
import { titleOf } from "@shared/model/title";
import type { NodeId } from "@shared/physics/schema";
import { taskName, taskPeopleOf } from "@shared/task-notices";
import type { ResourceSubject } from "@shared/thread-subject";
import { taskNodeId, type TaskView } from "@shared/task-model";
import type { WorkErrorBody } from "@shared/work-control";
import { liveTaskPorts } from "./task-control";

/** The 0.10 task a subject names, or undefined: a task from before the task model, or no task store running. */
const taskViewOf = (board: Canvas, canvasName: string, subject: ResourceSubject): Effect.Effect<TaskView | undefined> =>
  subject.kind !== "task"
    ? Effect.succeed(undefined)
    : liveTaskPorts.find(board, canvasName, { kind: "id", taskId: subject.taskId }).pipe(
        Effect.orElseSucceed((): TaskView | undefined => undefined),
      );

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
const subjectNodeName = (node: Node): string =>
  node.kind === "files" ? (node.label === undefined || node.label.trim() === "" ? "files" : node.label.trim()) : titleOf(node);

export const subjectNameAt = (board: Canvas, canvasName: string, subject: ResourceSubject): Effect.Effect<string | undefined> =>
  Effect.map(taskViewOf(board, canvasName, subject), (view) => {
    if (view !== undefined) return taskName(view);
    const node = board.nodes.get(subject.nodeId);
    if (node === undefined) return undefined;
    return subject.kind === "artifact"
      ? `${subject.artifactId} on ${subjectNodeName(node)}`
      : subject.kind === "page"
        ? subjectNodeName(node)
        : subject.kind === "file"
          ? `${subject.path} in ${subjectNodeName(node)}`
          : undefined;
  });
