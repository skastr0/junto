import { Result, Schema } from "effect";
import {
  CanvasColor,
  EdgeEnd,
  EtherBrowser,
  EtherEntity,
  EtherFlag,
  EtherGit,
  EtherHostId,
  EtherRegion,
  EtherTerminal,
  EtherTimer,
  EtherWatch,
  NodeSide,
} from "./canvas";
import { ContentIdentity, ContentRef } from "./content";
import { HarnessId } from "./managed-terminal-templates";
import { PadPatch } from "./pad";
import { Verb } from "./physics/verbs";
import { EtherSheet } from "./sheet";
import {
  CompletionEvidence,
  FinishCriteria,
  Part,
  TaskAdmission,
  TaskRule,
  TaskState,
  TasksContract,
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
  "node.delete",
  "edge.list",
  "edge.get",
  "edge.verbs",
  "edge.connect",
  "edge.configure",
  "edge.disconnect",
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
] as const;

export const OverseerOperation = Schema.Literals(OVERSEER_OPERATION_NAMES);
export type OverseerOperation = typeof OverseerOperation.Type;

export const OverseerRequest = Schema.Struct({
  operation: OverseerOperation,
  args: Schema.optionalKey(Schema.Unknown),
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

// Canvas/node/edge authoring -------------------------------------------------

const AuthorialTasks = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  contract: Schema.optionalKey(TasksContract),
});

/** Deliberately enumerated: no overseer grant field can enter create/configure. */
export const OverseerNodeEther = Schema.Struct({
  entity: Schema.optionalKey(EtherEntity),
  flags: Schema.optionalKey(Schema.Array(EtherFlag)),
  region: Schema.optionalKey(EtherRegion),
  watch: Schema.optionalKey(EtherWatch),
  timer: Schema.optionalKey(EtherTimer),
  tasks: Schema.optionalKey(AuthorialTasks),
  sheet: Schema.optionalKey(EtherSheet),
  terminal: Schema.optionalKey(EtherTerminal),
  browser: Schema.optionalKey(EtherBrowser),
  git: Schema.optionalKey(EtherGit),
  host: Schema.optionalKey(EtherHostId),
});
export type OverseerNodeEther = typeof OverseerNodeEther.Type;

/** Safe extension patch. The dispatcher merges these fields and preserves grants. */
export const OverseerNodeEtherChanges = Schema.Struct({
  entity: Schema.optionalKey(Schema.NullOr(EtherEntity)),
  flags: Schema.optionalKey(Schema.NullOr(Schema.Array(EtherFlag))),
  region: Schema.optionalKey(Schema.NullOr(EtherRegion)),
  watch: Schema.optionalKey(Schema.NullOr(EtherWatch)),
  timer: Schema.optionalKey(Schema.NullOr(EtherTimer)),
  tasks: Schema.optionalKey(Schema.NullOr(AuthorialTasks)),
  sheet: Schema.optionalKey(Schema.NullOr(EtherSheet)),
  terminal: Schema.optionalKey(Schema.NullOr(EtherTerminal)),
  browser: Schema.optionalKey(Schema.NullOr(EtherBrowser)),
  git: Schema.optionalKey(Schema.NullOr(EtherGit)),
  host: Schema.optionalKey(Schema.NullOr(EtherHostId)),
});
export type OverseerNodeEtherChanges = typeof OverseerNodeEtherChanges.Type;

const NodeDraftBase = {
  id: Schema.optionalKey(Id),
  x: Finite,
  y: Finite,
  width: Positive,
  height: Positive,
  color: Schema.optionalKey(CanvasColor),
  ether: Schema.optionalKey(OverseerNodeEther),
} as const;

/** Strict JSON Canvas node input; main may mint the omitted id. */
export const OverseerNodeDraft = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String, ...NodeDraftBase }),
  Schema.Struct({
    type: Schema.Literal("file"),
    file: Schema.String,
    subpath: Schema.optionalKey(Schema.String),
    ...NodeDraftBase,
  }),
  Schema.Struct({ type: Schema.Literal("link"), url: Schema.String, ...NodeDraftBase }),
  Schema.Struct({
    type: Schema.Literal("group"),
    label: Schema.optionalKey(Schema.String),
    background: Schema.optionalKey(Schema.String),
    backgroundStyle: Schema.optionalKey(Schema.Literals(["cover", "ratio", "repeat"])),
    ...NodeDraftBase,
  }),
]);
export type OverseerNodeDraft = typeof OverseerNodeDraft.Type;

export const OverseerNodeChanges = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  file: Schema.optionalKey(Schema.String),
  subpath: Schema.optionalKey(Schema.NullOr(Schema.String)),
  url: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.NullOr(Schema.String)),
  background: Schema.optionalKey(Schema.NullOr(Schema.String)),
  backgroundStyle: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["cover", "ratio", "repeat"])),
  ),
  color: Schema.optionalKey(Schema.NullOr(CanvasColor)),
  ether: Schema.optionalKey(OverseerNodeEtherChanges),
});
export type OverseerNodeChanges = typeof OverseerNodeChanges.Type;

const EdgePresentation = {
  fromSide: Schema.optionalKey(NodeSide),
  fromEnd: Schema.optionalKey(EdgeEnd),
  toSide: Schema.optionalKey(NodeSide),
  toEnd: Schema.optionalKey(EdgeEnd),
  color: Schema.optionalKey(CanvasColor),
  label: Schema.optionalKey(Schema.String),
} as const;

export const OverseerEdgeDraft = Schema.Struct({
  id: Schema.optionalKey(Id),
  fromNode: Id,
  toNode: Id,
  verb: Verb,
  ...EdgePresentation,
});
export type OverseerEdgeDraft = typeof OverseerEdgeDraft.Type;

export const OverseerEdgeChanges = Schema.Struct({
  verb: Schema.optionalKey(Verb),
  fromSide: Schema.optionalKey(Schema.NullOr(NodeSide)),
  fromEnd: Schema.optionalKey(Schema.NullOr(EdgeEnd)),
  toSide: Schema.optionalKey(Schema.NullOr(NodeSide)),
  toEnd: Schema.optionalKey(Schema.NullOr(EdgeEnd)),
  color: Schema.optionalKey(Schema.NullOr(CanvasColor)),
  label: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type OverseerEdgeChanges = typeof OverseerEdgeChanges.Type;

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
  sheet: EtherSheet,
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
const AgentReseat = Schema.Struct({
  ...NodeTarget,
  harness: HarnessId,
  profile: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(Schema.String),
  permissionMode: Schema.optionalKey(Schema.String),
  host: Schema.optionalKey(EtherHostId),
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
const SchedulerConfigure = Schema.Struct({
  ...NodeTarget,
  timer: Schema.optionalKey(Schema.NullOr(EtherTimer)),
  watch: Schema.optionalKey(Schema.NullOr(EtherWatch)),
});
const GitTarget = Schema.Struct({ ...NodeTarget });
const GitLog = Schema.Struct({
  ...NodeTarget,
  limit: Schema.optionalKey(
    NonNegativeInt.pipe(Schema.check(Schema.isLessThanOrEqualTo(1_000))),
  ),
});
const GitShow = Schema.Struct({ ...NodeTarget, sha: NonEmpty });

/**
 * One strict schema per operation. This registry is the dispatcher source of
 * truth and the CLI's offline schema catalog. Unknown/excess fields fail.
 */
export const OverseerArgsSchemas = {
  status: EmptyArgs,
  "canvas.list": EmptyArgs,
  "canvas.read": Schema.Struct(CanvasOptional),
  "canvas.create": Schema.Struct(CanvasRequired),
  "canvas.delete": Schema.Struct(CanvasRequired),
  "canvas.digest": Schema.Struct(CanvasOptional),
  "canvas.render": Schema.Struct(CanvasOptional),
  "canvas.screenshot": Schema.Struct({ ...CanvasOptional, nodeId: Schema.optionalKey(Id) }),
  "node.list": Schema.Struct(CanvasOptional),
  "node.get": Schema.Struct(NodeTarget),
  "node.create": Schema.Struct({ ...CanvasOptional, node: OverseerNodeDraft }),
  "node.configure": Schema.Struct({ ...NodeTarget, changes: OverseerNodeChanges }),
  "node.move": Schema.Struct({ ...NodeTarget, x: Finite, y: Finite }),
  "node.resize": Schema.Struct({ ...NodeTarget, width: Positive, height: Positive }),
  "node.delete": Schema.Struct(NodeTarget),
  "edge.list": Schema.Struct(CanvasOptional),
  "edge.get": Schema.Struct({ ...CanvasOptional, edgeId: Id }),
  "edge.verbs": Schema.Struct({
    ...CanvasOptional,
    fromNode: Schema.optionalKey(Id),
    toNode: Schema.optionalKey(Id),
  }),
  "edge.connect": Schema.Struct({ ...CanvasOptional, edge: OverseerEdgeDraft }),
  "edge.configure": Schema.Struct({
    ...CanvasOptional,
    edgeId: Id,
    changes: OverseerEdgeChanges,
  }),
  "edge.disconnect": Schema.Struct({ ...CanvasOptional, edgeId: Id }),
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

/** Decode an operation's opaque envelope args against its exact schema. */
export const decodeOverseerArgs = <Operation extends OverseerOperation>(
  operation: Operation,
  args: unknown,
): Result.Result<OverseerArgsFor<Operation>, Schema.SchemaError> =>
  Schema.decodeUnknownResult(OverseerArgsSchemas[operation] as never, {
    onExcessProperty: "error",
  })(args ?? {}) as Result.Result<OverseerArgsFor<Operation>, Schema.SchemaError>;

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
  "edge.list",
  "edge.get",
  "edge.verbs",
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
] as const satisfies ReadonlyArray<OverseerOperation>;

const READ_ONLY_OPERATIONS = new Set<OverseerOperation>(
  OVERSEER_READ_ONLY_OPERATIONS,
);

export const isOverseerMutation = (
  operation: OverseerOperation,
): boolean => !READ_ONLY_OPERATIONS.has(operation);

/** Stable family/verb catalog used by offline CLI discovery. */
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
  });
