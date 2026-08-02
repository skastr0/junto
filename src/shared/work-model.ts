import { Schema } from "effect";
import { ActorSeatId } from "./actor-seat";
import { ActorRef, TaskRef } from "./work-reference";
import { ContentPart } from "./content";

// ContentRef is the portable binary-media contract. RawPart remains in the
// Part union so installed history and the one-shot content migration can read
// legacy rows; the product path stores ContentPart after externalization.
export {
  ContentAvailability,
  ContentByteLength,
  ContentCorrupt,
  ContentDisplayName,
  ContentIdentity,
  ContentLocalPathProjection,
  ContentMediaType,
  ContentMissing,
  ContentObject,
  ContentPart,
  ContentPathProjection,
  ContentReceipt,
  ContentRef,
  ContentSha256,
  ContentUnavailable,
  ContentTimestamp,
  collectContentRefsFromArtifact,
  collectContentRefsFromMessage,
  collectContentRefsFromParts,
  collectContentRefsFromTask,
  decodeContentPart,
  decodeContentRef,
  isContentPart,
  isVerifiedContentReceipt,
  taskContentIsRunnable,
  taskContentPendingMessage,
  taskContentReadiness,
  unavailableContentResolver,
  type ContentAvailabilityResolver,
  type TaskContentReadiness,
} from "./content";

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
  mediaType: Schema.optionalKey(Schema.String),
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
  mediaType: Schema.optionalKey(Schema.String),
});
export type RawPart = typeof RawPart.Type;

export const Part = Schema.Union([TextPart,
UrlPart,
DataPart,
RawPart,
ContentPart,]);
export type Part = typeof Part.Type;

export const MessageRole = Schema.Literals(["user", "agent"]);
export type MessageRole = typeof MessageRole.Type;

/**
 * A2A-compatible extension values. The record is a typed field on each
 * domain object; repositories must not replace the object itself with an
 * opaque payload column.
 */
export const WorkMetadata = Schema.Record(Schema.String, Schema.Unknown);
export type WorkMetadata = typeof WorkMetadata.Type;

export const Message = Schema.Struct({
  messageId: Schema.String,
  role: MessageRole,
  parts: Schema.Array(Part),
  taskId: Schema.optionalKey(Schema.String),
  contextId: Schema.optionalKey(Schema.String),
  referenceTaskIds: Schema.optionalKey(Schema.Array(Schema.String)),
  metadata: Schema.optionalKey(WorkMetadata),
});
export type Message = typeof Message.Type;

/**
 * Work task states. `auth-required` is residual durable-only: no producer may
 * enter it; decode + heal exits remain for installed rows and event history.
 * Operator escalation is `input-required` or a request.
 *
 * `archived` is operator soft-delete: durable row remains, but board/CLI
 * projections omit it so the task disappears from the sink surface (unlike
 * canceled/rejected/completed which stay in Closed).
 */
export const TaskState = Schema.Literals(["submitted", "working",
"input-required",
"completed",
"canceled",
"failed",
"rejected",
"auth-required",
"archived",]);
export type TaskState = typeof TaskState.Type;

/**
 * Operator-authored done-definition. Optional whole object.
 * Nested presence of artifacts/git arms the corresponding hard gate.
 */
export const FinishCriteria = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  artifacts: Schema.optionalKey(Schema.Struct({
    /** Artifacts sink node id (same canvas ambient). */
    nodeId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    instruction: Schema.optionalKey(Schema.String),
    /** When set, every name must match an evidence artifact.name exactly. */
    names: Schema.optionalKey(Schema.Array(Schema.String)),
  })),
  git: Schema.optionalKey(Schema.Struct({
    minCommits: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  })),
});
export type FinishCriteria = typeof FinishCriteria.Type;

/**
 * Agent-supplied proof at complete. Artifacts are explicit citations (no
 * auto-append on publish). Git is expandable (commits first; later repo, etc.).
 */
export const CompletionEvidence = Schema.Struct({
  artifacts: Schema.Array(
    Schema.Struct({
      artifactId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
      nodeId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    }),
  ),
  git: Schema.optionalKey(Schema.Struct({
    commits: Schema.Array(Schema.String),
  })),
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
  dependsOn: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Operator done-definition; immutable on generic task transition. */
  finishCriteria: Schema.optionalKey(FinishCriteria),
  metadata: Schema.optionalKey(WorkMetadata),
  /** Why the raiser raised this (first-class, set at creation). */
  reason: Schema.optionalKey(Schema.String),
} as const;

export const Task = Schema.Struct({
  id: Schema.String,
  state: TaskState,
  /**
   * First-class claimant identity. Claim is domain state, never an opaque
   * metadata convention.
   */
  claimedBy: Schema.optionalKey(ActorSeatId),
  history: Schema.Array(Message),
  artifactIds: Schema.optionalKey(Schema.Array(Schema.String)),
  dependsOn: TaskAuthoringFields.dependsOn,
  finishCriteria: TaskAuthoringFields.finishCriteria,
  /** Stamped only on successful → completed. */
  completionEvidence: Schema.optionalKey(CompletionEvidence),
  metadata: TaskAuthoringFields.metadata,
  reason: TaskAuthoringFields.reason,
  /** The operator's answer (first-class, stamped on resolve). */
  response: Schema.optionalKey(Schema.String),
}).pipe(
  Schema.check(Schema.makeFilter(({ id, state, claimedBy, metadata, dependsOn, completionEvidence }) => {
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
  })),
);
export type Task = typeof Task.Type;

export const TaskProposalState = Schema.Literals(["pending", "approved",
"rejected",]);
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
  approvedTaskId: Schema.optionalKey(Schema.String),
  dependsOn: TaskAuthoringFields.dependsOn,
  finishCriteria: TaskAuthoringFields.finishCriteria,
  metadata: TaskAuthoringFields.metadata,
  reason: TaskAuthoringFields.reason,
}).pipe(
  Schema.check(Schema.makeFilter(({ state, approvedTaskId }) =>
    (state === "approved") === (approvedTaskId !== undefined) ||
    "approved proposals require approvedTaskId; other proposal states forbid it")),
);
export type TaskProposal = typeof TaskProposal.Type;

export const Artifact = Schema.Struct({
  artifactId: Schema.String,
  name: Schema.optionalKey(Schema.String),
  parts: Schema.Array(Part),
  task: Schema.optionalKey(TaskRef),
  metadata: Schema.optionalKey(WorkMetadata),
});
export type Artifact = typeof Artifact.Type;

/** Tasks sink contents. */
export const WorkTasks = Schema.Struct({
  items: Schema.Array(Task),
  proposals: Schema.optionalKey(Schema.Array(TaskProposal)),
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
export const BoardAuthorKind = Schema.Literals(["operator", "actor"]);
export type BoardAuthorKind = typeof BoardAuthorKind.Type;

export const BoardAuthor = Schema.Struct({
  kind: BoardAuthorKind,
  /** Present when kind === "actor". */
  seatId: Schema.optionalKey(ActorSeatId),
  nodeId: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
});
export type BoardAuthor = typeof BoardAuthor.Type;

export const BoardTopicState = Schema.Literals(["open", "archived"]);
export type BoardTopicState = typeof BoardTopicState.Type;

/** Append-only post under a topic (Part[] body — not Message). */
export const BoardPost = Schema.Struct({
  postId: Schema.String,
  topicId: Schema.String,
  author: BoardAuthor,
  parts: Schema.Array(Part).pipe(Schema.check(Schema.isMinSize(1))),
  /** Monotone per-topic position (0-based). */
  position: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  createdAt: Schema.String,
});
export type BoardPost = typeof BoardPost.Type;

/** Topic shell (aggregate root). Posts stream separately or nested for list. */
export const BoardTopic = Schema.Struct({
  topicId: Schema.String,
  title: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(512))),
  state: BoardTopicState,
  openedBy: BoardAuthor,
  openedAt: Schema.String,
  postCount: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  lastActivityAt: Schema.String,
  /** Opening body as first-class optional parts (also post 0 when present). */
  parts: Schema.optionalKey(Schema.Array(Part)),
  posts: Schema.optionalKey(Schema.Array(BoardPost)),
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
  authorLabel: Schema.optionalKey(Schema.String),
});
export type BoardGlanceTopic = typeof BoardGlanceTopic.Type;

export const EtherBoard = Schema.Struct({
  topics: Schema.Array(BoardGlanceTopic),
  /** Operator-local unread topic count when known. */
  unread: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
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
