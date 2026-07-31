import { Schema } from "effect";
import { ActorSeatId } from "./actor-seat";
import { ActorRef, TaskRef } from "./work-reference";

/**
 * Durable work-domain contracts.
 *
 * These schemas define the values stored in normalized SQLite work rows and
 * assembled into runtime projections. Storage location and single-home
 * routing remain repository concerns rather than fields on each component.
 */

export const TextPart = Schema.Struct({
  kind: Schema.Literal("text"),
  text: Schema.String,
});
export type TextPart = typeof TextPart.Type;

export const UrlPart = Schema.Struct({
  kind: Schema.Literal("url"),
  url: Schema.String,
  mediaType: Schema.optionalWith(Schema.String, { exact: true }),
});
export type UrlPart = typeof UrlPart.Type;

export const DataPart = Schema.Struct({
  kind: Schema.Literal("data"),
  data: Schema.Unknown,
});
export type DataPart = typeof DataPart.Type;

export const RawPart = Schema.Struct({
  kind: Schema.Literal("raw"),
  bytesBase64: Schema.String,
  mediaType: Schema.optionalWith(Schema.String, { exact: true }),
});
export type RawPart = typeof RawPart.Type;

export const Part = Schema.Union(TextPart, UrlPart, DataPart, RawPart);
export type Part = typeof Part.Type;

export const MessageRole = Schema.Literal("user", "agent");
export type MessageRole = typeof MessageRole.Type;

/**
 * A2A-compatible extension values. The record is a typed field on each
 * domain object; repositories must not replace the object itself with an
 * opaque payload column.
 */
export const WorkMetadata = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});
export type WorkMetadata = typeof WorkMetadata.Type;

export const Message = Schema.Struct({
  messageId: Schema.String,
  role: MessageRole,
  parts: Schema.Array(Part),
  taskId: Schema.optionalWith(Schema.String, { exact: true }),
  contextId: Schema.optionalWith(Schema.String, { exact: true }),
  referenceTaskIds: Schema.optionalWith(Schema.Array(Schema.String), {
    exact: true,
  }),
  metadata: Schema.optionalWith(WorkMetadata, { exact: true }),
});
export type Message = typeof Message.Type;

/**
 * Work task states. `auth-required` is residual durable-only: no producer may
 * enter it; decode + heal exits remain for installed rows and event history.
 * Operator escalation is `input-required` or a request.
 */
export const TaskState = Schema.Literal(
  "submitted",
  "working",
  "input-required",
  "completed",
  "canceled",
  "failed",
  "rejected",
  "auth-required",
);
export type TaskState = typeof TaskState.Type;

/**
 * Operator-authored done-definition. Optional whole object.
 * Nested presence of artifacts/git arms the corresponding hard gate.
 */
export const FinishCriteria = Schema.Struct({
  description: Schema.optionalWith(Schema.String, { exact: true }),
  artifacts: Schema.optionalWith(
    Schema.Struct({
      /** Artifacts sink node id (same canvas ambient). */
      nodeId: Schema.String.pipe(Schema.minLength(1)),
      instruction: Schema.optionalWith(Schema.String, { exact: true }),
      /** When set, every name must match an evidence artifact.name exactly. */
      names: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
    }),
    { exact: true },
  ),
  git: Schema.optionalWith(
    Schema.Struct({
      minCommits: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
    }),
    { exact: true },
  ),
});
export type FinishCriteria = typeof FinishCriteria.Type;

/**
 * Agent-supplied proof at complete. Artifacts are explicit citations (no
 * auto-append on publish). Git is expandable (commits first; later repo, etc.).
 */
export const CompletionEvidence = Schema.Struct({
  artifacts: Schema.Array(
    Schema.Struct({
      artifactId: Schema.String.pipe(Schema.minLength(1)),
      nodeId: Schema.String.pipe(Schema.minLength(1)),
    }),
  ),
  git: Schema.optionalWith(
    Schema.Struct({
      commits: Schema.Array(Schema.String),
    }),
    { exact: true },
  ),
});
export type CompletionEvidence = typeof CompletionEvidence.Type;

export const Task = Schema.Struct({
  id: Schema.String,
  state: TaskState,
  /**
   * First-class claimant identity. Claim is domain state, never an opaque
   * metadata convention.
   */
  claimedBy: Schema.optionalWith(ActorSeatId, { exact: true }),
  history: Schema.Array(Message),
  artifactIds: Schema.optionalWith(Schema.Array(Schema.String), {
    exact: true,
  }),
  /**
   * Same-sink hard prerequisites (task ids). Empty / omitted = free to claim
   * when submitted. Join is ALL; only `completed` satisfies. Soft relates are
   * not modeled here — use history / artifacts for context links.
   */
  dependsOn: Schema.optionalWith(Schema.Array(Schema.String), {
    exact: true,
  }),
  /** Operator done-definition; immutable on generic transition. */
  finishCriteria: Schema.optionalWith(FinishCriteria, { exact: true }),
  /** Stamped only on successful → completed. */
  completionEvidence: Schema.optionalWith(CompletionEvidence, { exact: true }),
  metadata: Schema.optionalWith(WorkMetadata, { exact: true }),
  /** Why the raiser raised this (first-class, set at creation). */
  reason: Schema.optionalWith(Schema.String, { exact: true }),
  /** The operator's answer (first-class, stamped on resolve). */
  response: Schema.optionalWith(Schema.String, { exact: true }),
}).pipe(
  Schema.filter(({ id, state, claimedBy, metadata, dependsOn, completionEvidence }) => {
    if (
      metadata !== undefined &&
      Object.prototype.hasOwnProperty.call(metadata, "claimedBy")
    ) {
      return "metadata.claimedBy is retired; use Task.claimedBy";
    }
    if (state === "submitted" && claimedBy !== undefined) {
      return "submitted tasks must be unclaimed";
    }
    if (
      (state === "working" ||
        state === "input-required" ||
        state === "auth-required") &&
      claimedBy === undefined
    ) {
      return `${state} tasks require claimedBy`;
    }
    if (completionEvidence !== undefined && state !== "completed") {
      return "completionEvidence is only valid on completed tasks";
    }
    if (dependsOn !== undefined) {
      const seen = new Set<string>();
      for (const dep of dependsOn) {
        if (typeof dep !== "string" || dep.trim().length === 0) {
          return "dependsOn entries must be non-empty task ids";
        }
        if (dep === id) return "dependsOn cannot include the task itself";
        if (seen.has(dep)) return "dependsOn must not contain duplicates";
        seen.add(dep);
      }
    }
    return true;
  }),
);
export type Task = typeof Task.Type;

export const TaskProposalState = Schema.Literal(
  "pending",
  "approved",
  "rejected",
);
export type TaskProposalState = typeof TaskProposalState.Type;

/**
 * A proposal is not executable work. Only an operator-approved proposal may
 * mint a submitted Task, recorded by `approvedTaskId`.
 */
export const TaskProposal = Schema.Struct({
  id: Schema.String,
  state: TaskProposalState,
  brief: Message,
  proposedBy: ActorRef,
  approvedTaskId: Schema.optionalWith(Schema.String, { exact: true }),
  metadata: Schema.optionalWith(WorkMetadata, { exact: true }),
  reason: Schema.optionalWith(Schema.String, { exact: true }),
}).pipe(
  Schema.filter(({ state, approvedTaskId }) =>
    (state === "approved") === (approvedTaskId !== undefined) ||
    "approved proposals require approvedTaskId; other proposal states forbid it"
  ),
);
export type TaskProposal = typeof TaskProposal.Type;

export const Artifact = Schema.Struct({
  artifactId: Schema.String,
  name: Schema.optionalWith(Schema.String, { exact: true }),
  parts: Schema.Array(Part),
  task: Schema.optionalWith(TaskRef, { exact: true }),
  metadata: Schema.optionalWith(WorkMetadata, { exact: true }),
});
export type Artifact = typeof Artifact.Type;

/** Tasks sink contents. */
export const WorkTasks = Schema.Struct({
  items: Schema.Array(Task),
  proposals: Schema.optionalWith(Schema.Array(TaskProposal), {
    exact: true,
  }),
});
export type WorkTasks = typeof WorkTasks.Type;

/** Requests sink contents. Requests share the Task state machine. */
export const WorkRequests = Schema.Struct({
  items: Schema.Array(Task),
});
export type WorkRequests = typeof WorkRequests.Type;

/** Artifact sink contents. */
export const WorkArtifacts = Schema.Struct({
  items: Schema.Array(Artifact),
});
export type WorkArtifacts = typeof WorkArtifacts.Type;

/** Per-actor mailbox contents. */
export const WorkMessages = Schema.Struct({
  items: Schema.Array(Message),
});
export type WorkMessages = typeof WorkMessages.Type;

/**
 * Canonical work-lane values exposed at the runtime projection boundary.
 * These names identify projected lane contents; they are not document
 * durability or a second persistence model.
 */
export const EtherTasks = WorkTasks;
export type EtherTasks = WorkTasks;

export const EtherRequests = WorkRequests;
export type EtherRequests = WorkRequests;

export const EtherArtifacts = WorkArtifacts;
export type EtherArtifacts = WorkArtifacts;

export const EtherMessages = WorkMessages;
export type EtherMessages = WorkMessages;

/**
 * One immutable work read model, addressed by the same composite identity the
 * SQLite repository joins on. The four lanes stay explicit: consumers never
 * decode an opaque per-node payload and never infer a lane from entity kind.
 */
export const WorkSnapshot = Schema.Struct({
  canvasName: Schema.String,
  nodeId: Schema.String,
  tasks: WorkTasks,
  requests: WorkRequests,
  messages: WorkMessages,
  artifacts: WorkArtifacts,
});
export type WorkSnapshot = typeof WorkSnapshot.Type;
