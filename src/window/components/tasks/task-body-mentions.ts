import { useCallback, useMemo } from "react";
import type { NodeKind } from "@shared/model/kinds";
import type { NodeId } from "@shared/physics/schema";
import type { TaskId, TaskNodeId, TaskView } from "@shared/task-model";
import type { ArtifactHead } from "@shared/resource-ipc";
import { useNodesArtifacts } from "../../lib/artifacts-source";
import { resourceNodesInReach, useResourcesInReach, useSeatsInReach, type MentionItem } from "../../lib/mention-sources";
import { stateLabel } from "../../lib/task-ui";
import { nodeAt, useCanvas } from "../../lib/use-model";
import type { DocumentMentions } from "../artifacts/LiveMarkdownField";

/**
 * The live artifacts on every Artifacts node in reach, by node. Each node
 * rides its shared read (artifacts-source.ts): an artifact change re-reads
 * only the nodes it names, once for every caller. A node not yet read, or
 * that could not be, is absent.
 */
const useArtifactsInReach = (canvasName: string, from: NodeId): ReadonlyMap<NodeId, ReadonlyArray<ArtifactHead>> => {
  const canvas = useCanvas(canvasName);
  const key = useMemo(
    () => resourceNodesInReach(canvas, from).filter((node) => node.kind === "artifacts").map((node) => node.id).join(","),
    [canvas, from],
  );
  // The same list while the set of nodes holds, so a canvas change that moves nothing in reach reads nothing again.
  const shelves = useMemo(() => (key === "" ? [] : (key.split(",") as NodeId[])), [key]);
  const values = useNodesArtifacts(canvasName, shelves);
  return useMemo(() => {
    const held = new Map<NodeId, ReadonlyArray<ArtifactHead>>();
    shelves.forEach((id, index) => {
      const read = values[index];
      if (read !== undefined && read.confirmed && read.value !== undefined) held.set(id, read.value);
    });
    return held;
  }, [shelves, values]);
};

/**
 * What a task's body may mention, as a document's: @ the seats in reach of
 * its board, # the canvas's other tasks and the artifacts on the Artifacts
 * nodes in reach. The task itself is never offered to itself; a task still
 * being written has no id yet.
 */
export const useTaskBodyMentions = (
  canvasName: string,
  node: TaskNodeId,
  taskId: TaskId | undefined,
  all: ReadonlyArray<TaskView>,
): DocumentMentions => {
  const seats = useSeatsInReach(canvasName, node);
  const shelves = useArtifactsInReach(canvasName, node);
  const tasksOf = useMemo(
    () => (nodeId: NodeId): ReadonlyArray<MentionItem> =>
      all
        .filter((view) => view.current.node === nodeId && view.taskId !== taskId)
        .map((view) => ({
          id: view.taskId,
          title: view.title,
          ...(view.number === undefined ? {} : { number: view.number }),
          note: stateLabel(view.current.state).toLowerCase(),
        })),
    [all, taskId],
  );
  const artifactsOf = useMemo(
    () => (nodeId: NodeId): ReadonlyArray<MentionItem> =>
      (shelves.get(nodeId) ?? [])
        .filter((head) => !head.artifact.archived)
        .map((head) => ({ id: head.artifact.artifactId, title: head.artifact.title })),
    [shelves],
  );
  const resources = useResourcesInReach(canvasName, node, { tasksOf, artifactsOf });
  const nodeKindOf = useCallback((nodeId: NodeId): NodeKind | undefined => nodeAt(canvasName, nodeId)?.kind, [canvasName]);
  return useMemo(() => ({ canvasName, candidates: [...seats, ...resources], nodeKindOf }), [canvasName, seats, resources, nodeKindOf]);
};
