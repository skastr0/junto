import type { Artifact, Task } from "@shared/canvas";
import type { TaskRef } from "@shared/work-reference";
import { isTerminalTaskState, taskBrief } from "@shared/task";

/**
 * Task IDs are sink-local, so a useful artifact label must retain the whole
 * TaskRef rather than presenting the item ID as if it were globally unique.
 */
/**
 * Operator-facing task provenance for an artifact. Returns null when the
 * artifact has no task link — never the word "Unbound" (that read as a
 * failure, not as optional provenance).
 */
export const artifactTaskReferenceLabel = (
  artifact: Artifact,
): string | null =>
  artifact.task === undefined
    ? null
    : `Task #${artifact.task.itemId} - ${artifact.task.sink.canvasName}/${artifact.task.sink.nodeId}`;

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

/** Board/card title convention: authored title, then brief first line. */
export const taskDisplayTitle = (task: Task): string => {
  const title = task.metadata?.title;
  if (typeof title === "string" && title.trim()) return title.trim();
  return taskBrief(task).split(/\r?\n/, 1)[0]?.trim() || "Untitled task";
};

/**
 * Deletion guard for artifacts that feed a task's finish gate. Pure and
 * advisory: resolves the artifact's TaskRef through `resolveTask`, and warns
 * only when an existing nonterminal task gates on artifacts published to this
 * sink and the artifact could actually satisfy that gate — either the gate
 * names no specific artifacts (any artifact on the sink counts) or its
 * `names` list includes this artifact's trimmed name (case-sensitive, the
 * same comparison the finish gate uses).
 *
 * Returns the operator-facing warning text, or null when deletion is
 * unremarkable (no link, missing/terminal task, gate elsewhere, or a named
 * gate this artifact does not match).
 */
export const artifactDeletionWarning = (params: {
  readonly artifact: Artifact;
  /** Node id of the artifacts sink that hosts this artifact. */
  readonly sinkNodeId: string;
  /** Resolve the artifact's TaskRef against the current doc. */
  readonly resolveTask: (ref: TaskRef) => Task | undefined;
}): string | null => {
  const ref = params.artifact.task;
  if (ref === undefined) return null;
  const task = params.resolveTask(ref);
  if (task === undefined || isTerminalTaskState(task.state)) return null;
  const gate = task.finishCriteria?.artifacts;
  if (gate === undefined || gate.nodeId !== params.sinkNodeId) return null;
  const names = gate.names;
  const artifactName = params.artifact.name?.trim();
  if (
    names !== undefined &&
    names.length > 0 &&
    ((artifactName ?? "").length === 0 || !names.includes(artifactName ?? ""))
  ) {
    return null;
  }
  return `This artifact can provide completion evidence for unfinished task “${taskDisplayTitle(task)}”. Deleting it may require publishing and citing a replacement.`;
};
