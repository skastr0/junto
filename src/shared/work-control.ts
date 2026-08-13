import { Result, Schema } from "effect";
import { TaskState, WorkMetadata } from "./canvas";
import {
  CompletionEvidence,
  ContentPart,
  FinishCriteria,
  RawPart,
} from "./work-model";
import { ContentRef } from "./content";
import { PadPatch } from "./pad";

// Work control-plane wire contract: NDJSON frames over a local Unix domain
// socket at ~/.vellum-command/work/control.sock. Pure module — no Node imports — so
// the Electron-hosted daemon, the standalone CLI, and tests share one source
// of truth. Transport is owner-local only; every request carries a bearer
// token. Domain mutations route through WorkService — this file only knows
// shapes, paths-as-strings, and admission bounds.

// ---------------------------------------------------------------------------
// Paths (functions of home so the module stays platform-pure)

/** Default dir: `~/.vellum-command/work`. Tests override with `VELLUM_COMMAND_WORK_HOME`. */
export const workControlDir = (home: string): string => `${home}/.vellum-command/work`;

export const workControlSocketPath = (workHome: string): string =>
  `${workHome}/control.sock`;

export const workControlTokenPath = (workHome: string): string =>
  `${workHome}/token`;

export const WORK_HOME_ENV = "VELLUM_COMMAND_WORK_HOME";
export const WORK_PROTOCOL_VERSION = "vellum-command-work/v1";

export const WORK_DEFAULT_BATCH_CONCURRENCY = 5;
export const WORK_DEFAULT_TIMEOUT_MS = 30_000;
export const WORK_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const WORK_MAX_ERROR_BYTES = 4_096;

// ---------------------------------------------------------------------------
// Ops

export const WorkOpName = Schema.Literals(["ping", "doctor",
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
"msg.react",
"request.escalate",
"artifact.publish",
"board.list",
"board.create_topic",
"board.post",
"board.mark_read",
"board.tags",
"pad.read",
"pad.patch",
/** Agent → relay: fire the scheduler pipeline now (port relay.trigger). */
"relay.trigger",]);
export type WorkOpName = typeof WorkOpName.Type;

// ---------------------------------------------------------------------------
// Error family (wire + CLI). Exhaustive at the boundary.

export const WorkErrorType = Schema.Literals(["ScopeError", "ClaimConflict",
"UnknownTarget",
"StaleNodeRef",
"InvalidTransition",
"RuntimeDown",
"AuthError",
"InputError",
"ProtocolError",
"InternalError",
"Paused",
"Blocked",]);
export type WorkErrorType = typeof WorkErrorType.Type;

export const WorkErrorDetails = Schema.Struct({
  path: Schema.optionalKey(Schema.String),
  expected: Schema.optionalKey(Schema.Unknown),
  received: Schema.optionalKey(Schema.Unknown),
  hint: Schema.optionalKey(Schema.String),
  next_step: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
  from: Schema.optionalKey(Schema.String),
  to: Schema.optionalKey(Schema.String),
  holder: Schema.optionalKey(Schema.String),
  target: Schema.optionalKey(Schema.String),
  caller: Schema.optionalKey(Schema.String),
  missing: Schema.optionalKey(Schema.String),
  /** Open escalate request id when type === Blocked. */
  requestId: Schema.optionalKey(Schema.String),
  /** Machine-readable stop instruction for harness tools (Blocked / escalate). */
  stop_directive: Schema.optionalKey(Schema.Unknown),
});
export type WorkErrorDetails = typeof WorkErrorDetails.Type;

export const WorkErrorBody = Schema.Struct({
  type: WorkErrorType,
  message: Schema.String,
  details: Schema.optionalKey(WorkErrorDetails),
});
export type WorkErrorBody = typeof WorkErrorBody.Type;

// ---------------------------------------------------------------------------
// Request / response envelopes (wire)

export const WorkRequestEnvelope = Schema.Struct({
  token: Schema.String,
  op: WorkOpName,
  args: Schema.optionalKey(Schema.Unknown),
  id: Schema.optionalKey(Schema.String),
});
export type WorkRequestEnvelope = typeof WorkRequestEnvelope.Type;

export const WorkResponseOk = Schema.Struct({
  ok: Schema.Literal(true),
  op: WorkOpName,
  data: Schema.Unknown,
  id: Schema.optionalKey(Schema.String),
  protocol_version: Schema.optionalKey(Schema.String),
});
export type WorkResponseOk = typeof WorkResponseOk.Type;

export const WorkResponseErr = Schema.Struct({
  ok: Schema.Literal(false),
  op: Schema.optionalKey(WorkOpName),
  error: WorkErrorBody,
  id: Schema.optionalKey(Schema.String),
  protocol_version: Schema.optionalKey(Schema.String),
});
export type WorkResponseErr = typeof WorkResponseErr.Type;

export const WorkResponseEnvelope = Schema.Union([WorkResponseOk, WorkResponseErr]);
export type WorkResponseEnvelope = typeof WorkResponseEnvelope.Type;

export const decodeWorkRequest = Schema.decodeUnknownResult(WorkRequestEnvelope, {
  onExcessProperty: "error",
});
export const decodeWorkResponse = Schema.decodeUnknownResult(
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
 * `workTaskPropose`): brief + required description (`metadata.details`) +
 * optional reason/media/dependsOn/finishCriteria. Only approval mints a
 * submitted Task; proposal-only fields (`proposedBy`, `approvedTaskId`,
 * proposal state) are server-owned.
 */
export const TasksCreateArgs = Schema.Struct({
  target: Schema.String,
  brief: Schema.String,
  reason: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(WorkMetadata),
  /** First-class media on the brief. RawPart decodes for legacy clients but is rejected at durable write. */
  media: Schema.optionalKey(Schema.Array(Schema.Union([RawPart, ContentPart]))),
  /** Same-sink hard prerequisites (task ids). Carried onto minted Task on approve. */
  dependsOn: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Operator done-definition; carried onto minted Task on approve. */
  finishCriteria: Schema.optionalKey(FinishCriteria),
}).pipe(
  Schema.check(Schema.makeFilter((args) => {
    const details = args.metadata?.details;
    return (
      (typeof details === "string" && details.trim().length > 0) ||
      "description (metadata.details) must be non-empty"
    );
  })),
).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type TasksCreateArgs = typeof TasksCreateArgs.Type;

export const TasksClaimArgs = Schema.Struct({
  target: Schema.String,
  task: Schema.String,
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type TasksClaimArgs = typeof TasksClaimArgs.Type;

export const TasksUpdateArgs = Schema.Struct({
  target: Schema.String,
  task: Schema.String,
  state: TaskState,
  note: Schema.optionalKey(Schema.String),
  completionEvidence: Schema.optionalKey(CompletionEvidence),
}).pipe(
  Schema.check(Schema.makeFilter(({ state, completionEvidence }) =>
    completionEvidence === undefined ||
    state === "completed" ||
    "completionEvidence is only allowed when state is completed",)),
).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type TasksUpdateArgs = typeof TasksUpdateArgs.Type;

/** Process-bound content access always names the connected task sink. */
const StrictContentRef = ContentRef.annotate({
  parseOptions: { onExcessProperty: "error" },
});

const ContentAccessFields = {
  target: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  task: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  ref: StrictContentRef,
} as const;

export const ContentPathArgs = Schema.Struct(ContentAccessFields).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type ContentPathArgs = typeof ContentPathArgs.Type;

export const ContentStatArgs = Schema.Struct(ContentAccessFields).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type ContentStatArgs = typeof ContentStatArgs.Type;

export const ContentMaterializeArgs = Schema.Struct({
  ...ContentAccessFields,
  /** Optional single filename; directory components are never accepted. */
  name: Schema.optionalKey(Schema.String),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type ContentMaterializeArgs = typeof ContentMaterializeArgs.Type;

export const MsgListArgs = Schema.Struct({
  /** Own inbox when omitted, own node id, or `canvas:nodeId`. */
  target: Schema.optionalKey(Schema.String),
  taskId: Schema.optionalKey(Schema.String),
});
export type MsgListArgs = typeof MsgListArgs.Type;

export const MsgSendArgs = Schema.Struct({
  target: Schema.String,
  text: Schema.String,
  taskId: Schema.optionalKey(Schema.String),
});
export type MsgSendArgs = typeof MsgSendArgs.Type;

/** Mark a mailbox message read. Target must be the caller's own seat. */
export const MsgReadArgs = Schema.Struct({
  target: Schema.optionalKey(Schema.String),
  messageId: Schema.String,
});
export type MsgReadArgs = typeof MsgReadArgs.Type;

/** Lightweight mailbox reaction. Target must be the caller's own seat. */
export const MsgReactArgs = Schema.Struct({
  target: Schema.optionalKey(Schema.String),
  messageId: Schema.String,
  reaction: Schema.optionalKey(Schema.Literals(["ack"])),
});
export type MsgReactArgs = typeof MsgReactArgs.Type;

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
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type PreambleArgs = typeof PreambleArgs.Type;

/**
 * Escalate to the operator. Brief is the title line; agents must also supply
 * a body via `reason` and/or `metadata.details` — title-only escalations are
 * rejected (same spirit as task `metadata.details` required).
 */
export const RequestEscalateArgs = Schema.Struct({
  target: Schema.String,
  brief: Schema.String,
  /** Why the caller is raising this — first-class body (preferred). */
  reason: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
}).pipe(
  Schema.check(
    Schema.makeFilter((args) => {
      const brief = args.brief.trim();
      if (!brief) return "brief must be non-empty";
      const reason =
        typeof args.reason === "string" ? args.reason.trim() : "";
      const detailsRaw = args.metadata?.details;
      const details =
        typeof detailsRaw === "string" ? detailsRaw.trim() : "";
      if (!reason && !details) {
        return "request body required: provide reason and/or metadata.details (not title-only)";
      }
      return true;
    }),
  ),
).annotate({
  parseOptions: { onExcessProperty: "error" },
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
  message: `You are blocked waiting on request ${input.requestId}. Stop work until the operator answers.`,
  next_step:
    "Wait for the operator to answer the request, then retry work ops (re-run vellum-command onboard if your view is stale).",
});

/** Artifact wire parts: text/data stay inline; binary media is a ContentRef. */
export const ArtifactPartWire = Schema.Union([Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
Schema.Struct({
  kind: Schema.Literal("url"),
  url: Schema.String,
  mediaType: Schema.optionalKey(Schema.String),
}),
Schema.Struct({ kind: Schema.Literal("data"), data: Schema.Unknown }),
Schema.Struct({
  kind: Schema.Literal("raw"),
  bytesBase64: Schema.String,
  mediaType: Schema.optionalKey(Schema.String),
}),
ContentPart,]);

export const ArtifactTaskArgs = Schema.Struct({
  target: Schema.String,
  id: Schema.String,
});
export type ArtifactTaskArgs = typeof ArtifactTaskArgs.Type;

export const ArtifactPublishArgs = Schema.Struct({
  target: Schema.String,
  name: Schema.optionalKey(Schema.String),
  artifactId: Schema.optionalKey(Schema.String),
  parts: Schema.Array(ArtifactPartWire),
  task: Schema.optionalKey(ArtifactTaskArgs),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type ArtifactPublishArgs = typeof ArtifactPublishArgs.Type;

/** CLI-only input: legacy raw path/bytes forms decode for a fail-closed migration error. */
export const ArtifactPartCli = Schema.Union([Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
Schema.Struct({
  kind: Schema.Literal("url"),
  url: Schema.String,
  mediaType: Schema.optionalKey(Schema.String),
}),
Schema.Struct({ kind: Schema.Literal("data"), data: Schema.Unknown }),
Schema.Struct({
  kind: Schema.Literal("raw"),
  bytesBase64: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  mediaType: Schema.optionalKey(Schema.String),
}),
ContentPart,]);

export const ArtifactPublishCliArgs = Schema.Struct({
  target: Schema.String,
  name: Schema.optionalKey(Schema.String),
  artifactId: Schema.optionalKey(Schema.String),
  parts: Schema.Array(ArtifactPartCli),
  task: Schema.optionalKey(ArtifactTaskArgs),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type ArtifactPublishCliArgs = typeof ArtifactPublishCliArgs.Type;

export const EmptyArgs = Schema.Struct({});
export type EmptyArgs = typeof EmptyArgs.Type;

export const BoardListArgs = Schema.Struct({
  target: Schema.String,
  topicId: Schema.optionalKey(Schema.String),
});
export type BoardListArgs = typeof BoardListArgs.Type;

export const BoardCreateTopicArgs = Schema.Struct({
  target: Schema.String,
  title: Schema.String,
  body: Schema.optionalKey(Schema.String),
  /** Operator IPC only — agents' true is ignored (no auto wake). */
  notify: Schema.optionalKey(Schema.Boolean),
});
export type BoardCreateTopicArgs = typeof BoardCreateTopicArgs.Type;

export const BoardPostArgs = Schema.Struct({
  target: Schema.String,
  topicId: Schema.String,
  text: Schema.String,
  /**
   * Canvas actor node ids to tag (soft notify via board edge wake).
   * Unknown / non-connected ids are dropped server-side.
   */
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type BoardPostArgs = typeof BoardPostArgs.Type;

/** List posts on a board that tag this process-bound seat (own tags). */
export const BoardTagsListArgs = Schema.Struct({
  target: Schema.String,
  /** Optional topic filter. */
  topicId: Schema.optionalKey(Schema.String),
});
export type BoardTagsListArgs = typeof BoardTagsListArgs.Type;

export const BoardMarkReadArgs = Schema.Struct({
  target: Schema.String,
  topicId: Schema.String,
  /** Inclusive last post position read; omit = mark all current posts. */
  upToPosition: Schema.optionalKey(Schema.Number),
});
export type BoardMarkReadArgs = typeof BoardMarkReadArgs.Type;

export const PadReadArgs = Schema.Struct({
  target: Schema.String,
  pinId: Schema.optionalKey(Schema.String),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type PadReadArgs = typeof PadReadArgs.Type;

export const PadPatchArgs = Schema.Struct({
  target: Schema.String,
  patches: Schema.Array(PadPatch).pipe(Schema.check(Schema.isMinLength(1))),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type PadPatchArgs = typeof PadPatchArgs.Type;

/** CLI projection verbs that only need the connected pad target. */
export const PadTargetArgs = Schema.Struct({
  target: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type PadTargetArgs = typeof PadTargetArgs.Type;

export const PadLookHereArgs = Schema.Struct({
  target: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  pinId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type PadLookHereArgs = typeof PadLookHereArgs.Type;

export const PadGetArgs = Schema.Struct({
  target: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  id: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMinLength(1)))),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type PadGetArgs = typeof PadGetArgs.Type;

/** Agent fires a connected scheduler via the relay.trigger port. */
export const RelayTriggerArgs = Schema.Struct({
  target: Schema.String,
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type RelayTriggerArgs = typeof RelayTriggerArgs.Type;

// ---------------------------------------------------------------------------
// Helpers

export const stripTokenFromLog = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  if ("token" in copy) copy.token = "[redacted]";
  return copy;
};

export const encodeWorkFrame = (value: unknown): string => `${JSON.stringify(value)}\n`;

export const decodeWorkJsonLine = (line: string): Result.Result<unknown, string> => {
  try {
    return Result.succeed(JSON.parse(line) as unknown);
  } catch {
    return Result.fail("malformed JSON frame");
  }
};
