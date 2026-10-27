import { useCallback, useEffect, useMemo, useState } from "react";
import type { NodeKind } from "@shared/model/kinds";
import type { NodeId } from "@shared/physics/schema";
import type { TaskId, TaskNodeId, TaskView } from "@shared/task-model";
import type { ArtifactHead } from "@shared/resource-ipc";
import { artifactsSource } from "../../lib/artifacts-source";
import { resourceNodesInReach, useResourcesInReach, useSeatsInReach, type MentionItem } from "../../lib/mention-sources";
import { stateLabel } from "../../lib/task-ui";
import { nodeAt, useCanvas } from "../../lib/use-model";
import type { DocumentMentions } from "../artifacts/LiveMarkdownField";

/** The live artifacts on every Artifacts node in reach, by node, read again on every artifact change on the canvas. */
const useArtifactsInReach = (canvasName: string, from: NodeId): ReadonlyMap<NodeId, ReadonlyArray<ArtifactHead>> => {
  const canvas = useCanvas(canvasName);
  const shelves = useMemo(
    () => resourceNodesInReach(canvas, from).filter((node) => node.kind === "artifacts").map((node) => node.id),
    [canvas, from],
  );
  const key = shelves.join(",");
  const [held, setHeld] = useState<ReadonlyMap<NodeId, ReadonlyArray<ArtifactHead>>>(new Map());
  useEffect(() => {
    if (shelves.length === 0) {
      setHeld(new Map());
      return;
    }
    let live = true;
    let generation = 0;
    const refresh = (): void => {
      const mine = ++generation;
      void Promise.all(shelves.map(async (id) => [id, await artifactsSource().list(canvasName, id)] as const)).then(
        (lists) => {
          if (live && mine === generation) setHeld(new Map(lists));
        },
        () => undefined,
      );
    };
    refresh();
    const unsubscribe = artifactsSource().onChanged((changed) => {
      if (changed.canvasName === canvasName) refresh();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [canvasName, key]);
  return held;
};

/**
 * What a task's body may mention, as a document's: @ the seats in reach of
 * its board, # the canvas's other tasks and the artifacts on the Artifacts
 * nodes in reach. The task itself is never offered to itself.
 */
export const useTaskBodyMentions = (
  canvasName: string,
  node: TaskNodeId,
  taskId: TaskId,
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
