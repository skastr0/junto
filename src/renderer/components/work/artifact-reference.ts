import type { Artifact } from "@shared/canvas";

/**
 * Task IDs are sink-local, so a useful artifact label must retain the whole
 * TaskRef rather than presenting the item ID as if it were globally unique.
 */
export const artifactTaskReferenceLabel = (
  artifact: Artifact,
): string =>
  artifact.task === undefined
    ? "Unbound output"
    : `Task #${artifact.task.itemId} · ${artifact.task.sink.canvasName}/${artifact.task.sink.nodeId}`;

export const artifactSearchText = (artifact: Artifact): string => {
  const task = artifact.task;
  return [
    artifact.name ?? "",
    artifact.artifactId,
    task?.itemId ?? "",
    task?.sink.canvasName ?? "",
    task?.sink.nodeId ?? "",
    task === undefined
      ? ""
      : `${task.sink.canvasName}/${task.sink.nodeId}`,
  ].join(" ");
};
