/**
 * Pure pending-proposal → unadmitted-task transform.
 *
 * Binding (wave-1 unification): pending proposals are live work and backfill
 * to submitted Tasks at the same id, requested admission operator-gated,
 * unpromoted. Approved rows already have a task (possibly a different id) and
 * are left alone. Rejected proposals stay historical proposal records — never
 * mint a rejected Task.
 *
 * Persistence, schema expand (Task.admission / Task.raisedBy), and boot wiring
 * are not this module. This file has no SQL.
 */

import { PIPELINE_ADMITTED_METADATA_KEY } from "./claims";
import type { ActorRef } from "./work-reference";
import type {
  FinishCriteria,
  Message,
  SinkAdmission,
  Task,
  TaskClaim,
  TaskProposal,
  WorkMetadata,
} from "./work-model";

/** Install-ops ledger id. Completeness lives in install-ops.db, never product rows. */
export const BACKFILL_PENDING_PROPOSALS_V1 = "work.pending-proposals.v1" as const;

/** Requested admission stamped onto every backfilled pending proposal. */
export const PENDING_PROPOSAL_BACKFILL_ADMISSION = "operator-gated" satisfies SinkAdmission;

const PIPELINE_BAG_KEY = "vellum.pipeline";

export type ProposalBackfillState = TaskProposal["state"];

export type BackfillSkipReason =
  | "not-pending"
  | "already-materialized"
  | "approved-has-task"
  | "rejected-historical";

export type ProposalBackfillPlan =
  | { readonly action: "materialize" }
  | { readonly action: "skip"; readonly reason: BackfillSkipReason };

export type PendingProposalSnapshot = {
  readonly id: string;
  readonly state: ProposalBackfillState;
  readonly brief: Message;
  readonly proposedBy: ActorRef;
  readonly approvedTaskId?: string;
  readonly dependsOn?: ReadonlyArray<string>;
  readonly finishCriteria?: FinishCriteria;
  readonly claims?: ReadonlyArray<TaskClaim>;
  readonly metadata?: WorkMetadata;
  readonly reason?: string;
};

/**
 * Companion fields Task cannot carry until GO expands the schema.
 * Persist ports must write these onto the durable task once those fields exist.
 */
export type UnadmittedMaterialization = {
  readonly task: Task;
  readonly admission: typeof PENDING_PROPOSAL_BACKFILL_ADMISSION;
  readonly raisedBy: ActorRef;
};

const isPlainObject = (
  value: unknown,
): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const proposalBackfillTaskKey = (
  canvasName: string,
  nodeId: string,
  id: string,
): string => `${canvasName}\0${nodeId}\0${id}`;

export const planProposalBackfill = (input: {
  readonly state: ProposalBackfillState;
  readonly proposalId: string;
  readonly canvasName: string;
  readonly nodeId: string;
  readonly approvedTaskId?: string;
  readonly existingTaskKeys: ReadonlySet<string>;
}): ProposalBackfillPlan => {
  if (input.state === "rejected") {
    return { action: "skip", reason: "rejected-historical" };
  }
  if (input.state === "approved") {
    return { action: "skip", reason: "approved-has-task" };
  }
  if (input.state !== "pending") {
    return { action: "skip", reason: "not-pending" };
  }
  const key = proposalBackfillTaskKey(
    input.canvasName,
    input.nodeId,
    input.proposalId,
  );
  if (input.existingTaskKeys.has(key)) {
    return { action: "skip", reason: "already-materialized" };
  }
  void input.approvedTaskId;
  return { action: "materialize" };
};

const isTaskClaim = (value: unknown): value is TaskClaim => {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.text === "string" &&
    value.text.trim().length > 0 &&
    (value.severity === "hard" || value.severity === "soft") &&
    typeof value.station === "string" &&
    value.station.trim().length > 0
  );
};

const claimsFromUnknown = (
  value: unknown,
): ReadonlyArray<TaskClaim> | undefined => {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every(isTaskClaim)) return undefined;
  return value;
};

const looksLikeProposalSnapshot = (value: Record<string, unknown>): boolean =>
  isPlainObject(value.brief) ||
  isPlainObject(value.proposedBy) ||
  typeof value.id === "string";

const findProposalObject = (value: unknown, depth = 0): Record<string, unknown> | undefined => {
  if (depth > 6 || value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findProposalObject(entry, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (isPlainObject(record.proposal) && looksLikeProposalSnapshot(record.proposal)) {
    return record.proposal;
  }
  if (looksLikeProposalSnapshot(record) && (record.brief !== undefined || record.proposedBy !== undefined)) {
    return record;
  }
  for (const child of Object.values(record)) {
    const found = findProposalObject(child, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
};

/**
 * Claims on TaskProposal never landed in SQLite projection columns.
 * Recover them from the immutable proposal.create record_json, if present.
 */
export const recoverClaimsFromProposalRecordJson = (
  recordJson: unknown,
): ReadonlyArray<TaskClaim> | undefined => {
  const parsed =
    typeof recordJson === "string"
      ? (() => {
          try {
            return JSON.parse(recordJson) as unknown;
          } catch {
            return undefined;
          }
        })()
      : recordJson;
  if (parsed === undefined) return undefined;
  const proposal = findProposalObject(parsed);
  return claimsFromUnknown(proposal?.claims);
};

const stripReservedPipelineMetadata = (
  metadata: WorkMetadata | undefined,
): WorkMetadata | undefined => {
  if (metadata === undefined) return undefined;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === PIPELINE_BAG_KEY || key === PIPELINE_ADMITTED_METADATA_KEY) continue;
    next[key] = value;
  }
  return Object.keys(next).length > 0 ? (next as WorkMetadata) : undefined;
};

const asBrief = (brief: Message, taskId: string): Message => ({
  ...brief,
  taskId,
});

/**
 * Pending proposal → submitted unclaimed Task at the same id.
 * No admittedEpoch. No holdUntil (origin bake is create-path, not backfill).
 * Companion admission is always operator-gated. raisedBy is proposedBy.
 */
export const materializePendingProposal = (input: {
  readonly proposal: PendingProposalSnapshot;
  readonly claimsFromRecord?: ReadonlyArray<TaskClaim>;
}): UnadmittedMaterialization => {
  if (input.proposal.state !== "pending") {
    throw new Error(
      `materializePendingProposal requires pending, got ${input.proposal.state}`,
    );
  }
  const claims =
    input.proposal.claims !== undefined && input.proposal.claims.length > 0
      ? input.proposal.claims
      : input.claimsFromRecord;
  const metadata = stripReservedPipelineMetadata(input.proposal.metadata);
  const task: Task = {
    id: input.proposal.id,
    state: "submitted",
    history: [asBrief(input.proposal.brief, input.proposal.id)],
    ...(metadata !== undefined ? { metadata } : {}),
    ...(input.proposal.reason !== undefined ? { reason: input.proposal.reason } : {}),
    ...(input.proposal.dependsOn !== undefined && input.proposal.dependsOn.length > 0
      ? { dependsOn: input.proposal.dependsOn }
      : {}),
    ...(input.proposal.finishCriteria !== undefined
      ? { finishCriteria: input.proposal.finishCriteria }
      : {}),
    ...(claims !== undefined && claims.length > 0 ? { claims } : {}),
  };
  return {
    task,
    admission: PENDING_PROPOSAL_BACKFILL_ADMISSION,
    raisedBy: input.proposal.proposedBy,
  };
};
