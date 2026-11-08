/**
 * The renderer's resource source over IPC (plan 0.10/04 and 05): tasks and
 * artifacts read from main's stores and written through main's ruler, the
 * same path the CLI takes. One pattern for both domains, so a pane's source
 * swaps its local stand-in for main's without changing shape.
 *
 * Every write is the operator's. The renderer mints the item id on create and
 * the opId for each command, so a resend after a lost answer is the same
 * command and the ruler answers it from its stored ruling. Main builds the
 * `ResourceCommand` (actor operator, no basis, no after) and submits it.
 *
 * Channels are named here; payloads are decoded in main against the schemas
 * below, with excess keys refused. A task command travels as the model's own
 * `TaskCommandWire` and main narrows it with `checkTaskCommand` against the
 * canvas, as the ruler does for every writer.
 */
import { Schema } from "effect";
import { ActorSeatId } from "./actor-seat";
import {
  Artifact,
  ArtifactBody,
  ArtifactOp,
  ArtifactVersion,
  type ArtifactVersionRecord,
} from "./artifact";
import { MailMessageId } from "./crew";
import { ArtifactFact, type ArtifactEntry } from "./artifact-domain";
import type { ArtifactMoveRecord } from "./artifact-move";
import { ArtifactLabel, ArtifactLabelColour, type ArtifactLabelColours } from "./artifact-labels";
import type { OpOverlay } from "./op-control";
import { NodeId } from "./physics/schema";
import { RefusalReason } from "./resource-command";
import type { TaskDomainEnv } from "./task-machine";
import {
  TASK_REFUSAL_REASON,
  TASK_STATES,
  TaskCommandWire,
  taskNodeId,
  type SeatNodeId,
  type TaskCommand,
  type TaskId,
  type TaskNodeId,
  type TaskRefusal,
  type TaskRefusalDetail,
  type TaskView,
} from "./task-model";
import { WorkErrorBody } from "./work-control";
import { CompletionEvidence } from "./work-model";
import { ItemId, OpId, TaskNumber } from "./work-ids";
import { Anchor, PlaceAnchor, RelativePath } from "./wire/thread-subject";
import { ContentRef } from "./wire/content-ref";

// ── channels ───────────────────────────────────────────────────────────────

export { RESOURCE_IPC_CHANNELS, type ResourceIpcDomain } from "./resource-ipc-channels";

// ── outcomes ───────────────────────────────────────────────────────────────

/**
 * What one write comes back as. `queued` is a success: the command is durable
 * and will be ruled (02); the pane shows it pending. A refusal is the
 * ruler's own `WorkErrorBody`, `details.reason` its closed `RefusalReason`.
 */
export type ResourceApplyOutcome<Applied extends object = {}> =
  | ({ readonly kind: "applied"; readonly opId: OpId } & Applied)
  | { readonly kind: "refused"; readonly opId: OpId; readonly error: WorkErrorBody }
  | { readonly kind: "queued"; readonly opId: OpId };

/**
 * `deliveryError`: the write was ruled and stands, but the mail it owes (an
 * assignment, a stamp request) did not go. A resend is answered as a replay
 * and sends nothing, so the pane says so instead of retrying.
 */
const AppliedOutcome = Schema.Struct({ kind: Schema.Literal("applied"), opId: OpId });
const RefusedOutcome = Schema.Struct({ kind: Schema.Literal("refused"), opId: OpId, error: WorkErrorBody });
const QueuedOutcome = Schema.Struct({ kind: Schema.Literal("queued"), opId: OpId });

/** `ResourceApplyOutcome` as it crosses the core's port. */
export const ResourceApplyOutcomeWire = Schema.Union([AppliedOutcome, RefusedOutcome, QueuedOutcome]);

export const TaskApplyOutcome = Schema.Union([
  Schema.Struct({ ...AppliedOutcome.fields, deliveryError: Schema.optionalKey(WorkErrorBody) }),
  RefusedOutcome,
  QueuedOutcome,
]);
export type TaskApplyOutcome = typeof TaskApplyOutcome.Type;

/** `facts` is empty when a resend is answered from the stored ruling: nothing changed again. */
export const ArtifactApplyOutcome = Schema.Union([
  Schema.Struct({ ...AppliedOutcome.fields, facts: Schema.Array(ArtifactFact) }),
  RefusedOutcome,
  QueuedOutcome,
]);
export type ArtifactApplyOutcome = typeof ArtifactApplyOutcome.Type;

/**
 * One of this machine's writes to a node's items that the editing machine
 * has not ruled yet, in queue order: every seat's and the operator's, never
 * another machine's. `overlay` is what `op list` reads of it over the ruled
 * state (02 read-your-writes); absent when the build has no overlay reader
 * for the domain.
 */
export type ArtifactPendingWrite = {
  readonly opId: OpId;
  readonly artifactId: ItemId;
  readonly op: ArtifactOp;
  readonly overlay?: OpOverlay;
};
export type TaskPendingWrite = {
  readonly opId: OpId;
  readonly taskId: TaskId;
  readonly command: TaskCommandWire;
  readonly overlay?: OpOverlay;
};

// ── the answers as Schemas ─────────────────────────────────────────────────
//
// The core answers the window's reads over its port, so each answer is a
// Schema that both ends decode closed. The model's own types stay where they
// are (they carry brands a Schema cannot); each Schema below names the same
// fields with plain ids, and the checks after it fail the compile when the
// model gains a field the wire does not carry, since an encode drops it silently.

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const RefusalWire = Schema.Struct({
  reason: RefusalReason,
  message: Schema.String,
  expected: Schema.optionalKey(Schema.Unknown),
  next_step: Schema.optionalKey(Schema.String),
});

/** What the writing machine reads of a queued write over its last ruled state (`OpOverlay`). */
export const OpOverlayWire = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({ status: Schema.Literal("at_risk"), refusal: RefusalWire }),
  Schema.Struct({ status: Schema.Literal("at_risk"), waiting: Schema.Literal("base_not_pulled"), root: OpId }),
]);

export const TaskPendingWriteWire = Schema.Struct({
  opId: OpId,
  taskId: ItemId,
  command: TaskCommandWire,
  overlay: Schema.optionalKey(OpOverlayWire),
});

export const ArtifactPendingWriteWire = Schema.Struct({
  opId: OpId,
  artifactId: ItemId,
  op: ArtifactOp,
  overlay: Schema.optionalKey(OpOverlayWire),
});

const ReviewerWire = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("seat"), seat: NodeId }),
  Schema.Struct({ kind: Schema.Literal("operator") }),
]);

const StampWire = Schema.Struct({
  reviewer: ReviewerWire,
  verdict: Schema.Literals(["approve", "changes"]),
  epoch: Schema.Number,
  subjectHash: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  at: Schema.Number,
});

const CheckResultWire = Schema.Struct({
  checkId: Schema.String,
  side: Schema.Literals(["outgoing", "incoming"]),
  command: Schema.String,
  exitCode: Schema.Number,
  outputTail: Schema.String,
  epoch: Schema.Number,
  destination: Schema.optionalKey(NodeId),
  at: Schema.Number,
});

const TaskCoreWire = Schema.Struct({
  state: Schema.Literals(TASK_STATES),
  node: NodeId,
  assignee: Schema.optionalKey(NodeId),
  epoch: Schema.Number,
  stampPolicy: Schema.Struct({ required: Schema.Number }),
  reviewers: Schema.Array(ReviewerWire),
  stamps: Schema.Array(StampWire),
  checks: Schema.optionalKey(Schema.Array(CheckResultWire)),
  next: Schema.optionalKey(NodeId),
  evidence: Schema.optionalKey(CompletionEvidence),
  handoff: Schema.optionalKey(Schema.String),
  archivedFrom: Schema.optionalKey(Schema.Literals(["done", "canceled"])),
});

const TaskLinkWire = Schema.Struct({
  taskId: ItemId,
  number: Schema.optionalKey(TaskNumber),
  node: NodeId,
});

/** One task as readers show it (`TaskView`), with the node ids plain. */
export const TaskViewWire = Schema.Struct({
  taskId: ItemId,
  number: Schema.optionalKey(TaskNumber),
  title: Schema.String,
  body: Schema.optionalKey(Schema.String),
  current: TaskCoreWire,
  layers: Schema.Array(Schema.Struct({ ...TaskCoreWire.fields, closedAt: Schema.Number })),
  dependsOn: Schema.Array(ItemId),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  stateSince: Schema.Number,
  pending: Schema.optionalKey(Schema.Struct({ opId: Schema.String })),
  derivedFrom: Schema.optionalKey(TaskLinkWire),
  derived: Schema.optionalKey(Schema.Array(TaskLinkWire)),
});

/** An artifact as listed (`ArtifactHead`). */
export const ArtifactHeadWire = Schema.Struct({
  artifact: Artifact,
  body: Schema.NullOr(ArtifactBody),
  bodyRef: ContentRef,
});

/** The colours set in one Artifacts node, by label (`ArtifactLabelColours`). */
export const ArtifactLabelColoursWire = Schema.Record(ArtifactLabel, ArtifactLabelColour);

const labelColoursFitWire: Same<ArtifactLabelColours, typeof ArtifactLabelColoursWire.Type> = true;
const taskViewFitsWire: TaskView extends typeof TaskViewWire.Type ? true : false = true;
const taskViewHasNoOtherField: Same<keyof TaskView, keyof typeof TaskViewWire.Type> = true;
const taskCoreHasNoOtherField: Same<keyof TaskView["current"], keyof typeof TaskCoreWire.Type> = true;
const overlayFitsWire: OpOverlay extends typeof OpOverlayWire.Type ? true : false = true;
const taskPendingFitsWire: TaskPendingWrite extends typeof TaskPendingWriteWire.Type ? true : false = true;
const artifactPendingFitsWire: ArtifactPendingWrite extends typeof ArtifactPendingWriteWire.Type ? true : false = true;
const artifactHeadFitsWire: ArtifactHead extends typeof ArtifactHeadWire.Type ? true : false = true;
const resourceOutcomeFitsWire: ResourceApplyOutcome extends typeof ResourceApplyOutcomeWire.Type ? true : false = true;
void [
  labelColoursFitWire,
  taskViewFitsWire,
  taskViewHasNoOtherField,
  taskCoreHasNoOtherField,
  overlayFitsWire,
  taskPendingFitsWire,
  artifactPendingFitsWire,
  artifactHeadFitsWire,
  resourceOutcomeFitsWire,
];

/**
 * Said to every window after a write to a canvas's tasks or artifacts, by
 * anyone, and when one of this machine's queued writes is ruled.
 */
/** A resource changed on a canvas: on `nodeIds` when named, anywhere on the canvas when not. */
export type ResourceChanged = { readonly canvasName: string; readonly nodeIds?: ReadonlyArray<string> };

const isTaskRefusalKind = (kind: unknown): kind is TaskRefusalDetail["kind"] =>
  typeof kind === "string" && Object.hasOwn(TASK_REFUSAL_REASON, kind);

/**
 * A refused task write as the task domain worded it: the ruler carries the
 * detail as `details.expected` (`toRefusal`, task-machine.ts), so a pane reads
 * `detail.kind` exactly as the local machine gives it. Undefined for a
 * refusal before the domain (reach, an unknown target, a full queue).
 */
export const taskRefusalOf = (error: WorkErrorBody): TaskRefusal | undefined => {
  const reason = error.details?.reason;
  const expected = error.details?.expected as { readonly kind?: unknown } | undefined;
  if (!Schema.is(RefusalReason)(reason) || typeof expected !== "object" || expected === null) return undefined;
  if (!isTaskRefusalKind(expected.kind) || TASK_REFUSAL_REASON[expected.kind] !== reason) return undefined;
  return { reason, detail: expected as TaskRefusalDetail };
};

// ── task inputs ────────────────────────────────────────────────────────────

const CanvasNameInput = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(128)));

export const TaskListInput = Schema.Struct({ canvasName: CanvasNameInput, nodeId: NodeId });
export const TaskAllInput = Schema.Struct({ canvasName: CanvasNameInput });
export const TaskContextInput = TaskAllInput;
export const TaskPendingInput = TaskListInput;
export const TaskApplyInput = Schema.Struct({
  canvasName: CanvasNameInput,
  nodeId: NodeId,
  taskId: ItemId,
  opId: OpId,
  command: TaskCommandWire,
});
export { TaskCommandWire };

// ── task ruling context ────────────────────────────────────────────────────

/**
 * What the task domain consults besides the tasks, as data: the flows out of
 * each task node, each node's stamp default, and every seat's reach to each
 * task node (region-reach). A pane builds its `TaskDomainEnv` from it
 * (`taskEnvOf`) to check a command before it sends it; main rules again.
 */
export const TaskCanvasFacts = Schema.Struct({
  downstream: Schema.Record(Schema.String, Schema.Array(NodeId)),
  stampDefaults: Schema.Record(Schema.String, Schema.Struct({ required: Schema.Number })),
  /** Per seat, the task nodes it reaches. */
  seatReach: Schema.Record(Schema.String, Schema.Array(NodeId)),
});
/** Node ids are plain on the wire, as in `TaskCommandWire`; `taskEnvOf` narrows them to the task model's. */
export type TaskCanvasFacts = typeof TaskCanvasFacts.Type;

export const taskEnvOf = (facts: TaskCanvasFacts): Omit<TaskDomainEnv, "at"> => ({
  downstream: (node) => (facts.downstream[node] ?? []).map(taskNodeId),
  stampDefaultOf: (node) => facts.stampDefaults[node] ?? { required: 0 },
  seatReaches: (seat, node) => facts.seatReach[seat]?.includes(node) ?? false,
});

/** The facts of the task nodes and seats given, read through an env: main's side of `taskEnvOf`. */
export const taskCanvasFactsOf = (
  env: Omit<TaskDomainEnv, "at">,
  taskNodes: ReadonlyArray<TaskNodeId>,
  seats: ReadonlyArray<SeatNodeId>,
): TaskCanvasFacts => ({
  downstream: Object.fromEntries(taskNodes.map((node) => [node, env.downstream(node)])),
  stampDefaults: Object.fromEntries(taskNodes.map((node) => [node, env.stampDefaultOf(node)])),
  seatReach: Object.fromEntries(seats.map((seat) => [seat, taskNodes.filter((node) => env.seatReaches(seat, node))])),
});

// ── artifact inputs ────────────────────────────────────────────────────────

export const ArtifactListInput = TaskListInput;
export const ArtifactPendingInput = TaskListInput;
export const ArtifactHistoryInput = Schema.Struct({ canvasName: CanvasNameInput, artifactId: ItemId });
export const ArtifactMovesInput = Schema.Struct({ canvasName: CanvasNameInput, artifactId: ItemId });
/** One version's body, for an entry whose body is not loaded. */
export const ArtifactBodyInput = Schema.Struct({
  canvasName: CanvasNameInput,
  artifactId: ItemId,
  version: ArtifactVersion,
});
export const ArtifactApplyInput = Schema.Struct({
  canvasName: CanvasNameInput,
  nodeId: NodeId,
  artifactId: ItemId,
  opId: OpId,
  op: ArtifactOp,
});

export const ArtifactLabelColoursInput = TaskListInput;
/** A label's colour on an Artifacts node (03 Colours): the node, never an artifact. `colour: null` unsets it. */
export const ArtifactColourInput = Schema.Struct({
  canvasName: CanvasNameInput,
  nodeId: NodeId,
  opId: OpId,
  label: Schema.String,
  colour: Schema.NullOr(ArtifactLabelColour),
});

/** An artifact as listed: the head, its body when loaded (else null), and the body's ref. */
export type ArtifactHead = Pick<ArtifactEntry, "artifact" | "body" | "bodyRef">;

/** At most this many versions in one history read, newest first. */
export const ARTIFACT_HISTORY_PAGE = 50;

// ── threads ────────────────────────────────────────────────────────────────

/**
 * The resource a thread hangs on: a task, an artifact or a file in a Files
 * node. Threads are read from the subject node's mailbox and posted through
 * the one comment path the CLI uses, as the operator. A file names its node
 * and the path inside it, never an absolute path.
 */
/**
 * A post never names its author: main posts it as the operator. `actor` is a key
 * no value decodes, so a smuggled author is refused whatever the decode options.
 */
const NoAuthor = Schema.optionalKey(Schema.Never);

export const ThreadResourceSubject = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("task"), nodeId: NodeId, taskId: ItemId, actor: NoAuthor }),
  Schema.Struct({ kind: Schema.Literal("artifact"), nodeId: NodeId, artifactId: ItemId, actor: NoAuthor }),
  Schema.Struct({ kind: Schema.Literal("file"), nodeId: NodeId, path: RelativePath, actor: NoAuthor }),
]);
export type ThreadResourceSubject = typeof ThreadResourceSubject.Type;

export const ThreadListInput = Schema.Struct({ canvasName: CanvasNameInput, subject: ThreadResourceSubject });

/** A post as the window writes it. `threadId` replies in a thread; an anchor is where on the resource the thread hangs. */
export const ThreadPostDraft = Schema.Struct({
  opId: OpId,
  text: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(64_000))),
  threadId: Schema.optionalKey(MailMessageId),
  anchor: Schema.optionalKey(Anchor),
  actor: NoAuthor,
});
export type ThreadPostDraft = typeof ThreadPostDraft.Type;

export const ThreadPostInput = Schema.Struct({
  canvasName: CanvasNameInput,
  subject: ThreadResourceSubject,
  post: ThreadPostDraft,
  actor: NoAuthor,
});

// ── the renderer's payloads, decoded at main's edge ────────────────────────

/** Each input as the renderer sends it, decoded with excess keys refused: what main hands the core. */
const closed = { onExcessProperty: "error" } as const;
export const decodeTaskListInput = Schema.decodeUnknownResult(TaskListInput, closed);
export const decodeTaskAllInput = Schema.decodeUnknownResult(TaskAllInput, closed);
export const decodeTaskContextInput = Schema.decodeUnknownResult(TaskContextInput, closed);
export const decodeTaskApplyInput = Schema.decodeUnknownResult(TaskApplyInput, closed);
export const decodeTaskPendingInput = Schema.decodeUnknownResult(TaskPendingInput, closed);
export const decodeArtifactListInput = Schema.decodeUnknownResult(ArtifactListInput, closed);
export const decodeArtifactHistoryInput = Schema.decodeUnknownResult(ArtifactHistoryInput, closed);
export const decodeArtifactMovesInput = Schema.decodeUnknownResult(ArtifactMovesInput, closed);
export const decodeArtifactBodyInput = Schema.decodeUnknownResult(ArtifactBodyInput, closed);
export const decodeArtifactApplyInput = Schema.decodeUnknownResult(ArtifactApplyInput, closed);
export const decodeArtifactPendingInput = Schema.decodeUnknownResult(ArtifactPendingInput, closed);
export const decodeArtifactLabelColoursInput = Schema.decodeUnknownResult(ArtifactLabelColoursInput, closed);
export const decodeArtifactColourInput = Schema.decodeUnknownResult(ArtifactColourInput, closed);
export const decodeThreadListInput = Schema.decodeUnknownResult(ThreadListInput, closed);
export const decodeThreadPostInput = Schema.decodeUnknownResult(ThreadPostInput, closed);

/**
 * Who wrote a post, with the name to show. A seat and the operator are the
 * `ResourceActor` they wrote as; an automation's row names its node only.
 */
export const ThreadPostAuthor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("seat"), seatId: ActorSeatId, nodeId: NodeId, name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("operator"), name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("automation"), nodeId: NodeId, name: Schema.String }),
]);
export type ThreadPostAuthor = typeof ThreadPostAuthor.Type;

export const ThreadPost = Schema.Struct({
  /** The post's message id. */
  postId: MailMessageId,
  author: ThreadPostAuthor,
  text: Schema.String,
  /** Epoch ms the post was written. */
  at: Schema.Number,
  /** Files the operator sent with it; a comment carries none today. */
  attachments: Schema.optionalKey(Schema.Array(ContentRef)),
});
export type ThreadPost = typeof ThreadPost.Type;

/** One thread on a resource, oldest post first. `anchor` is its root's place on the resource. */
export const SubjectThreadView = Schema.Struct({
  threadId: MailMessageId,
  anchor: Schema.optionalKey(PlaceAnchor),
  posts: Schema.Array(ThreadPost),
});
export type SubjectThreadView = typeof SubjectThreadView.Type;

/**
 * A post is written at once on this machine or refused: a comment is never
 * queued. A replayed opId answers as its first post did.
 */
export const ThreadPostOutcome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("applied"),
    opId: OpId,
    threadId: MailMessageId,
    postId: MailMessageId,
    /** The seats told of it. */
    notified: Schema.Array(NodeId),
  }),
  RefusedOutcome,
]);
export type ThreadPostOutcome = typeof ThreadPostOutcome.Type;

/** Said to every window when a canvas's tasks or artifacts change, a comment on them included. */
export type ThreadChanged = ResourceChanged & { readonly kind: ThreadResourceSubject["kind"] };

// ── the renderer's API ─────────────────────────────────────────────────────

export type TaskResourceApi = {
  /** The tasks on this node now, oldest first. */
  readonly list: (canvasName: string, nodeId: TaskNodeId) => Promise<ReadonlyArray<TaskView>>;
  /** Every task of the canvas but archived ones. */
  readonly all: (canvasName: string) => Promise<ReadonlyArray<TaskView>>;
  readonly context: (canvasName: string) => Promise<TaskCanvasFacts>;
  /** Rule one command; on create the caller mints `taskId` and names it in the command. */
  readonly apply: (
    canvasName: string,
    nodeId: TaskNodeId,
    taskId: TaskId,
    opId: OpId,
    command: TaskCommand,
  ) => Promise<TaskApplyOutcome>;
  /** This machine's unruled writes to the node's tasks, in queue order. */
  readonly pending: (canvasName: string, nodeId: TaskNodeId) => Promise<ReadonlyArray<TaskPendingWrite>>;
  readonly onChanged: (listener: (changed: ResourceChanged) => void) => () => void;
};

export type ArtifactResourceApi = {
  /** The artifacts on this node, newest change first. */
  readonly list: (canvasName: string, nodeId: NodeId) => Promise<ReadonlyArray<ArtifactHead>>;
  /** The last `ARTIFACT_HISTORY_PAGE` versions, newest first, each with its body. */
  readonly history: (canvasName: string, artifactId: ItemId) => Promise<ReadonlyArray<ArtifactVersionRecord>>;
  /** Every move of the artifact, oldest first (0.11.1, 10); none for one that never moved. */
  readonly moves: (canvasName: string, artifactId: ItemId) => Promise<ReadonlyArray<ArtifactMoveRecord>>;
  /** One version's body; null when the store does not hold it. */
  readonly body: (canvasName: string, artifactId: ItemId, version: ArtifactVersion) => Promise<ArtifactBody | null>;
  /** Rule one op; on create the caller mints `artifactId`. */
  readonly apply: (
    canvasName: string,
    nodeId: NodeId,
    artifactId: ItemId,
    opId: OpId,
    op: ArtifactOp,
  ) => Promise<ArtifactApplyOutcome>;
  /** This machine's unruled writes to the node's artifacts, in queue order. */
  readonly pending: (canvasName: string, nodeId: NodeId) => Promise<ReadonlyArray<ArtifactPendingWrite>>;
  /** The label colours set in this Artifacts node (03 Colours); a label with none is absent. */
  readonly labelColours: (canvasName: string, nodeId: NodeId) => Promise<ArtifactLabelColours>;
  /**
   * Set or unset (`colour: null`) a label's colour in this node, as one
   * `{ op: "labelColour" }` on the node. The label is folded by the ruler.
   */
  readonly colour: (
    canvasName: string,
    nodeId: NodeId,
    opId: OpId,
    label: string,
    colour: ArtifactLabelColour | null,
  ) => Promise<ResourceApplyOutcome>;
  readonly onChanged: (listener: (changed: ResourceChanged) => void) => () => void;
};

export type ThreadResourceApi = {
  /** The threads on a task or an artifact, each oldest post first, threads by their first post. */
  readonly list: (canvasName: string, subject: ThreadResourceSubject) => Promise<ReadonlyArray<SubjectThreadView>>;
  /** Post as the operator; the window mints `opId`, so a resend is the same post. */
  readonly post: (canvasName: string, subject: ThreadResourceSubject, post: ThreadPostDraft) => Promise<ThreadPostOutcome>;
  readonly onChanged: (listener: (changed: ThreadChanged) => void) => () => void;
};

export type ResourceIpcApi = {
  readonly task: TaskResourceApi;
  readonly artifact: ArtifactResourceApi;
  /** Threads on tasks and artifacts; a kind whose product this build leaves out is refused. */
  readonly thread: ThreadResourceApi;
};
