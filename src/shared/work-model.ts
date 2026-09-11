import { Schema } from "effect";
import { ActorSeatId } from "./actor-seat";
import { ActorRef, TaskRef } from "./work-reference";
import { ContentPart } from "./content";

// ContentRef is the portable binary-media contract. RawPart remains in the
// Part union so installed non-Tasks history and the content migration can read
// pre-externalization rows; the product path stores ContentPart.
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

// ---- Task rules, claims, checks, and visits ----

const ruleFields = {
  /** ULID minted at authoring. */
  id: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  text: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
} as const;

/**
 * An operator-authored statement the work must satisfy. The work service
 * enforces that an agent makes a claim for every rule, never that it is true.
 */
export const Rule = Schema.Struct(ruleFields);
export type Rule = typeof Rule.Type;

/** Operator-pinned precedent, appended when an escalation/request resolves. */
export const Ruling = Schema.Struct({
  id: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  text: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  /** ISO timestamp. */
  pinnedAt: Schema.String,
  sourceRequestId: Schema.optionalKey(Schema.String),
});
export type Ruling = typeof Ruling.Type;

/**
 * Deterministic check. The agent's CLI executes `command` in its own
 * environment; exit 0 passes.
 */
export const Check = Schema.Struct({
  /** ULID minted at authoring. */
  id: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  label: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  command: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});
export type Check = typeof Check.Type;

/** A task-authored rule addressed to one board on its path. */
export const TaskRule = Schema.Struct({
  ...ruleFields,
  /** Tasks node id where this rule must be answered or fork-waived. */
  board: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});
export type TaskRule = typeof TaskRule.Type;

/** Who may start a submitted task. Omitted = "auto". */
export const TaskAdmission = Schema.Literals(["auto", "approval", "operator"]);
export type TaskAdmission = typeof TaskAdmission.Type;

export const TasksIncoming = Schema.Struct({
  /** How new tasks should be handled here. */
  handling: Schema.optionalKey(Schema.String),
  /** Prose self-description for earlier boards choosing a path. */
  description: Schema.optionalKey(Schema.String),
  admission: Schema.optionalKey(TaskAdmission),
  /** Board default delay before a task can be claimed. */
  waitMs: Schema.optionalKey(
    Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
  checks: Schema.optionalKey(Schema.Array(Check)),
});
export type TasksIncoming = typeof TasksIncoming.Type;

export const TasksOutgoing = Schema.Struct({
  /** What the agent must write in the handoff note when sending work onward. */
  handoff: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  checks: Schema.optionalKey(Schema.Array(Check)),
});
export type TasksOutgoing = typeof TasksOutgoing.Type;

/**
 * Operator-authored board contract (`ether.tasks.contract`). Agents have no
 * authorial write path to it.
 */
export const TasksContract = Schema.Struct({
  /** Prose agents read when they claim a task here. */
  instructions: Schema.optionalKey(Schema.String),
  rules: Schema.optionalKey(Schema.Array(Rule)),
  incoming: Schema.optionalKey(TasksIncoming),
  outgoing: Schema.optionalKey(TasksOutgoing),
});
export type TasksContract = typeof TasksContract.Type;

/** Resolve admission with product default `auto` when omitted. */
export const resolveTaskAdmission = (
  contract: TasksContract | undefined,
): TaskAdmission => contract?.incoming?.admission ?? "auto";

/** An agent's answer to one rule, recorded at completion. */
export const Claim = Schema.Struct({
  ruleId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  text: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  refs: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type Claim = typeof Claim.Type;

/** A fork waiver for a task rule whose board is no longer reachable. */
export const Waiver = Schema.Struct({
  ruleId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  reason: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});
export type Waiver = typeof Waiver.Type;

/**
 * Agent-supplied proof at complete. Artifacts are explicit citations (no
 * auto-append on publish). Git is expandable (commits first; later repo, etc.).
 * Claims and waivers answer the rules in force for this completion.
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
  claims: Schema.optionalKey(Schema.Array(Claim)),
  waivers: Schema.optionalKey(Schema.Array(Waiver)),
});
export type CompletionEvidence = typeof CompletionEvidence.Type;

/** How a visit ended. */
export const VisitExit = Schema.Literals(["sent-on", "completed", "sent-back"]);
export type VisitExit = typeof VisitExit.Type;

/** One board a task has entered. Append-only. */
export const Visit = Schema.Struct({
  board: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  enteredAt: Schema.String,
  epoch: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  claimedBy: Schema.optionalKey(ActorSeatId),
  exitedAt: Schema.optionalKey(Schema.String),
  exit: Schema.optionalKey(VisitExit),
  /** Destination Tasks node id chosen when sent on. */
  next: Schema.optionalKey(Schema.String),
  handoffNote: Schema.optionalKey(Schema.String),
});
export type Visit = typeof Visit.Type;

/**
 * Append-only defect record: epoch `epoch` was opened by a defect aimed at
 * board `target`. Claims made before the defect at boards strictly
 * upstream of `target` stay live for closure accounting; receipts at or
 * downstream of `target` are shadowed. Waivers never survive any defect.
 * Nothing ever mutates or removes an entry — liveness is derived, not stored.
 */
export const TaskDefect = Schema.Struct({
  epoch: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  /** Tasks node id of the visited board the task was sent back to. */
  target: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  /** ISO timestamp of the defect. */
  at: Schema.String,
});
export type TaskDefect = typeof TaskDefect.Type;

/** Check output tail cap (the check op handler truncates by bytes). */
export const CHECK_OUTPUT_TAIL_MAX_BYTES = 8 * 1024;

export const CheckSide = Schema.Literals(["outgoing", "incoming"]);
export type CheckSide = typeof CheckSide.Type;

/**
 * System-stamped check result. Written only by the `tasks.check` op handler
 * from agent-submitted runs, never accepted from completion evidence.
 */
export const CheckResult = Schema.Struct({
  checkId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  side: CheckSide,
  command: Schema.String,
  exitCode: Schema.Number.pipe(Schema.check(Schema.isInt())),
  outputTail: Schema.String.pipe(Schema.check(Schema.isMaxLength(CHECK_OUTPUT_TAIL_MAX_BYTES))),
  /** ISO timestamp. */
  at: Schema.String,
  epoch: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type CheckResult = typeof CheckResult.Type;

/**
 * Path arm of a task transition: next board, send-back defect, wait, and
 * handoff note.
 * An op argument rather than document data, so it stays a plain type — the
 * main work service and the renderer bridge both spell it from here.
 */
export type TaskPathArm = {
  readonly next?: string;
  readonly defect?: {
    readonly summary: string;
    readonly refs?: ReadonlyArray<string>;
    /** Visited board to send the task back to; omitted = the previous board. */
    readonly target?: string;
  };
  readonly waitForMs?: number;
  readonly handoffNote?: string;
};

/**
 * Shared immutable task-authoring fields. Brief and media live on
 * `Task.history[0].parts`.
 */
export const TaskAuthoringFields = {
  /**
   * Same-board prerequisites (task ids). Empty / omitted = free to claim when
   * submitted and admitted. Join is ALL; only `completed` satisfies.
   */
  dependsOn: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Operator done-definition; immutable on generic task transition. */
  finishCriteria: Schema.optionalKey(FinishCriteria),
  /** Board-addressed rules; set at creation, immutable on generic transitions. */
  rules: Schema.optionalKey(Schema.Array(TaskRule)),
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
  rules: TaskAuthoringFields.rules,
  /** Stamped only on successful → completed. */
  completionEvidence: Schema.optionalKey(CompletionEvidence),
  /** Defect generation counter. Staleness is derived from the defects log: a defect shadows receipts at and downstream of its target. Default 0. */
  epoch: Schema.optionalKey(
    Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
  /** Append-only record of boards entered. */
  visits: Schema.optionalKey(Schema.Array(Visit)),
  /** Append-only defect log; claim liveness is derived, never stored. */
  defects: Schema.optionalKey(Schema.Array(TaskDefect)),
  /** Not claimable before this ISO time. */
  waitUntil: Schema.optionalKey(Schema.String),
  /** Current-epoch check results, stamped only by the check operation. */
  checkResults: Schema.optionalKey(Schema.Array(CheckResult)),
  metadata: TaskAuthoringFields.metadata,
  reason: TaskAuthoringFields.reason,
  /**
   * Requester admission overlay. Omitted = inherit the sink floor
   * (`resolveTaskAdmission`, default auto). Agents persist an explicit
   * `approval` stamp when omitted on the wire. Never loosens the board floor.
   */
  admission: Schema.optionalKey(TaskAdmission),
  /** Who raised this task. Optional; historical rows omit it. */
  raisedBy: Schema.optionalKey(ActorRef),
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

export const Artifact = Schema.Struct({
  artifactId: Schema.String,
  name: Schema.optionalKey(Schema.String),
  parts: Schema.Array(Part),
  task: Schema.optionalKey(TaskRef),
  metadata: Schema.optionalKey(WorkMetadata),
});
export type Artifact = typeof Artifact.Type;

/**
 * Tasks node contents. `name` and `contract` are operator-authored document
 * truth; items are the runtime Work projection.
 */
export const WorkTasks = Schema.Struct({
  items: Schema.Array(Task),
  name: Schema.optionalKey(Schema.String),
  contract: Schema.optionalKey(TasksContract),
});
export type WorkTasks = typeof WorkTasks.Type;

/**
 * Requests sink contents. Requests share the Task state machine. `name` is
 * operator-authored document truth (the sink's stable identity, surviving
 * work ops); items are the runtime Work projection.
 */
export const WorkRequests = Schema.Struct({
  items: Schema.Array(Task),
  name: Schema.optionalKey(Schema.String),
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
  parts: Schema.Array(Part).pipe(Schema.check(Schema.isMinLength(1))),
  /** Monotone per-topic position (0-based). */
  position: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  createdAt: Schema.String,
  /**
   * Optional actor node ids tagged in this post (canvas card ids).
   * Expand-only — historical posts omit. Soft tag-notify uses these.
   */
  tags: Schema.optionalKey(
    Schema.Array(Schema.String.pipe(Schema.check(Schema.isMinLength(1)))),
  ),
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

/**
 * Reader-local projected topic: a topic plus the operator's unread-post count
 * computed at the repository read boundary. Never a fact payload field —
 * actions and immutable results carry plain BoardTopic.
 */
export const BoardTopicView = Schema.Struct({
  ...BoardTopic.fields,
  unreadPostCount: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
});
export type BoardTopicView = typeof BoardTopicView.Type;

/** Board sink contents (full lane at snapshot; ether may strip to glance). */
export const WorkBoard = Schema.Struct({
  topics: Schema.Array(BoardTopicView),
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
  /** Operator's unread posts on this topic (own posts never count). */
  unreadPostCount: Schema.optionalKey(Schema.Number),
});
export type BoardGlanceTopic = typeof BoardGlanceTopic.Type;

export const EtherBoard = Schema.Struct({
  topics: Schema.Array(BoardGlanceTopic),
  /** Operator-local unread post count when known (sum over topics). */
  unread: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
});
export type EtherBoard = typeof EtherBoard.Type;

/** Canvas glance strip — title lives on the text node; counts from SQLite. */
export const EtherPad = Schema.Struct({
  revision: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  shapeCount: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  unreadPinCount: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
});
export type EtherPad = typeof EtherPad.Type;

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
  pad: Schema.optionalKey(EtherPad),
});
export type WorkSnapshot = typeof WorkSnapshot.Type;
