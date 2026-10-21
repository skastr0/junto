import { Result, Schema } from "effect";
import { MachineLogQuery } from "./machine-log";
import {
  CheckSide,
  CompletionEvidence,
  ContentPart,
  FinishCriteria,
  RawPart,
  Rule,
  TaskAdmission,
  TaskRule,
  TaskState,
  WorkMetadata,
} from "./work-model";
import { ContentRef } from "./content";
import { MailEvidenceRef } from "./crew";
import { NODE_KINDS } from "./model/kinds";
import { NodeId } from "./physics/schema";
import { ItemId, OpId, TaskNumber } from "./work-ids";
import {
  AgentSignal,
  AgentSignalAttachmentInput,
  AgentSignalKind,
  AgentSignalSuggestions,
} from "./agent-signals";
import { UrgencyLevel, UrgencyRank } from "./wire/urgency";
export {
  SeatWaitArgs, SeatReadArgs,
  SeatWaitResult, SeatReadResult,
} from "./seat-control";

// Work control-plane wire contract: NDJSON frames over a local Unix domain
// socket at ~/.junto/work/control.sock. Pure module — no Node imports — so
// the Electron-hosted daemon, the standalone CLI, and tests share one source
// of truth. Transport is owner-local only. A seat call carries its generation
// credential in the frame token field. A liveness probe presents
// `WORK_LIVENESS_PROBE_TOKEN`, which is not a credential. Domain mutations
// route through WorkService — this file only knows shapes, paths-as-strings,
// and admission bounds.

// ---------------------------------------------------------------------------
// Paths (functions of home so the module stays platform-pure)

/** Default dir: `~/.junto/work`. Tests override with `JUNTO_WORK_HOME`. */
export const workControlDir = (home: string): string => `${home}/.junto/work`;

export const workControlSocketPath = (workHome: string): string =>
  `${workHome}/control.sock`;

export const WORK_HOME_ENV = "JUNTO_WORK_HOME";
/**
 * Presented by Command Center and deploy activation when they only need to
 * know the work daemon answered. Not a seat credential, and not a secret.
 */
export const WORK_LIVENESS_PROBE_TOKEN = "probe";
/**
 * Seat generation credential for the work control socket. Main mints one value
 * per occupant generation, injects it into the seat process environment at
 * spawn, and the CLI presents it in the existing frame token field. The value
 * never appears on argv, in logs, or in committed source.
 */
export const WORK_TOKEN_ENV = "JUNTO_WORK_TOKEN";

/** Seat generation credential prefix: `junto-seat-` plus 43 base64url chars. */
export const SEAT_CREDENTIAL_PREFIX = "junto-seat-";
const SEAT_CREDENTIAL_BODY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/** Shape check only; validity is always a registry lookup on main. */
export const isSeatCredentialShape = (value: string): boolean => {
  if (!value.startsWith(SEAT_CREDENTIAL_PREFIX)) return false;
  return SEAT_CREDENTIAL_BODY_PATTERN.test(value.slice(SEAT_CREDENTIAL_PREFIX.length));
};
export const WORK_PROTOCOL_VERSION = "junto/work-control/v1";

export const WORK_DEFAULT_BATCH_CONCURRENCY = 5;
export const WORK_DEFAULT_TIMEOUT_MS = 30_000;
export const WORK_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const WORK_MAX_ERROR_BYTES = 4_096;

// ---------------------------------------------------------------------------
// Ops

export const WorkOpName = Schema.Literals(["ping", "doctor",
"capabilities",
"onboard",
/** Universal seat-local: since this seat's last session, uncapped with `all`. */
"since",
/** Universal seat-local: write this session's handoff notes (no edge, no port). */
"offboard",
"preamble",
"overseer",
"overseer.live",
/** Tasks in reach (plan 04): no edge, no port; region reach admits. */
"task.list",
"task.show",
"task.create",
"task.edit",
"task.assign",
"task.unassign",
"task.start",
"task.pause",
"task.resume",
"task.finish",
"task.cancel",
"task.archive",
"task.depend",
"task.undepend",
"task.reviewer-add",
"task.reviewer-remove",
"task.stamp-policy",
"task.stamp",
"task.comment",
"task.rules",
"task.check",
"task.wait",
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
/** Universal seat-local: the seat's own agent signals (no edge, no port). */
"signal.raise",
"signal.clear",
"signal.list",
/** Universal seat-local: what became of this seat's resource writes, by opId (no edge, no port). */
"op.show",
"op.list",
/** Universal seat-local: what this seat's regions resolve to (names and status, never values). */
"env.report",
/** Universal seat-local: this machine's log, scoped to the caller (its rows, seats it may read, rows naming no seat). */
"logs.read",
/** Universal seat-local: the operator's references in this seat's scope (the app and its regions). */
"references.list",
"references.read",
/** Universal seat-local: the seat puts a file of its own into the content store, in pieces. */
"content.stage",
/** Automations in reach (plan 07): no edge, no port; region reach admits. Seats only read. */
"automation.list",
"automation.show",
"automation.history",
/** Artifacts in reach (plan 05): no edge, no port; region reach admits. */
"artifact.list",
"artifact.show",
"artifact.history",
"artifact.create",
"artifact.edit",
"artifact.comment",
"artifact.archive",
"artifact.restore",]);
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
"Timeout",
"ReviewerIsAuthor",
/** Written against an old version; `expected` is the head, and a retry on it may pass. */
"Stale",]);
export type WorkErrorType = typeof WorkErrorType.Type;

/**
 * A node, or an item inside one, that a refused target could have meant or
 * that the caller reaches. `kind` is the node's kind; `itemId` and `number`
 * name an item in it (a task's id and its `#42`).
 */
export const TargetCandidate = Schema.Struct({
  kind: Schema.Literals(NODE_KINDS),
  nodeId: NodeId,
  itemId: Schema.optionalKey(ItemId),
  name: Schema.String,
  number: Schema.optionalKey(TaskNumber),
});
export type TargetCandidate = typeof TargetCandidate.Type;

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
  /** Durable prompt identity, returned even when immediate admission refuses. */
  messageId: Schema.optionalKey(Schema.String),
  generation: Schema.optionalKey(Schema.String),
  /** A sub-code in snake_case, such as `queue_full` or `depends_on_refused`. */
  reason: Schema.optionalKey(Schema.String),
  /** What a refused target could have meant, or what the caller reaches. */
  candidates: Schema.optionalKey(Schema.Array(TargetCandidate)),
  /** The write this refusal or timeout is about; a retry resends it. */
  opId: Schema.optionalKey(OpId),
});
export type WorkErrorDetails = typeof WorkErrorDetails.Type;

export const WorkErrorBody = Schema.Struct({
  type: WorkErrorType,
  message: Schema.String,
  details: Schema.optionalKey(WorkErrorDetails),
});
export type WorkErrorBody = typeof WorkErrorBody.Type;

/** A write against an old version: retryable, with the head version it should build on. */
export const staleError = (input: {
  readonly message: string;
  readonly expected: string | number;
  readonly reason?: string;
  readonly opId?: OpId;
}): WorkErrorBody => ({
  type: "Stale",
  message: input.message,
  details: {
    expected: input.expected,
    retryable: true,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.opId === undefined ? {} : { opId: input.opId }),
  },
});

/**
 * The writing machine's queue for the editing machine is full: the one write
 * refusal that comes from the editing machine being away. Retryable.
 */
export const queueFullError = (opId: OpId): WorkErrorBody => ({
  type: "RuntimeDown",
  message: "the queue of writes waiting for the editing machine is full",
  details: {
    reason: "queue_full",
    retryable: true,
    opId,
    next_step: "wait for the editing machine to come back, then send again with the same --op-id",
  },
});

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

/** Outer bound on a wait before starting. */
export const WAIT_FOR_MAX_MS = 90 * 24 * 60 * 60 * 1000;

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
  /** Only mail in this thread: the root's id, which every reply carries. */
  threadId: Schema.optionalKey(Schema.String),
  /** Only mail from this seat: its name, node id or seat id. */
  from: Schema.optionalKey(Schema.String),
  /** Only mail not read yet. */
  unread: Schema.optionalKey(Schema.Boolean),
  /** Only mail born at or after this ISO 8601 time, or after this message id. */
  since: Schema.optionalKey(Schema.String),
  /** Only mail whose text or subject contains this, ignoring case. */
  text: Schema.optionalKey(Schema.String),
  /** List without marking anything read. */
  peek: Schema.optionalKey(Schema.Boolean),
});
export type MsgListArgs = typeof MsgListArgs.Type;

/** What `msg list` takes, said in a refusal instead of the input that failed. */
export const MSG_LIST_ARGS_SHAPE =
  "msg list takes target, taskId, threadId, from, since and text as strings, and unread and peek as true or false";

export const MsgSendArgs = Schema.Struct({
  target: Schema.String,
  text: Schema.String,
  taskId: Schema.optionalKey(Schema.String),
  subject: Schema.optionalKey(Schema.String),
  refs: Schema.optionalKey(Schema.Array(MailEvidenceRef)),
  /** Post into an existing thread; it must name mail this seat can read. */
  threadId: Schema.optionalKey(Schema.String),
});
export type MsgSendArgs = typeof MsgSendArgs.Type;

/** A prompt writes its full text into the recipient's input; a send writes a notice line. */
export const MsgPromptArgs = Schema.Struct({
  target: Schema.String,
  text: Schema.String,
  subject: Schema.optionalKey(Schema.String),
  refs: Schema.optionalKey(Schema.Array(MailEvidenceRef)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
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
 * read on the caller's own mailbox. The reply joins the parent's thread.
 * Target "operator" answers mail the operator sent this seat.
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
 * Agent signals: the calling seat's own claim that it needs the operator.
 * Universal and seat-local: no target, no edge, no port. The seat is the
 * process-bound caller, so a seat can only raise, clear, or read its own.
 */
/**
 * `attach` is what the signal carries beside its words (`AgentSignalAttachmentInput`):
 * files and texts the seat uploaded first (`content.stage`) and names by
 * reference, a commit by its id, a video by its address. No bytes and no
 * path ride in this request. What an agent writes to the CLI is another
 * shape (`SignalRaiseCliInput` in the CLI).
 */
export const SignalRaiseArgs = Schema.Struct({
  kind: AgentSignalKind,
  text: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  attach: Schema.optionalKey(Schema.Array(AgentSignalAttachmentInput)),
  /**
   * Replies the seat pre-bakes for the operator (`AgentSignalSuggestions`):
   * at most two short pills, shown ahead of the quick replies. Sending one
   * answers the signal exactly as a typed reply.
   */
  suggest: Schema.optionalKey(AgentSignalSuggestions),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type SignalRaiseArgs = typeof SignalRaiseArgs.Type;

/** Withdraw one open signal by id, or every open signal of the seat. */
export const SignalClearArgs = Schema.Struct({
  signalId: Schema.optionalKey(Schema.String),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type SignalClearArgs = typeof SignalClearArgs.Type;

export const SignalListArgs = Schema.Struct({
  /** Closed history from here on, uncapped: after this signal id, or at or after this ISO 8601 time. */
  since: Schema.optionalKey(Schema.String),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type SignalListArgs = typeof SignalListArgs.Type;

/** A listed signal: the signal, its level on the urgency ladder, and that level's rank. */
export const ListedAgentSignal = Schema.Struct({
  ...AgentSignal.fields,
  level: UrgencyLevel,
  rank: UrgencyRank,
  /**
   * The operator's answer files as the seat reads them: one line each, with
   * its name, type, size and the local path to open. Absent when none.
   */
  responseFiles: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type ListedAgentSignal = typeof ListedAgentSignal.Type;

/** Open first, then most urgent, then oldest, then id; `open` counts the open ones. */
export const SignalListResult = Schema.Struct({
  signals: Schema.Array(ListedAgentSignal),
  open: Schema.Number,
  /** Closed signals the capped listing left out; absent when none were. */
  closed_not_listed: Schema.optionalKey(Schema.Number),
  /** How to list the ones left out. Present with `closed_not_listed`. */
  next_step: Schema.optionalKey(Schema.String),
});
export type SignalListResult = typeof SignalListResult.Type;

/**
 * `env.report`: what the calling seat's regions resolve to. Takes nothing;
 * the caller is the process-bound seat. Answers with a
 * `SeatEnvironmentReport` (shared/region-environment): variable names, where
 * each comes from and whether it resolved. Never a value.
 */
export const EnvReportArgs = Schema.Struct({}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type EnvReportArgs = typeof EnvReportArgs.Type;

/**
 * `logs.read`: this machine's log, filtered by the query and scoped to the
 * calling seat (docs/security-doctrine.md, Logs). Answers a `MachineLogRead`.
 */
export const LogsReadArgs = MachineLogQuery;
export type LogsReadArgs = typeof LogsReadArgs.Type;

/**
 * references.list / references.read: seat-local, no edge, no port. The seat is
 * the process-bound caller; its scope is the app plus every region containing
 * it. `list` answers names and descriptions (`@shared/references`
 * `ReferenceListEntry`), `read` the innermost match with its body.
 */
export const ReferencesListArgs = Schema.Struct({}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type ReferencesListArgs = typeof ReferencesListArgs.Type;

export const ReferencesReadArgs = Schema.Struct({ name: Schema.String }).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type ReferencesReadArgs = typeof ReferencesReadArgs.Type;

/** `junto onboard` takes no input: a seat onboards itself. */
export const OnboardArgs = Schema.Struct({}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type OnboardArgs = typeof OnboardArgs.Type;

/** `junto since`: what this seat owes, waits on and missed, capped as onboard shows it unless `all`. */
export const SinceArgs = Schema.Struct({
  all: Schema.optionalKey(Schema.Boolean),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type SinceArgs = typeof SinceArgs.Type;

/**
 * `junto offboard`: the calling seat's notes on its current session, as
 * markdown. Seat-local: the seat is the process-bound caller and writes only
 * its own session's notes. The first line is the session's one-line gist.
 * `continuation` (`--continue`) is a note for the next session: Junto starts
 * that session right away instead of letting the seat rest.
 */
export const OffboardArgs = Schema.Struct({
  notes: Schema.String,
  continuation: Schema.optionalKey(Schema.String),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type OffboardArgs = typeof OffboardArgs.Type;

export const EmptyArgs = Schema.Struct({});
export type EmptyArgs = typeof EmptyArgs.Type;

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
