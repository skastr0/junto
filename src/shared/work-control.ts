import { Result, Schema } from "effect";
import { TaskState, WorkMetadata } from "./canvas";
import {
  CheckSide,
  CompletionEvidence,
  ContentPart,
  FinishCriteria,
  RawPart,
  Rule,
  TaskAdmission,
  TaskRule,
} from "./work-model";
import { ContentRef } from "./content";
import { PadPatch } from "./pad";
import { MailEvidenceRef } from "./crew";
export {
  SeatWaitArgs, SeatReadArgs, TaskWaitArgs,
  SeatWaitResult, SeatReadResult, TaskWaitResult,
} from "./seat-control";

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
"overseer",
"overseer.live",
"tasks.list",
"tasks.create",
"tasks.claim",
"tasks.update",
"tasks.show",
"tasks.rules",
"tasks.check",
"tasks.wait",
"rulings",
"content.path",
"content.stat",
"content.materialize",
"msg.list",
"msg.send",
"msg.prompt",
"msg.sent",
"msg.read",
"msg.reply",
"msg.react",
"seat.wait",
"seat.read",
"verdict.post",
"request.escalate",
"artifact.publish",
"board.list",
"board.create_topic",
"board.post",
"board.mark_read",
"board.tags",
"pad.read",
"pad.patch",
/** Agent → sheet: read the operator's grid (port sheet.read). */
"sheet.read",
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
"Blocked",
"SeatBusy",
"Timeout",
"ReviewerIsAuthor",]);
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
  /** Durable prompt identity, returned even when immediate admission refuses. */
  messageId: Schema.optionalKey(Schema.String),
  generation: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
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

/** Outer bound on a wait before starting. */
export const WAIT_FOR_MAX_MS = 90 * 24 * 60 * 60 * 1000;

const waitForField = Schema.optionalKey(
  Schema.Number.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
    Schema.check(Schema.isLessThanOrEqualTo(WAIT_FOR_MAX_MS)),
  ),
);

const tasksCreateFields = {
  target: Schema.String,
  brief: Schema.String,
  reason: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(WorkMetadata),
  /** First-class media on the brief. RawPart decodes for legacy clients but is rejected at durable write. */
  media: Schema.optionalKey(Schema.Array(Schema.Union([RawPart, ContentPart]))),
  /** Same-sink hard prerequisites (task ids). */
  dependsOn: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Operator done-definition. */
  finishCriteria: Schema.optionalKey(FinishCriteria),
  /** Board-addressed rules; set at creation. */
  rules: Schema.optionalKey(Schema.Array(TaskRule)),
  /**
   * Requested start policy. An agent omission becomes approval; an operator
   * omission inherits the board setting. A task may only tighten that setting.
   */
  admission: Schema.optionalKey(TaskAdmission),
} as const;

/**
 * Author a task on a connected Tasks node. Agents that omit admission create
 * work requiring approval. Optional waitFor delays the first claim.
 */
export const TasksCreateArgs = Schema.Struct({
  ...tasksCreateFields,
  waitFor: waitForField,
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

/**
 * CLI-side create input. `waitFor` accepts a spoken duration or milliseconds;
 * the CLI parses it to milliseconds before sending the same field.
 */
export const TasksCreateCliArgs = Schema.Struct({
  ...tasksCreateFields,
  waitFor: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
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
export type TasksCreateCliArgs = typeof TasksCreateCliArgs.Type;

export const TasksClaimArgs = Schema.Struct({
  target: Schema.String,
  task: Schema.String,
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type TasksClaimArgs = typeof TasksClaimArgs.Type;

/** Defect filed with a send-back: what the earlier board must fix. */
export const TaskDefectArgs = Schema.Struct({
  summary: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  refs: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * Visited board to send the task back to. Omitted means the previous board.
   */
  target: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMinLength(1)))),
});
export type TaskDefectArgs = typeof TaskDefectArgs.Type;

const tasksUpdateFields = {
  target: Schema.String,
  task: Schema.String,
  state: TaskState,
  note: Schema.optionalKey(Schema.String),
  completionEvidence: Schema.optionalKey(CompletionEvidence),
  /** Next board id, required when the path forks. */
  next: Schema.optionalKey(Schema.String),
  /** Send the task back to an earlier board with a defect on record. */
  defect: Schema.optionalKey(TaskDefectArgs),
  /** Required prose when the board's outgoing contract asks for it. */
  handoffNote: Schema.optionalKey(Schema.String),
} as const;

export const TasksUpdateArgs = Schema.Struct({
  ...tasksUpdateFields,
  /** Delay stamped when the task enters `next`, in milliseconds. */
  waitFor: waitForField,
}).pipe(
  Schema.check(Schema.makeFilter(({ state, completionEvidence }) =>
    completionEvidence === undefined ||
    state === "working" ||
    state === "completed" ||
    "completionEvidence is only allowed when state is working or completed",)),
  Schema.check(Schema.makeFilter(({ state, next }) =>
    next === undefined ||
    state === "completed" ||
    "next is only allowed when state is completed",)),
  Schema.check(Schema.makeFilter(({ state, waitFor }) =>
    waitFor === undefined ||
    state === "completed" ||
    "waitFor is only allowed when state is completed",)),
  Schema.check(Schema.makeFilter(({ state, handoffNote }) =>
    handoffNote === undefined ||
    state === "completed" ||
    "handoffNote is only allowed when state is completed",)),
  Schema.check(Schema.makeFilter(({ state, defect }) =>
    defect === undefined ||
    state === "rejected" ||
    "defect is only allowed when state is rejected",)),
).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type TasksUpdateArgs = typeof TasksUpdateArgs.Type;

/**
 * CLI-side update input. Identical to the wire shape except `waitFor`, which
 * accepts a duration the operator would speak ("7d", "12h", "90m") or plain
 * milliseconds; the CLI parses it before the call.
 */
export const TasksUpdateCliArgs = Schema.Struct({
  ...tasksUpdateFields,
  waitFor: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
}).pipe(
  Schema.check(Schema.makeFilter(({ state, completionEvidence }) =>
    completionEvidence === undefined ||
    state === "working" ||
    state === "completed" ||
    "completionEvidence is only allowed when state is working or completed",)),
  Schema.check(Schema.makeFilter(({ state, next }) =>
    next === undefined ||
    state === "completed" ||
    "next is only allowed when state is completed",)),
  Schema.check(Schema.makeFilter(({ state, waitFor }) =>
    waitFor === undefined ||
    state === "completed" ||
    "waitFor is only allowed when state is completed",)),
  Schema.check(Schema.makeFilter(({ state, handoffNote }) =>
    handoffNote === undefined ||
    state === "completed" ||
    "handoffNote is only allowed when state is completed",)),
  Schema.check(Schema.makeFilter(({ state, defect }) =>
    defect === undefined ||
    state === "rejected" ||
    "defect is only allowed when state is rejected",)),
).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type TasksUpdateCliArgs = typeof TasksUpdateCliArgs.Type;

export const TasksShowArgs = Schema.Struct({
  target: Schema.String,
  task: Schema.String,
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type TasksShowArgs = typeof TasksShowArgs.Type;

export const TasksRulesArgs = Schema.Struct({
  target: Schema.String,
  /** Omitted: board rules. Named: rules and readiness for that task. */
  task: Schema.optionalKey(Schema.String),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type TasksRulesArgs = typeof TasksRulesArgs.Type;

const RuleProvenanceView = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("region"),
    regionId: Schema.String,
    label: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("board"),
    boardId: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("task"),
    board: Schema.String,
  }),
]);

const RuleInForceView = Schema.Struct({
  rule: Rule,
  provenance: RuleProvenanceView,
});

/** Strict response contract consumed by `tasks check`. */
export const TasksRulesView = Schema.Struct({
  rules: Schema.Array(RuleInForceView),
  readiness: Schema.optionalKey(Schema.Struct({
    unanswered: Schema.Array(Schema.Struct({
      ruleId: Schema.String,
      text: Schema.String,
      provenance: RuleProvenanceView,
    })),
    checks: Schema.Array(Schema.Struct({
      destination: Schema.String,
      checks: Schema.Array(Schema.Struct({
        checkId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
        side: CheckSide,
        label: Schema.String,
        command: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
        status: Schema.Literals(["green", "red", "missing", "stale"]),
      })),
    })),
  })),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type TasksRulesView = typeof TasksRulesView.Type;

/**
 * Check submission. The agent CLI executes each command in its own environment
 * and submits only the observed results. Junto never runs a check.
 */
export const TasksCheckArgs = Schema.Struct({
  target: Schema.String,
  task: Schema.String,
  /** Next board whose incoming checks apply, required when the path forks. */
  next: Schema.optionalKey(Schema.String),
  results: Schema.Array(Schema.Struct({
    checkId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    side: Schema.Literals(["outgoing", "incoming"]),
    exitCode: Schema.Number,
    outputTail: Schema.String,
  })),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type TasksCheckArgs = typeof TasksCheckArgs.Type;

/**
 * CLI-facing `tasks check` input. The CLI resolves and runs the applicable
 * commands; the caller supplies target/task/next, never `results`.
 */
export const TasksCheckCliArgs = Schema.Struct({
  target: Schema.String,
  task: Schema.String,
  /** Next board whose incoming checks apply, required when the path forks. */
  next: Schema.optionalKey(Schema.String),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type TasksCheckCliArgs = typeof TasksCheckCliArgs.Type;

export const RulingsArgs = Schema.Struct({
  /** Omitted: the agent's own region stack. */
  target: Schema.optionalKey(Schema.String),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type RulingsArgs = typeof RulingsArgs.Type;

/** Process-bound content access always names the connected Tasks node. */
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
  subject: Schema.optionalKey(Schema.String),
  refs: Schema.optionalKey(Schema.Array(MailEvidenceRef)),
});
export type MsgSendArgs = typeof MsgSendArgs.Type;

/** Immediate creation and retry are disjoint, so retries cannot replace a body. */
export const MsgPromptArgs = Schema.Union([
  Schema.Struct({
    target: Schema.String,
    text: Schema.String,
    subject: Schema.optionalKey(Schema.String),
    refs: Schema.optionalKey(Schema.Array(MailEvidenceRef)),
    fallback: Schema.optionalKey(Schema.Literal("notice")),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    target: Schema.String,
    messageId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    fallback: Schema.optionalKey(Schema.Literal("notice")),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
]);
export type MsgPromptArgs = typeof MsgPromptArgs.Type;

/** Read the admitted sender's receipts; never marks the recipient mailbox read. */
export const MsgSentArgs = Schema.Struct({
  target: Schema.optionalKey(Schema.String),
});
export type MsgSentArgs = typeof MsgSentArgs.Type;

/** Review the exact subject previously read; identity is supplied by process bind. */
export const VerdictPostArgs = Schema.Struct({
  target: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  subject: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("task"),
      taskId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
      epoch: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
      subjectHash: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
    }).annotate({ parseOptions: { onExcessProperty: "error" } }),
    Schema.Struct({
      kind: Schema.Literal("commit"),
      sha: Schema.String.pipe(Schema.check(Schema.isPattern(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/))),
    }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  ]),
  kind: Schema.Literals(["green", "blocking"]),
  findings: Schema.optionalKey(Schema.Array(Schema.String)),
  refs: Schema.optionalKey(Schema.Array(MailEvidenceRef)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type VerdictPostArgs = typeof VerdictPostArgs.Type;

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
  refs: Schema.optionalKey(Schema.Array(MailEvidenceRef)),
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
  upToPosition: Schema.optionalKey(
    Schema.Number.pipe(
      Schema.check(Schema.isInt()),
      Schema.check(Schema.isGreaterThanOrEqualTo(0)),
    ),
  ),
});
export type BoardMarkReadArgs = typeof BoardMarkReadArgs.Type;

export const PadReadArgs = Schema.Struct({
  target: Schema.String,
  pinId: Schema.optionalKey(Schema.String),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type PadReadArgs = typeof PadReadArgs.Type;

export const SheetReadArgs = Schema.Struct({
  target: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type SheetReadArgs = typeof SheetReadArgs.Type;

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
