/**
 * The tasks and artifacts a composer offers after `#` (plan 0.10, 03 section
 * 2): `mention-sources` makes candidates of the nodes in reach, but a task
 * board or an Artifacts node offers only the items it is handed. This reads
 * every task on the canvas and the artifacts of every Artifacts node, and
 * groups them by node; reach then filters which of them are offered.
 *
 * Archived items are left out: an archived task or artifact is not
 * something to point a seat at.
 */
import { useMemo } from "react";
import type { NodeId } from "@shared/physics/schema";
import type { ArtifactHead } from "@shared/resource-ipc";
import type { TaskView } from "@shared/task-model";
import { useCanvasArtifacts } from "./canvas-artifacts";
import type { MentionItem, MentionItems } from "./mention-sources";
import { useCanvasTasks } from "./tasks-source";

const NONE: ReadonlyArray<never> = [];

const grouped = <T>(entries: ReadonlyArray<T>, nodeOf: (entry: T) => NodeId, item: (entry: T) => MentionItem): ReadonlyMap<NodeId, ReadonlyArray<MentionItem>> => {
  const byNode = new Map<NodeId, MentionItem[]>();
  for (const entry of entries) {
    const node = nodeOf(entry);
    const list = byNode.get(node);
    if (list === undefined) byNode.set(node, [item(entry)]);
    else list.push(item(entry));
  }
  return byNode;
};

/** Tasks and artifact heads, by node, as `MentionItems`. Pure. */
export const mentionItemsOf = (tasks: ReadonlyArray<TaskView>, artifacts: ReadonlyArray<ArtifactHead>): MentionItems => {
  const taskItems = grouped(
    tasks.filter((task) => task.current.state !== "archived"),
    (task) => task.current.node as NodeId,
    (task): MentionItem => ({
      id: task.taskId,
      title: task.title,
      ...(task.number === undefined ? {} : { number: task.number }),
      note: task.current.state,
    }),
  );
  const artifactItems = grouped(
    artifacts.filter((head) => !head.artifact.archived),
    (head) => head.artifact.nodeId,
    (head): MentionItem => ({ id: head.artifact.artifactId, title: head.artifact.title }),
  );
  return {
    tasksOf: (nodeId) => taskItems.get(nodeId) ?? NONE,
    artifactsOf: (nodeId) => artifactItems.get(nodeId) ?? NONE,
  };
};

/** The artifacts of every Artifacts node on the canvas, read once for every caller (canvas-artifacts.ts). */
export { useCanvasArtifacts };

/** What `#` may offer on this canvas, for `useResourcesInReach`. */
export const useMentionItems = (canvasName: string): MentionItems => {
  const tasks = useCanvasTasks(canvasName);
  const artifacts = useCanvasArtifacts(canvasName);
  return useMemo(() => mentionItemsOf(tasks, artifacts), [tasks, artifacts]);
};
