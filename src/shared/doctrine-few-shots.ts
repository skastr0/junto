/**
 * Canonical worked examples for the doctrine — ONE source of truth.
 *
 * The doctrine's few-shot section renders these payloads verbatim, and the
 * CLI examples catalog (cli/core/discovery.ts) imports the same objects for
 * its matching entries (such as "blocked on the operator"). Drift between what the doctrine teaches and what
 * `junto examples show` prints is therefore impossible by
 * construction.
 *
 * Payloads mirror the real schemas (shared/work-control.ts). Keep them small
 * and canonical: they are the copy-paste patterns an agent should internalize.
 */

export type DoctrineFewShotPayload = {
  /** The command word (for display), e.g. "task start". */
  readonly command: string;
  /** Full argv, e.g. ["task", "start", "#42"]. */
  readonly args: readonly string[];
  /** What the step teaches (one line). */
  readonly lesson: string;
};

/** Start, progress, finish: the task lifecycle for the seat it is assigned to. */
export const FEW_SHOT_START: DoctrineFewShotPayload = {
  command: "task start",
  args: ["task", "start", "#42"],
  lesson: "Start the task assigned to you; an operator or a lead assigns, and the notice arrives as mail in the task's thread.",
};

export const FEW_SHOT_PROGRESS: DoctrineFewShotPayload = {
  command: "task comment",
  args: ["task", "comment", "#42", "first commit in; tests green so far"],
  lesson: "Progress goes in the task's thread: say what you did at milestones, not just \"working\".",
};

export const FEW_SHOT_FINISH: DoctrineFewShotPayload = {
  command: "task finish",
  args: ["task", "finish", "#42"],
  lesson: "finish moves the task to in-review while it waits on stamps, then done or on to the next node; a refusal names what is missing.",
};

/** Blocked: declare the stop on the operator, then wait for the answer. */
export const FEW_SHOT_BLOCKED: DoctrineFewShotPayload = {
  command: "blocked",
  args: [
    "blocked",
    "Need the staging API key to run the deploy check.",
    "--detail",
    "Tried the vault path in the README; it is empty. Nothing else is left without it.",
  ],
  lesson: "One sentence says what you need; --detail says why. Stop and wait: the answer arrives as operator mail.",
};

export const FEW_SHOT_TASK_LIFECYCLE: readonly DoctrineFewShotPayload[] = [
  FEW_SHOT_START,
  FEW_SHOT_PROGRESS,
  FEW_SHOT_FINISH,
];
