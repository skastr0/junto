import { createHash } from "node:crypto";
import { verdictSubjectHashPayload } from "../../../shared/crew";
import { taskEpoch } from "../../../shared/rules";
import type { CompletionEvidence, Task } from "../../../shared/work-model";

/**
 * Canonical subject hash. Every lane derives it here so the gate compares
 * identical bytes; the payload (domain-separated, commit shas normalized) lives
 * in the shared module.
 */
export const subjectHashOf = (
  input:
    | {
        readonly kind: "task";
        readonly installationId: string;
        readonly canvasName: string;
        readonly nodeId: string;
        readonly taskId: string;
        readonly epoch: number;
        readonly commitShas?: ReadonlyArray<string>;
        readonly artifactRefs?: ReadonlyArray<{
          readonly nodeId: string;
          readonly artifactId: string;
        }>;
        readonly claimRefs?: ReadonlyArray<string>;
      }
    | { readonly kind: "commit"; readonly sha: string },
): string =>
  createHash("sha256")
    .update(verdictSubjectHashPayload(input), "utf8")
    .digest("hex");

/** Hash a live task and its stored or prospective completion evidence. */
export const taskReviewSubjectHash = (input: {
  readonly installationId: string;
  readonly canvasName: string;
  readonly nodeId: string;
  readonly task: Task;
  readonly evidenceOverride?: CompletionEvidence;
}): string => {
  const { installationId, canvasName, nodeId, task } = input;
  const evidence = input.evidenceOverride ?? task.completionEvidence;
  const commitShas = (evidence?.git?.commits ?? [])
    .map((sha) => sha.trim().toLowerCase())
    .filter((sha) => sha.length > 0);
  const artifactRefs = (evidence?.artifacts ?? []).map((artifact) => ({
    nodeId: artifact.nodeId,
    artifactId: artifact.artifactId,
  }));
  const claimRefs = (evidence?.claims ?? []).flatMap((claim) =>
    (claim.refs ?? []).map((ref) => ref.trim()),
  );
  return subjectHashOf({
    kind: "task",
    installationId,
    canvasName,
    nodeId,
    taskId: task.id,
    epoch: taskEpoch(task),
    commitShas,
    artifactRefs,
    claimRefs,
  });
};
