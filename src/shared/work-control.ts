import { Either, Schema } from "effect";
import { TaskState, WorkMetadata } from "./canvas";
import {
  CompletionEvidence,
  ContentPart,
  FinishCriteria,
  RawPart,
} from "./work-model";
import { ContentRef } from "./content";

// Work control-plane wire contract: NDJSON frames over a local Unix domain
// socket at ~/.vellum/work/control.sock. Pure module — no Node imports — so
// the Electron-hosted daemon, the standalone CLI, and tests share one source
// of truth. Transport is owner-local only; every request carries a bearer
// token. Domain mutations route through WorkService — this file only knows
// shapes, paths-as-strings, and admission bounds.

// ---------------------------------------------------------------------------
// Paths (functions of home so the module stays platform-pure)

/** Default dir: `~/.vellum/work`. Tests override with `VELLUM_WORK_HOME`. */
export const workControlDir = (home: string): string => `${home}/.vellum/work`;

export const workControlSocketPath = (workHome: string): string =>
  `${workHome}/control.sock`;

export const workControlTokenPath = (workHome: string): string =>
  `${workHome}/token`;

export const WORK_HOME_ENV = "VELLUM_WORK_HOME";
export const WORK_PROTOCOL_VERSION = "vellum-work/v1";

export const WORK_DEFAULT_BATCH_CONCURRENCY = 5;
export const WORK_DEFAULT_TIMEOUT_MS = 30_000;
export const WORK_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const WORK_MAX_ERROR_BYTES = 4_096;

// ---------------------------------------------------------------------------
// Ops

export const WorkOpName = Schema.Literal(
  "ping",
  "doctor",
  "capabilities",
  "onboard",
  "preamble",
  "tasks.list",
  "tasks.create",
  "tasks.claim",
  "tasks.update",
  "content.path",
  "content.stat",
  "content.materialize",
  "msg.list",
  "msg.send",
  "msg.read",
  "msg.reply",
  "request.escalate",
  "artifact.publish",
  "board.list",
  "board.create_topic",
  "board.post",
  "board.mark_read",
);
export type WorkOpName = typeof WorkOpName.Type;

// ---------------------------------------------------------------------------
// Error family (wire + CLI). Exhaustive at the boundary.

export const WorkErrorType = Schema.Literal(
  "ScopeError",
  "ClaimConflict",
  "UnknownTarget",
  "StaleNodeRef",
  "InvalidTransition",
  "RuntimeDown",
  "AuthError",
  "InputError",
  "ProtocolError",
  "InternalError",
  "Paused",
  "Blocked",
);
export type WorkErrorType = typeof WorkErrorType.Type;

export const WorkErrorDetails = Schema.Struct({
  path: Schema.optionalWith(Schema.String, { exact: true }),
  expected: Schema.optionalWith(Schema.Unknown, { exact: true }),
  received: Schema.optionalWith(Schema.Unknown, { exact: true }),
  hint: Schema.optionalWith(Schema.String, { exact: true }),
  next_step: Schema.optionalWith(Schema.String, { exact: true }),
  retryable: Schema.optionalWith(Schema.Boolean, { exact: true }),
  from: Schema.optionalWith(Schema.String, { exact: true }),
  to: Schema.optionalWith(Schema.String, { exact: true }),
  holder: Schema.optionalWith(Schema.String, { exact: true }),
  target: Schema.optionalWith(Schema.String, { exact: true }),
  caller: Schema.optionalWith(Schema.String, { exact: true }),
  missing: Schema.optionalWith(Schema.String, { exact: true }),
  /** Open escalate request id when type === Blocked. */
  requestId: Schema.optionalWith(Schema.String, { exact: true }),
  /** Machine-readable stop instruction for harness tools (Blocked / escalate). */
  stop_directive: Schema.optionalWith(Schema.Unknown, { exact: true }),
});
export type WorkErrorDetails = typeof WorkErrorDetails.Type;

export const WorkErrorBody = Schema.Struct({
  type: WorkErrorType,
  message: Schema.String,
  details: Schema.optionalWith(WorkErrorDetails, { exact: true }),
});
export type WorkErrorBody = typeof WorkErrorBody.Type;

// ---------------------------------------------------------------------------
// Request / response envelopes (wire)

export const WorkRequestEnvelope = Schema.Struct({
  token: Schema.String,
  op: WorkOpName,
  args: Schema.optionalWith(Schema.Unknown, { exact: true }),
  id: Schema.optionalWith(Schema.String, { exact: true }),
});
export type WorkRequestEnvelope = typeof WorkRequestEnvelope.Type;

export const WorkResponseOk = Schema.Struct({
  ok: Schema.Literal(true),
  op: WorkOpName,
  data: Schema.Unknown,
  id: Schema.optionalWith(Schema.String, { exact: true }),
  protocol_version: Schema.optionalWith(Schema.String, { exact: true }),
});
export type WorkResponseOk = typeof WorkResponseOk.Type;

export const WorkResponseErr = Schema.Struct({
  ok: Schema.Literal(false),
  op: Schema.optionalWith(WorkOpName, { exact: true }),
  error: WorkErrorBody,
  id: Schema.optionalWith(Schema.String, { exact: true }),
  protocol_version: Schema.optionalWith(Schema.String, { exact: true }),
});
export type WorkResponseErr = typeof WorkResponseErr.Type;

export const WorkResponseEnvelope = Schema.Union(WorkResponseOk, WorkResponseErr);
export type WorkResponseEnvelope = typeof WorkResponseEnvelope.Type;

export const decodeWorkRequest = Schema.decodeUnknownEither(WorkRequestEnvelope, {
  onExcessProperty: "error",
});
export const decodeWorkResponse = Schema.decodeUnknownEither(
  WorkResponseEnvelope,
  { onExcessProperty: "error" },
);

export const workOk = (
  op: WorkOpName,
  data: unknown,
  id?: string,
): WorkResponseOk => ({
  ok: true,
  op,
  data,
  protocol_version: WORK_PROTOCOL_VERSION,
  ...(id !== undefined ? { id } : {}),
});

export const workErr = (
  type: WorkErrorType,
  message: string,
  details?: WorkErrorDetails,
  op?: WorkOpName,
  id?: string,
): WorkResponseErr => ({
  ok: false,
  error: {
    type,
    message,
    ...(details !== undefined ? { details } : {}),
  },
  protocol_version: WORK_PROTOCOL_VERSION,
  ...(op !== undefined ? { op } : {}),
  ...(id !== undefined ? { id } : {}),
});

// ---------------------------------------------------------------------------
// Domain arg schemas (shared by CLI input + daemon decode)

export const TasksListArgs = Schema.Struct({
  target: Schema.String,
});
export type TasksListArgs = typeof TasksListArgs.Type;

/**
 * Author a pending proposal for operator review.
 *
 * Same authoring contract as executable task creation (`workTaskCreate` /
 * `workTaskPropose`): brief + optional reason/metadata/media/dependsOn/
 * finishCriteria. Only approval mints a submitted Task; proposal-only fields
 * (`proposedBy`, `approvedTaskId`, proposal state) are server-owned.
 */
export const TasksCreateArgs = Schema.Struct({
  target: Schema.String,
  brief: Schema.String,
  reason: Schema.optionalWith(Schema.String, { exact: true }),
  metadata: Schema.optionalWith(WorkMetadata, { exact: true }),
  /** First-class media on the brief. RawPart decodes for legacy clients but is rejected at durable write. */
  media: Schema.optionalWith(Schema.Array(Schema.Union(RawPart, ContentPart)), {
    exact: true,
  }),
  /** Same-sink hard prerequisites (task ids). Carried onto minted Task on approve. */
  dependsOn: Schema.optionalWith(Schema.Array(Schema.String), {
    exact: true,
  }),
  /** Operator done-definition; carried onto minted Task on approve. */
  finishCriteria: Schema.optionalWith(FinishCriteria, { exact: true }),
}).annotations({
  parseOptions: { onExcessProperty: "error" },
});
export type TasksCreateArgs = typeof TasksCreateArgs.Type;

export const TasksClaimArgs = Schema.Struct({
  target: Schema.String,
  task: Schema.String,
}).annotations({
  parseOptions: { onExcessProperty: "error" },
});
export type TasksClaimArgs = typeof TasksClaimArgs.Type;

export const TasksUpdateArgs = Schema.Struct({
  target: Schema.String,
  task: Schema.String,
  state: TaskState,
  note: Schema.optionalWith(Schema.String, { exact: true }),
  completionEvidence: Schema.optionalWith(CompletionEvidence, { exact: true }),
}).pipe(
  Schema.filter(
    ({ state, completionEvidence }) =>
      completionEvidence === undefined ||
      state === "completed" ||
      "completionEvidence is only allowed when state is completed",
  ),
).annotations({
  parseOptions: { onExcessProperty: "error" },
});
export type TasksUpdateArgs = typeof TasksUpdateArgs.Type;

/** Process-bound content access always names the connected task sink. */
const StrictContentRef = ContentRef.annotations({
  parseOptions: { onExcessProperty: "error" },
});

const ContentAccessFields = {
  target: Schema.String.pipe(Schema.minLength(1)),
  task: Schema.String.pipe(Schema.minLength(1)),
  ref: StrictContentRef,
} as const;

export const ContentPathArgs = Schema.Struct(ContentAccessFields).annotations({
  parseOptions: { onExcessProperty: "error" },
});
export type ContentPathArgs = typeof ContentPathArgs.Type;

export const ContentStatArgs = Schema.Struct(ContentAccessFields).annotations({
  parseOptions: { onExcessProperty: "error" },
});
export type ContentStatArgs = typeof ContentStatArgs.Type;

export const ContentMaterializeArgs = Schema.Struct({
  ...ContentAccessFields,
  /** Optional single filename; directory components are never accepted. */
  name: Schema.optionalWith(Schema.String, { exact: true }),
}).annotations({
  parseOptions: { onExcessProperty: "error" },
});
export type ContentMaterializeArgs = typeof ContentMaterializeArgs.Type;

export const MsgListArgs = Schema.Struct({
  target: Schema.String,
  taskId: Schema.optionalWith(Schema.String, { exact: true }),
});
export type MsgListArgs = typeof MsgListArgs.Type;

export const MsgSendArgs = Schema.Struct({
  target: Schema.String,
  text: Schema.String,
  taskId: Schema.optionalWith(Schema.String, { exact: true }),
});
export type MsgSendArgs = typeof MsgSendArgs.Type;

/** Mark a mailbox message read. Target must be the caller's own seat. */
export const MsgReadArgs = Schema.Struct({
  target: Schema.String,
  messageId: Schema.String,
});
export type MsgReadArgs = typeof MsgReadArgs.Type;

/**
 * Reply to a factory-mail message: send text to target and mark inReplyTo
 * read on the caller's own mailbox.
 */
export const MsgReplyArgs = Schema.Struct({
  target: Schema.String,
  text: Schema.String,
  inReplyTo: Schema.String,
});
export type MsgReplyArgs = typeof MsgReplyArgs.Type;

/** Display a short-lived thought bubble above the process-bound agent node. */
export const PreambleArgs = Schema.Struct({
  text: Schema.String,
}).annotations({
  parseOptions: { onExcessProperty: "error" },
});
export type PreambleArgs = typeof PreambleArgs.Type;

export const RequestEscalateArgs = Schema.Struct({
  target: Schema.String,
  brief: Schema.String,
  /** Why the caller is raising this — lands first-class on the request. */
  reason: Schema.optionalWith(Schema.String, { exact: true }),
  metadata: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    { exact: true },
  ),
});
export type RequestEscalateArgs = typeof RequestEscalateArgs.Type;

/** Wire/stop payload agents understand after escalate or while Blocked. */
export type StopDirective = {
  readonly action: "stop";
  readonly reason: "awaiting_operator";
  readonly requestId: string;
  readonly target: string;
  readonly brief: string;
  readonly message: string;
  readonly next_step: string;
};

export const makeStopDirective = (input: {
  readonly requestId: string;
  readonly target: string;
  readonly brief: string;
}): StopDirective => ({
  action: "stop",
  reason: "awaiting_operator",
  requestId: input.requestId,
  target: input.target,
  brief: input.brief,
  message: `Seat is blocked waiting on request ${input.requestId}. Stop work until the operator answers — do not thrash tools.`,
  next_step:
    "Wait for the operator to answer the request on the canvas, then retry work ops (or call vellum onboard).",
});

/** Artifact wire parts: text/data stay inline; binary media is a ContentRef. */
export const ArtifactPartWire = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("url"),
    url: Schema.String,
    mediaType: Schema.optionalWith(Schema.String, { exact: true }),
  }),
  Schema.Struct({ kind: Schema.Literal("data"), data: Schema.Unknown }),
  Schema.Struct({
    kind: Schema.Literal("raw"),
    bytesBase64: Schema.String,
    mediaType: Schema.optionalWith(Schema.String, { exact: true }),
  }),
  ContentPart,
);

export const ArtifactTaskArgs = Schema.Struct({
  target: Schema.String,
  id: Schema.String,
});
export type ArtifactTaskArgs = typeof ArtifactTaskArgs.Type;

export const ArtifactPublishArgs = Schema.Struct({
  target: Schema.String,
  name: Schema.optionalWith(Schema.String, { exact: true }),
  artifactId: Schema.optionalWith(Schema.String, { exact: true }),
  parts: Schema.Array(ArtifactPartWire),
  task: Schema.optionalWith(ArtifactTaskArgs, { exact: true }),
  metadata: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    { exact: true },
  ),
});
export type ArtifactPublishArgs = typeof ArtifactPublishArgs.Type;

/** CLI-only input: legacy raw path/bytes forms decode for a fail-closed migration error. */
export const ArtifactPartCli = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("url"),
    url: Schema.String,
    mediaType: Schema.optionalWith(Schema.String, { exact: true }),
  }),
  Schema.Struct({ kind: Schema.Literal("data"), data: Schema.Unknown }),
  Schema.Struct({
    kind: Schema.Literal("raw"),
    bytesBase64: Schema.optionalWith(Schema.String, { exact: true }),
    path: Schema.optionalWith(Schema.String, { exact: true }),
    mediaType: Schema.optionalWith(Schema.String, { exact: true }),
  }),
  ContentPart,
);

export const ArtifactPublishCliArgs = Schema.Struct({
  target: Schema.String,
  name: Schema.optionalWith(Schema.String, { exact: true }),
  artifactId: Schema.optionalWith(Schema.String, { exact: true }),
  parts: Schema.Array(ArtifactPartCli),
  task: Schema.optionalWith(ArtifactTaskArgs, { exact: true }),
  metadata: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    { exact: true },
  ),
});
export type ArtifactPublishCliArgs = typeof ArtifactPublishCliArgs.Type;

export const EmptyArgs = Schema.Struct({});
export type EmptyArgs = typeof EmptyArgs.Type;

export const BoardListArgs = Schema.Struct({
  target: Schema.String,
  topicId: Schema.optionalWith(Schema.String, { exact: true }),
});
export type BoardListArgs = typeof BoardListArgs.Type;

export const BoardCreateTopicArgs = Schema.Struct({
  target: Schema.String,
  title: Schema.String,
  body: Schema.optionalWith(Schema.String, { exact: true }),
  /** Operator IPC only — agents' true is ignored (no auto wake). */
  notify: Schema.optionalWith(Schema.Boolean, { exact: true }),
});
export type BoardCreateTopicArgs = typeof BoardCreateTopicArgs.Type;

export const BoardPostArgs = Schema.Struct({
  target: Schema.String,
  topicId: Schema.String,
  text: Schema.String,
});
export type BoardPostArgs = typeof BoardPostArgs.Type;

export const BoardMarkReadArgs = Schema.Struct({
  target: Schema.String,
  topicId: Schema.String,
  /** Inclusive last post position read; omit = mark all current posts. */
  upToPosition: Schema.optionalWith(Schema.Number, { exact: true }),
});
export type BoardMarkReadArgs = typeof BoardMarkReadArgs.Type;

// ---------------------------------------------------------------------------
// Helpers

export const stripTokenFromLog = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  if ("token" in copy) copy.token = "[redacted]";
  return copy;
};

export const encodeWorkFrame = (value: unknown): string => `${JSON.stringify(value)}\n`;

export const decodeWorkJsonLine = (line: string): Either.Either<unknown, string> => {
  try {
    return Either.right(JSON.parse(line) as unknown);
  } catch {
    return Either.left("malformed JSON frame");
  }
};
