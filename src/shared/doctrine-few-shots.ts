/**
 * Canonical worked examples for the injected doctrine — ONE source of truth.
 *
 * The doctrine's few-shot section renders these payloads verbatim, and the
 * CLI examples catalog (cli/core/discovery.ts) imports the same objects for
 * its matching entries ("claim one", "complete with evidence",
 * "block until answer"). Drift between what the doctrine teaches and what
 * `junto examples show` prints is therefore impossible by
 * construction.
 *
 * Payloads mirror the real schemas (shared/work-control.ts). Keep them small
 * and canonical: they are the copy-paste patterns an agent should internalize.
 */

export type DoctrineFewShotPayload = {
  /** The command word (for display), e.g. "tasks claim". */
  readonly command: string;
  /** Full argv including the JSON argument, e.g. ["tasks", "claim", "{\"target\":\"n7\",...}"]. */
  readonly args: readonly string[];
  /** What the step teaches (one line). */
  readonly lesson: string;
};

/** Claim → progress → complete-with-evidence: the full task lifecycle. */
export const FEW_SHOT_CLAIM: DoctrineFewShotPayload = {
  command: "tasks claim",
  args: ["tasks", "claim", '{"target":"n7","task":"t1"}'],
  lesson: "Claim only unclaimed tasks; the crew queue decides what is available.",
};

export const FEW_SHOT_PROGRESS: DoctrineFewShotPayload = {
  command: "tasks update",
  args: [
    "tasks",
    "update",
    '{"target":"n7","task":"t1","state":"working","note":"first commit in; tests green so far"}',
  ],
  lesson: "Working notes are progress telemetry — say what you did at milestones, not just \"working\".",
};

export const FEW_SHOT_COMPLETE_EVIDENCE: DoctrineFewShotPayload = {
  command: "tasks update",
  args: [
    "tasks",
    "update",
    '{"target":"n7","task":"t1","state":"completed","note":"done","completionEvidence":{"artifacts":[{"artifactId":"a1","nodeId":"art1"}],"git":{"commits":["abc123"]}}}',
  ],
  lesson: "completed is a crew verdict, not a self-declaration — attach evidence first, or the server rejects the transition.",
};

/** Escalate: file a request, block the seat, wait for the operator. */
export const FEW_SHOT_ESCALATE: DoctrineFewShotPayload = {
  command: "escalate",
  args: [
    "escalate",
    '{"target":"req1","brief":"need API key for staging","reason":"cannot continue without operator secret"}',
  ],
  lesson: "Escalating blocks the seat and returns a stop directive — stop work ops until the operator answers.",
};

export const FEW_SHOT_TASK_LIFECYCLE: readonly DoctrineFewShotPayload[] = [
  FEW_SHOT_CLAIM,
  FEW_SHOT_PROGRESS,
  FEW_SHOT_COMPLETE_EVIDENCE,
];
