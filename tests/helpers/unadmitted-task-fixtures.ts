/**
 * Unadmitted-task factory for unification tests.
 *
 * A real Task in `submitted`, unclaimed, unpromoted. Companion `admission`
 * and `raisedBy` are first-class on Task only after GO — until then they
 * travel beside the task so tests can assert the overlay without editing
 * work-model.ts.
 */

import { PIPELINE_ADMITTED_METADATA_KEY } from "../../src/shared/claims";
import type { ActorRef } from "../../src/shared/work-reference";
import type {
  FinishCriteria,
  Part,
  SinkAdmission,
  Task,
  TaskClaim,
} from "../../src/shared/work-model";

export type UnadmittedTaskParts = {
  readonly id: string;
  readonly brief: string;
  readonly details: string;
  readonly raisedBy?: ActorRef;
  readonly admission?: SinkAdmission;
  readonly holdUntil?: string;
  readonly reason?: string;
  readonly dependsOn?: ReadonlyArray<string>;
  readonly finishCriteria?: FinishCriteria;
  readonly claims?: ReadonlyArray<TaskClaim>;
  readonly media?: ReadonlyArray<Part>;
};

export type UnadmittedTaskFixture = {
  readonly task: Task;
  readonly admission: SinkAdmission;
  readonly raisedBy?: ActorRef;
};

/** Default requested overlay: agent-wire omit => operator-gated. */
export const DEFAULT_UNADMITTED_ADMISSION = "operator-gated" satisfies SinkAdmission;

export const unadmittedTask = (
  parts: UnadmittedTaskParts,
): UnadmittedTaskFixture => {
  const admission = parts.admission ?? DEFAULT_UNADMITTED_ADMISSION;
  const extraParts = parts.media ?? [];
  const task: Task = {
    id: parts.id,
    state: "submitted",
    history: [
      {
        messageId: `${parts.id}-m0`,
        role: "user",
        parts: [{ kind: "text", text: parts.brief }, ...extraParts],
        taskId: parts.id,
        contextId: "test",
      },
    ],
    metadata: { details: parts.details },
    ...(parts.reason !== undefined ? { reason: parts.reason } : {}),
    ...(parts.dependsOn !== undefined && parts.dependsOn.length > 0
      ? { dependsOn: parts.dependsOn }
      : {}),
    ...(parts.finishCriteria !== undefined
      ? { finishCriteria: parts.finishCriteria }
      : {}),
    ...(parts.claims !== undefined && parts.claims.length > 0
      ? { claims: parts.claims }
      : {}),
    ...(parts.holdUntil !== undefined ? { holdUntil: parts.holdUntil } : {}),
    ...(admission !== undefined ? { admission } : {}),
    ...(parts.raisedBy !== undefined ? { raisedBy: parts.raisedBy } : {}),
  };
  return {
    task,
    admission,
    ...(parts.raisedBy !== undefined ? { raisedBy: parts.raisedBy } : {}),
  };
};

export const taskIsUnpromotedSubmitted = (task: Task): boolean =>
  task.state === "submitted" &&
  task.claimedBy === undefined &&
  task.metadata?.[PIPELINE_ADMITTED_METADATA_KEY] === undefined;
