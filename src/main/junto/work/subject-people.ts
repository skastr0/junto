/**
 * What main knows of a comment's resource beside the comment (03 section 4):
 * the people told of each comment on it, and the name a thread on it is
 * listed under. A task's are read from the task store; an artifact or a page
 * names its node, and its people wait on the artifact ruler.
 */
import { Effect } from "effect";
import type { Canvas } from "@shared/model";
import { titleOf } from "@shared/model/title";
import type { NodeId } from "@shared/physics/schema";
import { taskName, taskPeopleOf } from "@shared/task-notices";
import type { ResourceSubject } from "@shared/thread-subject";
import type { TaskView } from "@shared/task-model";
import { liveTaskPorts } from "./task-control";

/** The 0.10 task a subject names, or undefined: a task from before the task model, or no task store running. */
const taskViewOf = (board: Canvas, canvasName: string, subject: ResourceSubject): Effect.Effect<TaskView | undefined> =>
  subject.kind !== "task"
    ? Effect.succeed(undefined)
    : liveTaskPorts.find(board, canvasName, { kind: "id", taskId: subject.taskId }).pipe(
        Effect.orElseSucceed((): TaskView | undefined => undefined),
      );

/** The seats told of each comment on the subject: a task's assignee and seat reviewers. */
export const subjectPeopleAt = (board: Canvas, canvasName: string, subject: ResourceSubject): Effect.Effect<ReadonlyArray<NodeId>> =>
  Effect.map(taskViewOf(board, canvasName, subject), (view) => (view === undefined ? [] : taskPeopleOf(view.current)));

/** The name a thread on the subject is listed under: `#42 fix tabs`, or the node's title for an artifact or a page. */
export const subjectNameAt = (board: Canvas, canvasName: string, subject: ResourceSubject): Effect.Effect<string | undefined> =>
  Effect.map(taskViewOf(board, canvasName, subject), (view) => {
    if (view !== undefined) return taskName(view);
    const node = board.nodes.get(subject.nodeId);
    if (node === undefined) return undefined;
    return subject.kind === "artifact" ? `${subject.artifactId} on ${titleOf(node)}` : subject.kind === "page" ? titleOf(node) : undefined;
  });
