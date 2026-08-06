/**
 * Factory claim pulse text — the complete CLI work packet delivered to a
 * managed seat when a task becomes `working` on that actor.
 *
 * Law: an agent that only reads this string must be able to form a valid
 * `vellum-command tasks list` / `vellum-command tasks update` without schema discovery.
 * Claim delivery must never gate on a prior `/compact` harness turn.
 */

import type { Task } from "./work-model";
import { taskBrief, taskMediaParts } from "./task";

export type FactoryClaimPromptInput = {
  /** Task sink node id on the canvas (CLI `target`). */
  readonly sinkNodeId: string;
  readonly task: Task;
};

/**
 * Build the managed-terminal claim prompt for one working task.
 * Pure — no I/O; kernel delivery is the only caller in production.
 */
export const buildFactoryClaimPrompt = (
  input: FactoryClaimPromptInput,
): string => {
  const { sinkNodeId, task } = input;
  const brief = taskBrief(task);
  const listExample = `vellum-command tasks list '{"target":"${sinkNodeId}"}'`;
  const updateExample = `vellum-command tasks update '{"target":"${sinkNodeId}","task":"${task.id}","state":"completed","note":"<what you did>"}'`;
  const workingExample = `vellum-command tasks update '{"target":"${sinkNodeId}","task":"${task.id}","state":"working","note":"<progress>"}'`;

  const media = taskMediaParts(task);
  const mediaNote =
    media.length === 0
      ? []
      : [
          "",
          `This task includes ${media.length} first-class media attachment${media.length === 1 ? "" : "s"} (${media.map((part) => part.mediaType ?? "raw").join(", ")}) on history[0] as raw parts.`,
          `Inspect via ${listExample} (bytesBase64 + mediaType travel with the projected claim — no host path).`,
        ];

  const criteria = task.finishCriteria;
  const criteriaNote: string[] = [];
  if (criteria !== undefined) {
    criteriaNote.push("", "Finish criteria (hard gate on complete):");
    if (criteria.description) {
      criteriaNote.push(`- description: ${criteria.description}`);
    }
    if (criteria.artifacts) {
      criteriaNote.push(
        `- artifacts required on node "${criteria.artifacts.nodeId}"` +
          (criteria.artifacts.instruction
            ? ` — ${criteria.artifacts.instruction}`
            : "") +
          (criteria.artifacts.names && criteria.artifacts.names.length > 0
            ? ` (exact names: ${criteria.artifacts.names.join(", ")})`
            : ""),
        '  Publish with task linkage, then complete with completionEvidence.artifacts: [{ artifactId, nodeId }].',
      );
    }
    if (criteria.git) {
      criteriaNote.push(
        `- git: at least ${criteria.git.minCommits} commit(s)`,
        '  Complete with completionEvidence.git.commits: ["<sha>", ...].',
      );
    }
  }

  const packet = {
    sinkTarget: sinkNodeId,
    taskId: task.id,
    state: task.state,
    brief,
    ...(criteria !== undefined ? { finishCriteria: criteria } : {}),
    ...(task.metadata !== undefined ? { metadata: task.metadata } : {}),
    mediaCount: media.length,
  };

  return [
    `[factory claim] task ${task.id}: ${brief}`,
    "",
    "You claimed this task from the factory pull queue.",
    `Sink target (tasks node id): ${sinkNodeId}`,
    `Task id: ${task.id}`,
    "",
    "CLI contract (copy-paste JSON — do not invent flags):",
    `- orient:  vellum-command onboard`,
    `- list:    ${listExample}`,
    `- progress:${workingExample}`,
    `- complete:${updateExample}`,
    "- blocked: vellum-command escalate  (JSON per `vellum-command schema show request.escalate` / examples)",
    "",
    "You can start from the task packet below; list is optional once you have target + task id.",
    ...mediaNote,
    ...criteriaNote,
    "",
    "--- task packet (JSON) ---",
    JSON.stringify(packet, null, 2),
  ].join("\n");
};
