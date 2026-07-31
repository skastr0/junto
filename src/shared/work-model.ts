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

/**
 * Shared authoring fields on Task and TaskProposal.
 *
 * Brief/media live on Task.history[0].parts vs TaskProposal.brief.parts;
 * proposal-only extras are proposedBy / approvedTaskId / proposal state
 * (disjoint from executable task state/claim/evidence).
 */
export const TaskAuthoringFields = {
  /**
   * Same-sink hard prerequisites (task ids). Empty / omitted = free to claim
   * when submitted (or free once approved for proposals). Join is ALL; only
   * `completed` satisfies. Soft relates are not modeled here.
   */
  dependsOn: Schema.optionalWith(Schema.Array(Schema.String), {
    exact: true,
  }),
  /** Operator done-definition; immutable on generic task transition. */
  finishCriteria: Schema.optionalWith(FinishCriteria, { exact: true }),
  metadata: Schema.optionalWith(WorkMetadata, { exact: true }),
  /** Why the raiser raised this (first-class, set at creation). */
  reason: Schema.optionalWith(Schema.String, { exact: true }),
} as const;

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
  dependsOn: TaskAuthoringFields.dependsOn,
  finishCriteria: TaskAuthoringFields.finishCriteria,
  /** Stamped only on successful → completed. */
  completionEvidence: Schema.optionalWith(CompletionEvidence, { exact: true }),
  metadata: TaskAuthoringFields.metadata,
  reason: TaskAuthoringFields.reason,
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
 * A proposal is not executable work. Same authoring contract as a task
 * (brief/media, metadata, dependsOn, finishCriteria); only an operator
 * approval mints a submitted Task (`approvedTaskId`).
 */
export const TaskProposal = Schema.Struct({
  id: Schema.String,
  state: TaskProposalState,
  brief: Message,
  proposedBy: ActorRef,
  approvedTaskId: Schema.optionalWith(Schema.String, { exact: true }),
  dependsOn: TaskAuthoringFields.dependsOn,
  finishCriteria: TaskAuthoringFields.finishCriteria,
  metadata: TaskAuthoringFields.metadata,
  reason: TaskAuthoringFields.reason,
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
 * Bulletin-board author. Operator is the Command Center human; actor is a
 * process-bound seat. Never Message.role and never client-supplied freeform.
 */
export const BoardAuthorKind = Schema.Literal("operator", "actor");
export type BoardAuthorKind = typeof BoardAuthorKind.Type;

export const BoardAuthor = Schema.Struct({
  kind: BoardAuthorKind,
  /** Present when kind === "actor". */
  seatId: Schema.optionalWith(ActorSeatId, { exact: true }),
  nodeId: Schema.optionalWith(Schema.String, { exact: true }),
  label: Schema.optionalWith(Schema.String, { exact: true }),
});
export type BoardAuthor = typeof BoardAuthor.Type;

export const BoardTopicState = Schema.Literal("open", "archived");
export type BoardTopicState = typeof BoardTopicState.Type;

/** Append-only post under a topic (Part[] body — not Message). */
export const BoardPost = Schema.Struct({
  postId: Schema.String,
  topicId: Schema.String,
  author: BoardAuthor,
  parts: Schema.Array(Part).pipe(Schema.minItems(1)),
  /** Monotone per-topic position (0-based). */
  position: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  createdAt: Schema.String,
});
export type BoardPost = typeof BoardPost.Type;

/** Topic shell (aggregate root). Posts stream separately or nested for list. */
export const BoardTopic = Schema.Struct({
  topicId: Schema.String,
  title: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(512)),
  state: BoardTopicState,
  openedBy: BoardAuthor,
  openedAt: Schema.String,
  postCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  lastActivityAt: Schema.String,
  /** Opening body as first-class optional parts (also post 0 when present). */
  parts: Schema.optionalWith(Schema.Array(Part), { exact: true }),
  posts: Schema.optionalWith(Schema.Array(BoardPost), { exact: true }),
});
export type BoardTopic = typeof BoardTopic.Type;

/** Board sink contents (full lane at snapshot; ether may strip to glance). */
export const WorkBoard = Schema.Struct({
  topics: Schema.Array(BoardTopic),
});
export type WorkBoard = typeof WorkBoard.Type;

/**
 * Canvas glance strip — titles + counts only. Full posts stay on list/detail.
 */
export const BoardGlanceTopic = Schema.Struct({
  topicId: Schema.String,
  title: Schema.String,
  state: BoardTopicState,
  postCount: Schema.Number,
  lastActivityAt: Schema.String,
  authorLabel: Schema.optionalWith(Schema.String, { exact: true }),
});
export type BoardGlanceTopic = typeof BoardGlanceTopic.Type;

export const EtherBoard = Schema.Struct({
  topics: Schema.Array(BoardGlanceTopic),
  /** Operator-local unread topic count when known. */
  unread: Schema.optionalWith(
    Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
    { exact: true },
  ),
});
export type EtherBoard = typeof EtherBoard.Type;

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
 * SQLite repository joins on. Lanes stay explicit: consumers never decode an
 * opaque per-node payload and never infer a lane from entity kind.
 */
export const WorkSnapshot = Schema.Struct({
  canvasName: Schema.String,
  nodeId: Schema.String,
  tasks: WorkTasks,
  requests: WorkRequests,
  messages: WorkMessages,
  artifacts: WorkArtifacts,
  board: WorkBoard,
});
export type WorkSnapshot = typeof WorkSnapshot.Type;
