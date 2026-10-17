/**
 * Seat signals: facts about a seat, from any of its four authors.
 *
 * - harness: what the agent CLI itself reports, through whatever channel it
 *   has (screen, OSC 7501, hook, report socket, transcript, API).
 * - seat: the agent's own claim (`junto blocked`, `junto escalate`,
 *   `junto feedback`), see `wire/agent-signals.ts`.
 * - awareness: a Jev answer about a bounded terminal window. Advisory.
 * - system: what Junto observed itself (exit, stall, delivery, viewing).
 *
 * Every fact travels in one `SignalEnvelope` that names its source and how
 * much to trust it, so one reducer and one urgency ladder see everything.
 * A screen-read permission prompt and a hook-reported one are the same
 * signal with different provenance. Design: `docs/harness-domain.md`.
 */
import { Schema } from "effect";
import { BindingId } from "../terminal-session-domain";
import { AgentSignalKind } from "../wire/agent-signals";
import { ThreadHealthValue } from "../wire/thread-health";

const Text = Schema.String;
const EpochMs = Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Percent = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }));

// ── Provenance ────────────────────────────────────────────────────────────

/** Channels a harness reports through. */
export const HARNESS_CHANNELS = [
  "screen",
  "osc7501",
  "transcript",
  "hook",
  "report",
  "api",
  "process",
] as const;
export const HarnessChannel = Schema.Literals(HARNESS_CHANNELS);
export type HarnessChannel = typeof HarnessChannel.Type;

export const SignalSource = Schema.Literals([
  ...HARNESS_CHANNELS,
  "seat",
  "awareness",
  "system",
]);
export type SignalSource = typeof SignalSource.Type;

/**
 * How the fact was read.
 * - native: a structured field the harness wrote for this purpose.
 * - parsed: a structured record whose meaning needed a pattern (text in an
 *   error field).
 * - screen: rendered text or a terminal title.
 */
export const Fidelity = Schema.Literals(["native", "parsed", "screen"]);
export type Fidelity = typeof Fidelity.Type;

// ── Harness signals ───────────────────────────────────────────────────────

export const SessionIdentified = Schema.Struct({
  _tag: Schema.Literal("SessionIdentified"),
  sessionId: Text,
  transcriptPath: Schema.optionalKey(Text),
});

/**
 * The screen or a status protocol saw a state, not an event. `unknown` is a
 * read that cannot tell (a connecting screen, a harness with no pack, a
 * released reporter with no screen to re-read).
 */
export const ActivityObserved = Schema.Struct({
  _tag: Schema.Literal("ActivityObserved"),
  activity: Schema.Literals(["idle", "working", "unknown"]),
});

export const TurnStarted = Schema.Struct({
  _tag: Schema.Literal("TurnStarted"),
  turnId: Schema.optionalKey(Text),
});

export const TurnEnded = Schema.Struct({
  _tag: Schema.Literal("TurnEnded"),
  outcome: Schema.Literals(["completed", "interrupted", "failed"]),
  turnId: Schema.optionalKey(Text),
});

export const ToolStarted = Schema.Struct({
  _tag: Schema.Literal("ToolStarted"),
  tool: Schema.optionalKey(Text),
});

export const PermissionRequested = Schema.Struct({
  _tag: Schema.Literal("PermissionRequested"),
  tool: Schema.optionalKey(Text),
  detail: Schema.optionalKey(Text),
  requestId: Schema.optionalKey(Text),
});

export const PermissionResolved = Schema.Struct({
  _tag: Schema.Literal("PermissionResolved"),
  decision: Schema.optionalKey(Schema.Literals(["allowed", "denied"])),
  requestId: Schema.optionalKey(Text),
});

export const QuestionAsked = Schema.Struct({
  _tag: Schema.Literal("QuestionAsked"),
  text: Schema.optionalKey(Text),
});

export const DialogKind = Schema.Literals(["trust", "login", "update", "picker", "unknown"]);
export type DialogKind = typeof DialogKind.Type;

export const DialogShown = Schema.Struct({
  _tag: Schema.Literal("DialogShown"),
  kind: DialogKind,
});

export const UsageLimitScope = Schema.Literals([
  "rate",
  "session",
  "5h",
  "weekly",
  "monthly",
  "credits",
  "org",
  "unknown",
]);
export type UsageLimitScope = typeof UsageLimitScope.Type;

/** A hard stop: the seat waits for a reset, credits, or an operator action. */
export const UsageLimitHit = Schema.Struct({
  _tag: Schema.Literal("UsageLimitHit"),
  scope: UsageLimitScope,
  resetsAt: Schema.optionalKey(EpochMs),
  provider: Schema.optionalKey(Text),
  message: Text,
});

/** A transient failure the harness is retrying on its own. Never blocked. */
export const Retrying = Schema.Struct({
  _tag: Schema.Literal("Retrying"),
  cause: Schema.Literals(["rate", "overloaded", "network", "server", "unknown"]),
  attempt: Schema.optionalKey(Count),
  max: Schema.optionalKey(Count),
  retryInMs: Schema.optionalKey(Count),
});

export const UsageLevel = Schema.Struct({
  _tag: Schema.Literal("UsageLevel"),
  contextPct: Schema.optionalKey(Percent),
  contextTokens: Schema.optionalKey(Count),
  contextWindow: Schema.optionalKey(Count),
  quotaPct: Schema.optionalKey(Percent),
  quotaWindow: Schema.optionalKey(UsageLimitScope),
  quotaResetsAt: Schema.optionalKey(EpochMs),
  costUsd: Schema.optionalKey(Schema.Finite),
});
export type UsageLevel = typeof UsageLevel.Type;

export const CompactionTrigger = Schema.Literals(["auto", "manual", "unknown"]);
export type CompactionTrigger = typeof CompactionTrigger.Type;

export const CompactionStarted = Schema.Struct({
  _tag: Schema.Literal("CompactionStarted"),
  trigger: CompactionTrigger,
});

export const CompactionEnded = Schema.Struct({
  _tag: Schema.Literal("CompactionEnded"),
  ok: Schema.Boolean,
  tokensBefore: Schema.optionalKey(Count),
  tokensAfter: Schema.optionalKey(Count),
});

export const ErrorKind = Schema.Literals([
  "auth",
  "network",
  "provider",
  "model",
  "contextOverflow",
  "outputLimit",
  "policy",
  "tool",
  "crash",
  "unknown",
]);
export type ErrorKind = typeof ErrorKind.Type;

export const ErrorRaised = Schema.Struct({
  _tag: Schema.Literal("ErrorRaised"),
  kind: ErrorKind,
  retryable: Schema.optionalKey(Schema.Boolean),
  message: Text,
});
export type ErrorRaised = typeof ErrorRaised.Type;

/**
 * `expected` is true when Junto asked the process to stop, false when it did
 * not, and absent when the observer cannot know (an unbind carries only its
 * reason). Only `false` is an unexpected exit.
 */
export const ProcessExited = Schema.Struct({
  _tag: Schema.Literal("ProcessExited"),
  code: Schema.optionalKey(Schema.Int),
  signal: Schema.optionalKey(Text),
  expected: Schema.optionalKey(Schema.Boolean),
});

export const HarnessSignal = Schema.Union([
  SessionIdentified,
  ActivityObserved,
  TurnStarted,
  TurnEnded,
  ToolStarted,
  PermissionRequested,
  PermissionResolved,
  QuestionAsked,
  DialogShown,
  UsageLimitHit,
  Retrying,
  UsageLevel,
  CompactionStarted,
  CompactionEnded,
  ErrorRaised,
  ProcessExited,
]);
export type HarnessSignal = typeof HarnessSignal.Type;
export type HarnessSignalKind = HarnessSignal["_tag"];

export const HARNESS_SIGNAL_KINDS = HarnessSignal.members.map(
  (member) => member.fields._tag.literal,
) as readonly HarnessSignalKind[];

// ── Seat signals (the agent's own claim) ──────────────────────────────────

export const SeatReported = Schema.Struct({
  _tag: Schema.Literal("SeatReported"),
  kind: AgentSignalKind,
  signalId: Text,
  state: Schema.Literals(["open", "closed"]),
  text: Schema.optionalKey(Text),
});
export type SeatReported = typeof SeatReported.Type;

// ── Awareness signals (Jev, advisory) ─────────────────────────────────────

/** Mirrors `AiActivityValue` in `term/awareness/questions.ts`. */
export const AwarenessActivity = Schema.Literals([
  "investigating",
  "editing",
  "running_command",
  "testing",
  "reviewing",
  "reporting",
  "indeterminate",
]);

/** Mirrors `AiConcernValue` in `term/awareness/questions.ts`. */
export const AwarenessConcern = Schema.Literals([
  "approval_requested",
  "answer_requested",
  "access_problem",
  "execution_error",
  "repetition",
]);
export type AwarenessConcern = typeof AwarenessConcern.Type;

export const AwarenessAnswer = Schema.Union([
  Schema.Struct({ axis: Schema.Literal("activity"), value: AwarenessActivity }),
  Schema.Struct({ axis: Schema.Literal("concern"), value: AwarenessConcern }),
  Schema.Struct({ axis: Schema.Literal("health"), value: ThreadHealthValue }),
]);
export type AwarenessAnswer = typeof AwarenessAnswer.Type;

/**
 * One decisive answer. `present: false` is a decisive "checked and clear",
 * which withdraws an earlier answer on the same question.
 */
export const AwarenessAssessed = Schema.Struct({
  _tag: Schema.Literal("AwarenessAssessed"),
  questionId: Text,
  answer: AwarenessAnswer,
  present: Schema.Boolean,
  probability: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  evidenceHash: Text,
  packVersion: Text,
});
export type AwarenessAssessed = typeof AwarenessAssessed.Type;

// ── System signals (Junto's own observations) ─────────────────────────────

export const ChannelOpened = Schema.Struct({
  _tag: Schema.Literal("ChannelOpened"),
  channel: HarnessChannel,
});

/** A channel that closes stops owning the seat's activity. */
export const ChannelClosed = Schema.Struct({
  _tag: Schema.Literal("ChannelClosed"),
  channel: HarnessChannel,
});

export const HeartbeatStalled = Schema.Struct({
  _tag: Schema.Literal("HeartbeatStalled"),
  lastSeenAt: EpochMs,
});

export const HeartbeatResumed = Schema.Struct({
  _tag: Schema.Literal("HeartbeatResumed"),
});

/** Junto scheduled a wake for a seat that is waiting out a usage limit. */
export const WakeScheduled = Schema.Struct({
  _tag: Schema.Literal("WakeScheduled"),
  at: EpochMs,
});

export const MailDelivered = Schema.Struct({
  _tag: Schema.Literal("MailDelivered"),
  messageId: Text,
  mode: Schema.Literals(["queue", "steer", "interrupt"]),
});

export const MailDeliveryFailed = Schema.Struct({
  _tag: Schema.Literal("MailDeliveryFailed"),
  messageId: Text,
  reason: Text,
});

/** The operator looked at the seat, so a finished turn is no longer unseen. */
export const OperatorViewed = Schema.Struct({
  _tag: Schema.Literal("OperatorViewed"),
});

export const SystemSignal = Schema.Union([
  ChannelOpened,
  ChannelClosed,
  HeartbeatStalled,
  HeartbeatResumed,
  WakeScheduled,
  MailDelivered,
  MailDeliveryFailed,
  OperatorViewed,
]);
export type SystemSignal = typeof SystemSignal.Type;

// ── Envelope ──────────────────────────────────────────────────────────────

export const SeatSignal = Schema.Union([
  ...HarnessSignal.members,
  SeatReported,
  AwarenessAssessed,
  ...SystemSignal.members,
]);
export type SeatSignal = typeof SeatSignal.Type;
export type SeatSignalKind = SeatSignal["_tag"];

export const SignalEnvelope = Schema.Struct({
  seat: BindingId,
  at: EpochMs,
  source: SignalSource,
  fidelity: Fidelity,
  signal: SeatSignal,
});
export type SignalEnvelope = typeof SignalEnvelope.Type;

export const decodeSignalEnvelope = Schema.decodeUnknownResult(SignalEnvelope);
