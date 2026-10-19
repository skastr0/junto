import { Result, Schema, Struct } from "effect";
import { overseerOperationEnabled } from "./features";
import { EnvSource } from "./model/region";
import { ContentIdentity, ContentRef } from "./content";
import { Color } from "./model/base";
import { NodeEdit, WireEdit } from "./model/commands";
import { NodeDraft, SeatDraft, WireDraft } from "./model/drafts";
import { Seq } from "./model/events";
import { PadPatch } from "./pad";
import { OverseerLiveCorrelation } from "./overseer-host-control";
import { SECRET_ID_PATTERN, secretValueProblem } from "./region-secrets";
import {
  OffboardRulesPatch,
  SEAT_OFFBOARD_ACTIONS,
  SEAT_OFFBOARD_MAX_SEATS,
} from "./seat-offboard";
import { OFFBOARD_MODES } from "./seat-sessions";
import { SheetGrid } from "./model/sheet";
import {
  CompletionEvidence,
  FinishCriteria,
  Part,
  TaskAdmission,
  TaskRule,
  TaskState,
  WorkMetadata,
} from "./work-model";

/**
 * Agent-native operator command contract.
 *
 * The existing process-bound Work socket carries exactly one outer `overseer`
 * operation whose args are an OverseerRequest. Main authenticates the live
 * caller and verifies its human-authored overseer grant before dispatch. This
 * module contains no transport, authority, database, or generic RPC surface.
 */

export const OVERSEER_MAX_REQUEST_BYTES = 1024 * 1024;
export const OVERSEER_MAX_BATCH_OPERATIONS = 100;
// The Work transport's 8 MiB limit applies to the complete NDJSON response,
// not only this nested result. Reserve 64 KiB for Work and Station envelopes,
// their bounded identities, JSON punctuation, and the trailing newline.
export const OVERSEER_MAX_RESULT_BYTES = 8 * 1024 * 1024 - 64 * 1024;
/** Maximum JSON-encoded outer Work correlation id on an overseer request. */
export const OVERSEER_MAX_CORRELATION_BYTES = 4 * 1024;
export const OVERSEER_MAX_ERROR_BYTES = 4 * 1024;

export const OVERSEER_OPERATION_NAMES = [
  "status",
  "canvas.list",
  "canvas.read",
  "canvas.create",
  "canvas.batch",
  "canvas.delete",
  "canvas.digest",
  "canvas.render",
  "canvas.screenshot",
  "node.list",
  "node.get",
  "node.create",
  "node.configure",
  "node.move",
  "node.resize",
  "node.recolor",
  "node.delete",
  "wire.list",
  "wire.get",
  "wire.verbs",
  "wire.connect",
  "wire.configure",
  "wire.disconnect",
  "tasks.list",
  "tasks.create",
  "tasks.claim",
  "tasks.describe",
  "tasks.update",
  "tasks.show",
  "tasks.rules",
  "tasks.check",
  "tasks.promote",
  "tasks.comment",
  "tasks.respond",
  "request.list",
  "request.get",
  "request.create",
  "request.resolve",
  "request.comment",
  "artifact.list",
  "artifact.get",
  "artifact.publish",
  "artifact.archive",
  "artifact.delete",
  "msg.list",
  "msg.send",
  "msg.read",
  "msg.reply",
  "msg.react",
  "board.list",
  "board.create-topic",
  "board.post",
  "board.mark-read",
  "board.tags",
  "board.notify",
  "pad.read",
  "pad.patch",
  "pad.digest",
  "pad.render",
  "pad.look-here",
  "pad.get",
  "pad.tagged",
  "sheet.read",
  "sheet.configure",
  "content.ingest",
  "content.path",
  "content.stat",
  "content.materialize",
  "agent.list",
  "agent.get",
  "agent.reseat",
  "agent.start",
  "agent.wake",
  "agent.prompt",
  "agent.output",
  "agent.interrupt",
  "agent.stop",
  "terminal.list",
  "terminal.get",
  "terminal.start",
  "terminal.input",
  "terminal.output",
  "terminal.resize",
  "terminal.interrupt",
  "terminal.stop",
  "page.list",
  "page.get",
  "page.open",
  "page.goto",
  "page.eval",
  "page.screenshot",
  "page.close",
  "page.stop",
  "scheduler.fire",
  "scheduler.status",
  "scheduler.configure",
  "git.status",
  "git.log",
  "git.show",
  "env.show",
  "env.source-add",
  "env.source-edit",
  "env.source-remove",
  "env.source-reorder",
  "env.seal",
  "env.folders",
  "env.doctor",
  "secret.put",
  "secret.delete",
  "secret.list",
  "agent.offboard",
  "agent.offboard-status",
  "agent.offboard-rules",
  "agent.offboard-configure",
  "references.list",
  "references.read",
  "references.write",
  "references.delete",
  "briefing.read",
  "briefing.write",
] as const;

/**
 * Names this contract once had and no longer takes. Kept for one purpose: so
 * the CLI can say in one line what replaced a name an agent still types.
 * Never dispatched, listed, or given a schema or an example. A stored receipt
 * of one still reads: `overseer_live_operations.operation` is kept as text.
 */
export const OVERSEER_RETIRED_OPERATIONS: Readonly<Record<string, OverseerOperation>> = {
  "edge.list": "wire.list",
  "edge.get": "wire.get",
  "edge.verbs": "wire.verbs",
  "edge.connect": "wire.connect",
  "edge.configure": "wire.configure",
  "edge.disconnect": "wire.disconnect",
};

export const OverseerOperation = Schema.Literals(OVERSEER_OPERATION_NAMES);
export type OverseerOperation = typeof OverseerOperation.Type;

export const OverseerRequest = Schema.Struct({
  operation: OverseerOperation,
  args: Schema.optionalKey(Schema.Unknown),
  live: Schema.optionalKey(OverseerLiveCorrelation),
});
export type OverseerRequest = typeof OverseerRequest.Type;

const NonEmpty = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));
const Id = NonEmpty.pipe(Schema.check(Schema.isMaxLength(256)));
const CanvasName = NonEmpty.pipe(Schema.check(Schema.isMaxLength(64)));
const Positive = Schema.Number.pipe(
  Schema.check(Schema.makeFilter(Number.isFinite, { message: "must be finite" })),
  Schema.check(Schema.isGreaterThan(0)),
);
const Finite = Schema.Number.pipe(
  Schema.check(Schema.makeFilter(Number.isFinite, { message: "must be finite" })),
);
const NonNegativeInt = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
);
const EmptyArgs = Schema.Struct({});

/** Authenticated seat identity supplied by the admitting transport, never args. */
export const OverseerCaller = Schema.Struct({
  canvasName: CanvasName,
  nodeId: Id,
});
export type OverseerCaller = typeof OverseerCaller.Type;

export const OverseerErrorType = Schema.Literals([
  "Forbidden",
  "InvalidArguments",
  "NotFound",
  "Conflict",
  "Unsupported",
  "RuntimeDown",
  "InternalError",
]);
export type OverseerErrorType = typeof OverseerErrorType.Type;

export const OverseerErrorBody = Schema.Struct({
  type: OverseerErrorType,
  message: NonEmpty.pipe(
    Schema.check(Schema.makeFilter(
      (message) =>
        new TextEncoder().encode(message).byteLength <= OVERSEER_MAX_ERROR_BYTES,
      { message: `error message exceeds ${OVERSEER_MAX_ERROR_BYTES} UTF-8 bytes` },
    )),
  ),
  details: Schema.optionalKey(Schema.Unknown),
});
export type OverseerErrorBody = typeof OverseerErrorBody.Type;

export const OverseerResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    operation: OverseerOperation,
    data: Schema.Unknown,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    operation: OverseerOperation,
    error: OverseerErrorBody,
  }),
]);
export type OverseerResult = typeof OverseerResult.Type;

const CanvasOptional = {
  canvas: Schema.optionalKey(CanvasName),
} as const;
const CanvasRequired = {
  canvas: CanvasName,
} as const;
const NodeTarget = {
  ...CanvasOptional,
  nodeId: Id,
} as const;
const SinkTarget = {
  ...CanvasOptional,
  target: Id,
} as const;

// Canvas, node and wire authoring -------------------------------------------
//
// The wire carries the model's own types (`src/shared/model`): a node is told
// by its kind with that kind's flat fields, and a wire by `from`, `to` and
// `verb`. Every schema here is built from the model's exported schemas, so
// `junto overseer schema show` prints exactly what main decodes.

const NodeIds = Schema.Array(Id).pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(OVERSEER_MAX_BATCH_OPERATIONS)),
);

/**
 * A node to add: the model node with `id` optional and no `z`; main mints and
 * stacks. A seat is the exception: it is drafted by naming what it runs
 * (harness and its choices), and main works out the rest.
 */
const NodeCreate = { node: NodeDraft } as const;
/** The model edit for the node's kind: a field is set by naming it, cleared with null. */
const NodeConfigure = { nodeId: Id, change: NodeEdit } as const;
const NodeMove = { nodeId: Id, x: Finite, y: Finite } as const;
const NodeResize = { nodeId: Id, width: Positive, height: Positive } as const;
/** One color for many nodes; null clears it. Color is not an edit in the model. */
const NodeRecolor = { nodeIds: NodeIds, color: Schema.NullOr(Color) } as const;
const NodeDelete = { nodeIds: NodeIds } as const;

/** A wire to add: `id` optional, `verb` optional (main picks the default for the two ends). */
const WireConnect = { wire: WireDraft } as const;
/** The model's edit of a wire: what it grants or where it attaches. Its two ends are fixed. */
const WireConfigure = { wireId: Id, change: WireEdit } as const;
const WireDisconnect = { wireId: Id } as const;

const step = <const Operation extends OverseerOperation, Fields extends Schema.Struct.Fields>(
  operation: Operation,
  fields: Fields,
) => Schema.Struct({ operation: Schema.Literal(operation), ...fields });

/**
 * Closed structural edits only, each the write of the same name without its
 * canvas: no native actions, grants, deletes, or nested batches.
 */
export const OverseerCanvasBatchStep = Schema.Union([
  step("node.create", NodeCreate),
  step("node.configure", NodeConfigure),
  step("node.move", NodeMove),
  step("node.resize", NodeResize),
  step("node.recolor", NodeRecolor),
  step("wire.connect", WireConnect),
  step("wire.configure", WireConfigure),
  step("wire.disconnect", WireDisconnect),
]);
export type OverseerCanvasBatchStep = typeof OverseerCanvasBatchStep.Type;

export const OverseerCanvasBatch = Schema.Struct({
  ...CanvasOptional,
  /** The `seq` that `canvas.read` answered. A canvas that moved since is a Conflict. */
  expectedSeq: Schema.optionalKey(Seq),
  steps: Schema.Array(OverseerCanvasBatchStep).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(OVERSEER_MAX_BATCH_OPERATIONS)),
  ),
});

// Work plane ---------------------------------------------------------------

const TaskIdentity = Schema.Struct({
  ...SinkTarget,
  task: Id,
});
const TaskCreate = Schema.Struct({
  ...SinkTarget,
  brief: NonEmpty,
  reason: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(WorkMetadata),
  media: Schema.optionalKey(Schema.Array(Part)),
  dependsOn: Schema.optionalKey(Schema.Array(Id)),
  finishCriteria: Schema.optionalKey(FinishCriteria),
  rules: Schema.optionalKey(Schema.Array(TaskRule)),
  admission: Schema.optionalKey(TaskAdmission),
  waitFor: Schema.optionalKey(NonNegativeInt),
});
const TaskClaim = Schema.Struct({
  ...SinkTarget,
  task: Id,
  actor: Schema.optionalKey(Id),
});
const TaskDescribe = Schema.Struct({
  ...SinkTarget,
  task: Id,
  brief: NonEmpty,
});
const TaskDefect = Schema.Struct({
  summary: NonEmpty,
  refs: Schema.optionalKey(Schema.Array(Schema.String)),
  target: Schema.optionalKey(Id),
});
const TaskUpdate = Schema.Struct({
  ...SinkTarget,
  task: Id,
  state: TaskState,
  note: Schema.optionalKey(Schema.String),
  completionEvidence: Schema.optionalKey(CompletionEvidence),
  next: Schema.optionalKey(Id),
  waitFor: Schema.optionalKey(NonNegativeInt),
  defect: Schema.optionalKey(TaskDefect),
  handoffNote: Schema.optionalKey(Schema.String),
}).pipe(
  Schema.check(Schema.makeFilter(({ state, completionEvidence }) =>
    completionEvidence === undefined || state === "completed" ||
    "completionEvidence is only allowed when state is completed",)),
  Schema.check(Schema.makeFilter(({ state, next }) =>
    next === undefined || state === "completed" ||
    "next is only allowed when state is completed",)),
  Schema.check(Schema.makeFilter(({ state, waitFor }) =>
    waitFor === undefined || state === "completed" ||
    "waitFor is only allowed when state is completed",)),
  Schema.check(Schema.makeFilter(({ state, handoffNote }) =>
    handoffNote === undefined || state === "completed" ||
    "handoffNote is only allowed when state is completed",)),
  Schema.check(Schema.makeFilter(({ state, defect }) =>
    defect === undefined || state === "rejected" ||
    "defect is only allowed when state is rejected",)),
);
const TaskCheck = Schema.Struct({
  ...SinkTarget,
  task: Id,
  next: Schema.optionalKey(Id),
  results: Schema.Array(Schema.Struct({
    checkId: Id,
    side: Schema.Literals(["outgoing", "incoming"]),
    exitCode: Schema.Number.pipe(Schema.check(Schema.isInt())),
    outputTail: Schema.String,
  })),
});
const TaskPromote = Schema.Struct({
  ...SinkTarget,
  task: Id,
  note: Schema.optionalKey(Schema.String),
});
const TaskComment = Schema.Struct({
  ...SinkTarget,
  task: Id,
  text: NonEmpty,
});
const TaskRespond = Schema.Struct({
  ...SinkTarget,
  task: Id,
  responseText: NonEmpty,
  disposition: Schema.Literals(["working", "rejected"]),
});
const RequestIdentity = Schema.Struct({
  ...SinkTarget,
  request: Id,
});
const RequestCreate = Schema.Struct({
  ...SinkTarget,
  brief: NonEmpty,
  reason: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(WorkMetadata),
});
const RequestResolve = Schema.Struct({
  ...SinkTarget,
  request: Id,
  responseText: NonEmpty,
  disposition: Schema.Literals(["completed", "rejected"]),
});
const RequestComment = Schema.Struct({
  ...SinkTarget,
  request: Id,
  text: NonEmpty,
});
const ArtifactIdentity = Schema.Struct({
  ...SinkTarget,
  artifact: Id,
});
const ArtifactPublish = Schema.Struct({
  ...SinkTarget,
  name: Schema.optionalKey(Schema.String),
  artifactId: Schema.optionalKey(Id),
  parts: Schema.Array(Part).pipe(Schema.check(Schema.isMinLength(1))),
  task: Schema.optionalKey(Schema.Struct({ target: Id, id: Id })),
  metadata: Schema.optionalKey(WorkMetadata),
});
const ArtifactArchive = Schema.Struct({
  ...SinkTarget,
  artifact: Id,
  archived: Schema.Boolean,
});
const MessageList = Schema.Struct({
  ...CanvasOptional,
  target: Schema.optionalKey(Id),
  taskId: Schema.optionalKey(Id),
});
const MessageSend = Schema.Struct({
  ...SinkTarget,
  text: NonEmpty,
  taskId: Schema.optionalKey(Id),
});
const MessageRead = Schema.Struct({
  ...CanvasOptional,
  target: Schema.optionalKey(Id),
  messageId: Id,
});
const MessageReply = Schema.Struct({
  ...SinkTarget,
  text: NonEmpty,
  inReplyTo: Id,
});
const MessageReact = Schema.Struct({
  ...CanvasOptional,
  target: Schema.optionalKey(Id),
  messageId: Id,
  reaction: Schema.optionalKey(Schema.Literal("ack")),
});
const BoardList = Schema.Struct({
  ...SinkTarget,
  topicId: Schema.optionalKey(Id),
});
const BoardCreateTopic = Schema.Struct({
  ...SinkTarget,
  title: NonEmpty,
  body: Schema.optionalKey(Schema.String),
  notify: Schema.optionalKey(Schema.Boolean),
});
const BoardPost = Schema.Struct({
  ...SinkTarget,
  topicId: Id,
  text: NonEmpty,
  tags: Schema.optionalKey(Schema.Array(Id)),
});
const BoardTopic = Schema.Struct({
  ...SinkTarget,
  topicId: Id,
  upToPosition: Schema.optionalKey(NonNegativeInt),
});
const BoardTags = Schema.Struct({
  ...SinkTarget,
  topicId: Schema.optionalKey(Id),
});
const BoardNotify = Schema.Struct({
  ...SinkTarget,
  topicId: Schema.optionalKey(Id),
});
const PadRead = Schema.Struct({
  ...SinkTarget,
  pinId: Schema.optionalKey(Id),
});
const PadPatchArgs = Schema.Struct({
  ...SinkTarget,
  patches: Schema.Array(PadPatch).pipe(Schema.check(Schema.isMinLength(1))),
});
const PadPin = Schema.Struct({
  ...SinkTarget,
  pinId: Id,
});
const PadGet = Schema.Struct({
  ...SinkTarget,
  id: Schema.optionalKey(Id),
});
const SheetConfigure = Schema.Struct({
  ...SinkTarget,
  sheet: SheetGrid,
});
const ContentAccess = Schema.Struct({
  ...SinkTarget,
  task: Id,
  ref: ContentRef,
});
const ContentMaterialize = Schema.Struct({
  ...SinkTarget,
  task: Id,
  ref: ContentRef,
  name: Schema.optionalKey(Schema.String),
});
const ContentIngest = Schema.Struct({
  ...CanvasOptional,
  bytesBase64: NonEmpty,
  mediaType: NonEmpty.pipe(Schema.check(Schema.isMaxLength(255))),
  displayName: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(255)))),
  expected: Schema.optionalKey(ContentIdentity),
});

// Native work surfaces ------------------------------------------------------

const OptionalNodeTarget = Schema.Struct({
  ...CanvasOptional,
  nodeId: Schema.optionalKey(Id),
});
const OutputTarget = Schema.Struct({
  ...NodeTarget,
  tailBytes: Schema.optionalKey(
    NonNegativeInt.pipe(Schema.check(Schema.isLessThanOrEqualTo(1024 * 1024))),
  ),
});
const AgentPrompt = Schema.Struct({
  ...NodeTarget,
  text: NonEmpty,
});
/**
 * Put another agent on the same seat, keeping its wires and mailbox, by
 * naming what it runs: the same choices a seat draft names. Main works out
 * the agent key, the launch and the new session; an agent never writes a
 * command line for a seat. The seat keeps the directory it starts in.
 */
const AgentReseat = Schema.Struct({
  ...NodeTarget,
  ...Struct.pick(SeatDraft.fields, [
    "harness",
    "host",
    "profile",
    "model",
    "effort",
    "mode",
    "permissionMode",
  ]),
});
const TerminalInput = Schema.Struct({
  ...NodeTarget,
  data: Schema.String,
  encoding: Schema.optionalKey(Schema.Literals(["utf8", "base64"])),
});
const TerminalResize = Schema.Struct({
  ...NodeTarget,
  cols: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0))),
  rows: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0))),
});
const PageSession = Schema.Struct({ sessionId: Id });
const PageGoto = Schema.Struct({ sessionId: Id, url: NonEmpty });
const PageEval = Schema.Struct({ sessionId: Id, code: NonEmpty });
/** The model edit of the two kinds that fire on their own: a cron or a watcher. */
const SchedulerEdit = Schema.Union(
  NodeEdit.members.filter((member) =>
    ["cron", "watcher"].includes(member.fields.kind.literal),
  ),
);
const SchedulerConfigure = Schema.Struct({ ...NodeTarget, change: SchedulerEdit });
const GitTarget = Schema.Struct({ ...NodeTarget });
const GitLog = Schema.Struct({
  ...NodeTarget,
  limit: Schema.optionalKey(
    NonNegativeInt.pipe(Schema.check(Schema.isLessThanOrEqualTo(1_000))),
  ),
});
const GitShow = Schema.Struct({ ...NodeTarget, sha: NonEmpty });

// Operator offboard ---------------------------------------------------------
// Every shape here is the operation's own (`seat-offboard.ts`): the buttons,
// the automatic rules and these commands go through one entry point.

const OffboardSeats = Schema.Array(Id).pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(SEAT_OFFBOARD_MAX_SEATS)),
);

const AgentOffboard = Schema.Struct({
  ...CanvasOptional,
  nodeIds: OffboardSeats,
  /** ask: the seat's agent is asked to offboard. now: Junto ends the session. Defaults to ask. */
  action: Schema.optionalKey(Schema.Literals(SEAT_OFFBOARD_ACTIONS)),
  /** How an asked seat offboards. Defaults to continue. Only with ask. */
  mode: Schema.optionalKey(Schema.Literals(OFFBOARD_MODES)),
}).pipe(
  Schema.check(Schema.makeFilter(({ action, mode }) =>
    mode === undefined || action !== "now" ||
    "mode is only allowed when action is ask: offboard now takes no mode")),
);
const AgentOffboardStatus = Schema.Struct({ ...CanvasOptional, nodeIds: OffboardSeats });

// Region environment --------------------------------------------------------

/**
 * A source as a caller writes it: the model's own `EnvSource`, with
 * the id left to main when absent. Derived, never a second copy of the shape.
 */
type WithOptionalId<Source> = Source extends { readonly id: string }
  ? Omit<Source, "id"> & { readonly id?: string }
  : never;
export type OverseerEnvSourceDraft = WithOptionalId<EnvSource>;

// Mapping the members loses which fields belong to which kind, so the type
// is stated by distribution over the same union the schema is built from.
export const OverseerEnvSourceDraft = Schema.Union(
  EnvSource.members.map((member) =>
    member.mapFields((fields) => ({
      ...Struct.omit(fields, ["id"]),
      id: Schema.optionalKey(fields.id),
    })),
  ),
) as unknown as Schema.Codec<OverseerEnvSourceDraft>;

const EnvSourceAdd = Schema.Struct({
  ...NodeTarget,
  source: OverseerEnvSourceDraft,
  index: Schema.optionalKey(NonNegativeInt),
});
const EnvSourceEdit = Schema.Struct({
  ...NodeTarget,
  sourceId: Id,
  source: OverseerEnvSourceDraft,
});
const EnvSourceRemove = Schema.Struct({ ...NodeTarget, sourceId: Id });
const EnvSourceReorder = Schema.Struct({
  ...NodeTarget,
  sourceIds: Schema.Array(Id),
});
const EnvSeal = Schema.Struct({ ...NodeTarget, sealed: Schema.Boolean });
const EnvFolders = Schema.Struct({ ...NodeTarget, folders: Schema.Array(NonEmpty) });
const EnvDoctor = Schema.Struct({
  ...CanvasOptional,
  nodeId: Schema.optionalKey(Id),
});

// Junto's own secret store, on the machine that runs the command. The value
// is the one argument in this contract that is never echoed: see
// `decodeOverseerArgs`.
const SecretId = Schema.String.pipe(
  Schema.check(Schema.isPattern(SECRET_ID_PATTERN, { message: "a secret id is a UUID" })),
);
const SecretValue = Schema.String.pipe(
  Schema.check(Schema.makeFilter((value: string) => secretValueProblem(value) ?? true)),
);
const SecretIdentity = Schema.Struct({ secretId: SecretId });
/** `secretId` replaces the value behind that id; without one, the store mints it. */
const SecretPut = Schema.Struct({ secretId: Schema.optionalKey(SecretId), value: SecretValue });

/**
 * What `junto overseer secret put` takes as its JSON argument. The value is
 * not in it: the CLI reads the value from stdin and adds it on the wire.
 */
export const OverseerSecretPutInput = Schema.Struct({
  secretId: Schema.optionalKey(SecretId),
});
export type OverseerSecretPutInput = typeof OverseerSecretPutInput.Type;

// The operator's texts (`@shared/references`). No `regionId` is the app-wide
// references; with one, that region's, on `canvas` or the overseer's own.
// A name is normalized and judged by the store, so its reason reads the same
// to an overseer as to the operator.
const ReferencePlaceArgs = {
  canvas: Schema.optionalKey(CanvasName),
  regionId: Schema.optionalKey(Id),
} as const;
const ReferenceNamed = { name: NonEmpty, ...ReferencePlaceArgs } as const;
const ReferencesWrite = Schema.Struct({
  ...ReferenceNamed,
  description: Schema.optionalKey(Schema.String),
  body: Schema.String,
});
const BriefingWrite = Schema.Struct({ body: Schema.String });

/**
 * What `junto overseer references write` and `briefing write` take as their
 * JSON argument. The body is prose: it comes from `--body <text | @file | ->`
 * so it never has to be JSON-escaped, or as `body` here, never both.
 */
export const OverseerReferencesWriteInput = Schema.Struct({
  ...ReferenceNamed,
  description: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.String),
});
export const OverseerBriefingWriteInput = Schema.Struct({
  body: Schema.optionalKey(Schema.String),
});

/**
 * One strict schema per operation. This registry is the dispatcher source of
 * truth and the CLI's offline schema catalog. Unknown/excess fields fail.
 */
export const OverseerArgsSchemas = {
  status: EmptyArgs,
  "canvas.list": EmptyArgs,
  "canvas.read": Schema.Struct(CanvasOptional),
  "canvas.create": Schema.Struct(CanvasRequired),
  "canvas.batch": OverseerCanvasBatch,
  "canvas.delete": Schema.Struct(CanvasRequired),
  "canvas.digest": Schema.Struct(CanvasOptional),
  "canvas.render": Schema.Struct(CanvasOptional),
  "canvas.screenshot": Schema.Struct({ ...CanvasOptional, nodeId: Schema.optionalKey(Id) }),
  "node.list": Schema.Struct(CanvasOptional),
  "node.get": Schema.Struct(NodeTarget),
  "node.create": Schema.Struct({ ...CanvasOptional, ...NodeCreate }),
  "node.configure": Schema.Struct({ ...CanvasOptional, ...NodeConfigure }),
  "node.move": Schema.Struct({ ...CanvasOptional, ...NodeMove }),
  "node.resize": Schema.Struct({ ...CanvasOptional, ...NodeResize }),
  "node.recolor": Schema.Struct({ ...CanvasOptional, ...NodeRecolor }),
  "node.delete": Schema.Struct({ ...CanvasOptional, ...NodeDelete }),
  "wire.list": Schema.Struct(CanvasOptional),
  "wire.get": Schema.Struct({ ...CanvasOptional, wireId: Id }),
  "wire.verbs": Schema.Struct({
    ...CanvasOptional,
    from: Schema.optionalKey(Id),
    to: Schema.optionalKey(Id),
  }),
  "wire.connect": Schema.Struct({ ...CanvasOptional, ...WireConnect }),
  "wire.configure": Schema.Struct({ ...CanvasOptional, ...WireConfigure }),
  "wire.disconnect": Schema.Struct({ ...CanvasOptional, ...WireDisconnect }),
  "tasks.list": Schema.Struct(SinkTarget),
  "tasks.create": TaskCreate,
  "tasks.claim": TaskClaim,
  "tasks.describe": TaskDescribe,
  "tasks.update": TaskUpdate,
  "tasks.show": TaskIdentity,
  "tasks.rules": Schema.Struct({ ...SinkTarget, task: Schema.optionalKey(Id) }),
  "tasks.check": TaskCheck,
  "tasks.promote": TaskPromote,
  "tasks.comment": TaskComment,
  "tasks.respond": TaskRespond,
  "request.list": Schema.Struct(SinkTarget),
  "request.get": RequestIdentity,
  "request.create": RequestCreate,
  "request.resolve": RequestResolve,
  "request.comment": RequestComment,
  "artifact.list": Schema.Struct(SinkTarget),
  "artifact.get": ArtifactIdentity,
  "artifact.publish": ArtifactPublish,
  "artifact.archive": ArtifactArchive,
  "artifact.delete": ArtifactIdentity,
  "msg.list": MessageList,
  "msg.send": MessageSend,
  "msg.read": MessageRead,
  "msg.reply": MessageReply,
  "msg.react": MessageReact,
  "board.list": BoardList,
  "board.create-topic": BoardCreateTopic,
  "board.post": BoardPost,
  "board.mark-read": BoardTopic,
  "board.tags": BoardTags,
  "board.notify": BoardNotify,
  "pad.read": PadRead,
  "pad.patch": PadPatchArgs,
  "pad.digest": Schema.Struct(SinkTarget),
  "pad.render": Schema.Struct(SinkTarget),
  "pad.look-here": PadPin,
  "pad.get": PadGet,
  "pad.tagged": Schema.Struct(SinkTarget),
  "sheet.read": Schema.Struct(SinkTarget),
  "sheet.configure": SheetConfigure,
  "content.ingest": ContentIngest,
  "content.path": ContentAccess,
  "content.stat": ContentAccess,
  "content.materialize": ContentMaterialize,
  "agent.list": Schema.Struct(CanvasOptional),
  "agent.get": Schema.Struct(NodeTarget),
  "agent.reseat": AgentReseat,
  "agent.start": Schema.Struct(NodeTarget),
  "agent.wake": Schema.Struct(NodeTarget),
  "agent.prompt": AgentPrompt,
  "agent.output": OutputTarget,
  "agent.interrupt": Schema.Struct(NodeTarget),
  "agent.stop": Schema.Struct(NodeTarget),
  "terminal.list": OptionalNodeTarget,
  "terminal.get": Schema.Struct(NodeTarget),
  "terminal.start": Schema.Struct(NodeTarget),
  "terminal.input": TerminalInput,
  "terminal.output": OutputTarget,
  "terminal.resize": TerminalResize,
  "terminal.interrupt": Schema.Struct(NodeTarget),
  "terminal.stop": Schema.Struct(NodeTarget),
  "page.list": Schema.Struct(CanvasOptional),
  "page.get": Schema.Struct(NodeTarget),
  "page.open": Schema.Struct(NodeTarget),
  "page.goto": PageGoto,
  "page.eval": PageEval,
  "page.screenshot": PageSession,
  "page.close": PageSession,
  "page.stop": PageSession,
  "scheduler.fire": Schema.Struct(NodeTarget),
  "scheduler.status": Schema.Struct(NodeTarget),
  "scheduler.configure": SchedulerConfigure,
  "git.status": GitTarget,
  "git.log": GitLog,
  "git.show": GitShow,
  "env.show": Schema.Struct(NodeTarget),
  "env.source-add": EnvSourceAdd,
  "env.source-edit": EnvSourceEdit,
  "env.source-remove": EnvSourceRemove,
  "env.source-reorder": EnvSourceReorder,
  "env.seal": EnvSeal,
  "env.folders": EnvFolders,
  "env.doctor": EnvDoctor,
  "secret.put": SecretPut,
  "secret.delete": SecretIdentity,
  "secret.list": EmptyArgs,
  "agent.offboard": AgentOffboard,
  "agent.offboard-status": AgentOffboardStatus,
  "agent.offboard-rules": EmptyArgs,
  "agent.offboard-configure": OffboardRulesPatch,
  "references.list": Schema.Struct(ReferencePlaceArgs),
  "references.read": Schema.Struct(ReferenceNamed),
  "references.write": ReferencesWrite,
  "references.delete": Schema.Struct(ReferenceNamed),
  "briefing.read": EmptyArgs,
  "briefing.write": BriefingWrite,
} as const satisfies Record<OverseerOperation, Schema.Top>;

export type OverseerArgsFor<Operation extends OverseerOperation> =
  (typeof OverseerArgsSchemas)[Operation]["Type"];

export const decodeOverseerCaller = Schema.decodeUnknownResult(OverseerCaller, {
  onExcessProperty: "error",
});

export const decodeOverseerRequest = Schema.decodeUnknownResult(OverseerRequest, {
  onExcessProperty: "error",
});

export const decodeOverseerResult = Schema.decodeUnknownResult(OverseerResult, {
  onExcessProperty: "error",
});

/** Why an operation's args did not decode. Every caller reports `message`. */
export type OverseerArgsFailure = { readonly message: string };

/**
 * Operations whose args carry a secret value. A decode failure for one of
 * these says only what shape was expected: a schema message describes what
 * it received, and what it received here must never be repeated.
 */
export const OVERSEER_SECRET_ARGS_OPERATIONS: ReadonlySet<OverseerOperation> =
  new Set<OverseerOperation>(["secret.put"]);

export const OVERSEER_SECRET_ARGS_FAILURE =
  "secret.put takes {secretId?, value} and nothing else: an optional UUID and a non-empty value of at most 64 KB without a NUL character";

/** Decode an operation's opaque envelope args against its exact schema. */
export const decodeOverseerArgs = <Operation extends OverseerOperation>(
  operation: Operation,
  args: unknown,
): Result.Result<OverseerArgsFor<Operation>, OverseerArgsFailure> => {
  const decoded = Schema.decodeUnknownResult(OverseerArgsSchemas[operation] as never, {
    onExcessProperty: "error",
  })(args ?? {}) as Result.Result<OverseerArgsFor<Operation>, Schema.SchemaError>;
  return Result.isFailure(decoded) && OVERSEER_SECRET_ARGS_OPERATIONS.has(operation)
    ? Result.fail({ message: OVERSEER_SECRET_ARGS_FAILURE })
    : decoded;
};

export type OverseerCatalogEntry = {
  readonly operation: OverseerOperation;
  readonly family: string;
  readonly verb: string;
  readonly mutation: boolean;
};

export const OVERSEER_READ_ONLY_OPERATIONS = [
  "status",
  "canvas.list",
  "canvas.read",
  "canvas.digest",
  "canvas.render",
  "node.list",
  "node.get",
  "wire.list",
  "wire.get",
  "wire.verbs",
  "tasks.list",
  "tasks.show",
  "tasks.rules",
  "request.list",
  "request.get",
  "artifact.list",
  "artifact.get",
  "board.list",
  "board.tags",
  "pad.digest",
  "pad.render",
  "pad.get",
  "pad.tagged",
  "sheet.read",
  "content.path",
  "content.stat",
  "agent.list",
  "agent.get",
  "agent.output",
  "terminal.list",
  "terminal.get",
  "terminal.output",
  "page.list",
  "page.get",
  "scheduler.status",
  "git.status",
  "git.log",
  "git.show",
  "env.show",
  "env.doctor",
  "secret.list",
  "agent.offboard-status",
  "agent.offboard-rules",
  "references.list",
  "references.read",
  "briefing.read",
] as const satisfies ReadonlyArray<OverseerOperation>;

const READ_ONLY_OPERATIONS = new Set<OverseerOperation>(
  OVERSEER_READ_ONLY_OPERATIONS,
);

export const isOverseerMutation = (
  operation: OverseerOperation,
): boolean => !READ_ONLY_OPERATIONS.has(operation);

/** Stable family/verb catalog used by offline CLI discovery. */
/**
 * The operations this build actually exposes. A feature-gated family leaves
 * the catalog — and with it the CLI families, the offline schema/example
 * lists, and the live `overseer status` command list. The full vocabulary
 * above stays as the type surface, so a gated name still has its schema.
 */
export const OVERSEER_CATALOG: ReadonlyArray<OverseerCatalogEntry> =
  OVERSEER_OPERATION_NAMES.map((operation) => {
    const split = operation.indexOf(".");
    const family = split === -1 ? "overseer" : operation.slice(0, split);
    const verb = split === -1 ? operation : operation.slice(split + 1);
    return {
      operation,
      family,
      verb,
      mutation: isOverseerMutation(operation),
    };
  }).filter((entry) => overseerOperationEnabled(entry.operation));
