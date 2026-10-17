/**
 * Seat status: what features read. A pure reducer folds signal envelopes into
 * one snapshot per seat generation.
 *
 * Channel precedence decides who owns the seat's activity:
 *   process > api > report > hook > transcript > osc7501 > screen
 * A richer channel owns the activity while it is open. A poorer one may still
 * raise a block it can see (a permission prompt on the screen is real), but it
 * cannot clear a block or overwrite the activity a richer open channel set.
 * When the owning channel closes, the next channel carries the seat.
 *
 * `Blocked` says why. A usage limit blocks, a retry does not: the harness
 * recovers from a retry on its own.
 */
import { Schema } from "effect";
import { BindingId } from "../terminal-session-domain";
import { AgentSignalKind } from "../wire/agent-signals";
import {
  AwarenessAnswer,
  CompactionTrigger,
  DialogKind,
  ErrorKind,
  Fidelity,
  HarnessChannel,
  SignalSource,
  UsageLimitScope,
  type HarnessSignal,
  type SignalEnvelope,
  type UsageLevel,
} from "./signal";

const EpochMs = Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

// ── Status ────────────────────────────────────────────────────────────────

export const BlockedReason = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Permission"),
    requestId: Schema.optionalKey(Schema.String),
    tool: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ _tag: Schema.Literal("Question"), text: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ _tag: Schema.Literal("Dialog"), kind: DialogKind }),
  Schema.Struct({
    _tag: Schema.Literal("UsageLimit"),
    scope: UsageLimitScope,
    resetsAt: Schema.optionalKey(EpochMs),
  }),
  Schema.Struct({ _tag: Schema.Literal("Error"), kind: ErrorKind, message: Schema.String }),
]);
export type BlockedReason = typeof BlockedReason.Type;

export const WorkingPhase = Schema.Literals(["thinking", "tool", "compacting", "retrying"]);
export type WorkingPhase = typeof WorkingPhase.Type;

export const SeatStatus = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Starting") }),
  Schema.Struct({ _tag: Schema.Literal("Idle") }),
  Schema.Struct({ _tag: Schema.Literal("Working"), phase: WorkingPhase }),
  Schema.Struct({ _tag: Schema.Literal("Blocked"), reason: BlockedReason }),
  Schema.Struct({
    _tag: Schema.Literal("Exited"),
    code: Schema.optionalKey(Schema.Int),
    signal: Schema.optionalKey(Schema.String),
    expected: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ _tag: Schema.Literal("Unknown") }),
]);
export type SeatStatus = typeof SeatStatus.Type;

// ── Snapshot ──────────────────────────────────────────────────────────────

export const SeatReport = Schema.Struct({
  kind: AgentSignalKind,
  signalId: Schema.String,
  text: Schema.optionalKey(Schema.String),
  since: EpochMs,
});
export type SeatReport = typeof SeatReport.Type;

export const AwarenessReading = Schema.Struct({
  questionId: Schema.String,
  answer: AwarenessAnswer,
  probability: Schema.Number,
  evidenceHash: Schema.String,
  since: EpochMs,
});
export type AwarenessReading = typeof AwarenessReading.Type;

export const SeatSnapshot = Schema.Struct({
  seat: BindingId,
  status: SeatStatus,
  /** When the status last changed kind (detail updates keep it). */
  since: EpochMs,
  statusSource: SignalSource,
  statusFidelity: Fidelity,
  /**
   * The activity owner's own view (never Blocked): the richest open channel's
   * last idle or working read. A block a poorer channel raises sits on top of
   * it, and clearing that block returns the seat to this view.
   */
  activity: Schema.optionalKey(
    Schema.Struct({ status: SeatStatus, source: SignalSource, fidelity: Fidelity }),
  ),
  /** Harness channels that have reported and not closed. */
  channels: Schema.Array(HarnessChannel),
  sessionId: Schema.optionalKey(Schema.String),
  transcriptPath: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(
    Schema.Struct({
      contextPct: Schema.optionalKey(Schema.Number),
      contextTokens: Schema.optionalKey(Schema.Number),
      contextWindow: Schema.optionalKey(Schema.Number),
      quotaPct: Schema.optionalKey(Schema.Number),
      quotaWindow: Schema.optionalKey(UsageLimitScope),
      quotaResetsAt: Schema.optionalKey(EpochMs),
      costUsd: Schema.optionalKey(Schema.Number),
      at: EpochMs,
    }),
  ),
  lastError: Schema.optionalKey(
    Schema.Struct({ kind: ErrorKind, message: Schema.String, at: EpochMs }),
  ),
  compaction: Schema.optionalKey(Schema.Struct({ trigger: CompactionTrigger, since: EpochMs })),
  /** A finished turn the operator has not looked at. */
  turnUnseen: Schema.optionalKey(
    Schema.Struct({ outcome: Schema.Literals(["completed", "failed"]), since: EpochMs }),
  ),
  reports: Schema.Array(SeatReport),
  awareness: Schema.Array(AwarenessReading),
  stalledSince: Schema.optionalKey(EpochMs),
  wakeAt: Schema.optionalKey(EpochMs),
  lastDelivery: Schema.optionalKey(
    Schema.Struct({
      messageId: Schema.String,
      ok: Schema.Boolean,
      reason: Schema.optionalKey(Schema.String),
      at: EpochMs,
    }),
  ),
  updatedAt: EpochMs,
});
export type SeatSnapshot = typeof SeatSnapshot.Type;

export const initialSnapshot = (seat: BindingId, at: number): SeatSnapshot => ({
  seat,
  status: { _tag: "Starting" },
  since: at,
  statusSource: "system",
  statusFidelity: "native",
  channels: [],
  reports: [],
  awareness: [],
  updatedAt: at,
});

// ── Precedence ────────────────────────────────────────────────────────────

const RANK: Readonly<Record<SignalSource, number>> = {
  process: 7,
  api: 6,
  report: 5,
  hook: 4,
  transcript: 3,
  osc7501: 2,
  screen: 1,
  seat: 0,
  awareness: 0,
  system: 0,
};

export const sourceRank = (source: SignalSource): number => RANK[source];

const isHarnessChannel = (source: SignalSource): source is HarnessChannel =>
  Schema.is(HarnessChannel)(source);

const isOpen = (snapshot: SeatSnapshot, source: SignalSource): boolean =>
  isHarnessChannel(source) && snapshot.channels.includes(source);

/** A richer open channel set the activity, so `source` may not overwrite it. */
const activityOutranks = (snapshot: SeatSnapshot, source: SignalSource): boolean => {
  const owner = snapshot.activity?.source;
  return owner !== undefined && isOpen(snapshot, owner) && RANK[source] < RANK[owner];
};

/** The current block came from a richer channel that is still open. */
const blockOutranks = (snapshot: SeatSnapshot, source: SignalSource): boolean =>
  snapshot.status._tag === "Blocked" &&
  isOpen(snapshot, snapshot.statusSource) &&
  RANK[source] < RANK[snapshot.statusSource];

type Shown = { readonly status: SeatStatus; readonly source: SignalSource; readonly fidelity: Fidelity };

/**
 * What a status fact from `envelope.source` does to the seat: the status to
 * show and the activity view to keep, or undefined when it changes nothing.
 */
const arbitrate = (
  snapshot: SeatSnapshot,
  envelope: SignalEnvelope,
  next: SeatStatus,
): { readonly shown: Shown; readonly activity: SeatSnapshot["activity"] } | undefined => {
  if (snapshot.status._tag === "Exited") return undefined;
  const fact: Shown = { status: next, source: envelope.source, fidelity: envelope.fidelity };
  if (next._tag === "Exited") return { shown: fact, activity: snapshot.activity };
  if (next._tag === "Blocked") {
    // Any channel may raise a block it sees; only an equal or richer one replaces a block.
    return blockOutranks(snapshot, envelope.source) ? undefined : { shown: fact, activity: snapshot.activity };
  }
  if (activityOutranks(snapshot, envelope.source)) {
    // A poorer channel clearing its own block hands the seat back to the owner's view.
    const ownBlock = snapshot.status._tag === "Blocked" && snapshot.statusSource === envelope.source;
    return ownBlock && snapshot.activity ? { shown: snapshot.activity, activity: snapshot.activity } : undefined;
  }
  // This channel now owns the activity; a richer channel's block still stands over it.
  return { shown: blockOutranks(snapshot, envelope.source) ? current(snapshot) : fact, activity: fact };
};

const current = (snapshot: SeatSnapshot): Shown => ({
  status: snapshot.status,
  source: snapshot.statusSource,
  fidelity: snapshot.statusFidelity,
});

const statusKey = (status: SeatStatus): string => {
  switch (status._tag) {
    case "Working":
      return `Working:${status.phase}`;
    case "Blocked":
      return `Blocked:${status.reason._tag}`;
    default:
      return status._tag;
  }
};

const withStatus = (
  snapshot: SeatSnapshot,
  envelope: SignalEnvelope,
  next: SeatStatus,
): SeatSnapshot => {
  const decided = arbitrate(snapshot, envelope, next);
  if (!decided) return snapshot;
  const { shown, activity } = decided;
  const leavingLimit =
    snapshot.status._tag === "Blocked" &&
    snapshot.status.reason._tag === "UsageLimit" &&
    !(shown.status._tag === "Blocked" && shown.status.reason._tag === "UsageLimit");
  const { wakeAt: _wakeAt, activity: _activity, ...rest } = snapshot;
  const base = leavingLimit ? rest : dropKey(snapshot, "activity");
  return {
    ...base,
    ...(activity === undefined ? {} : { activity }),
    status: shown.status,
    since: statusKey(shown.status) === statusKey(snapshot.status) ? snapshot.since : envelope.at,
    statusSource: shown.source,
    statusFidelity: shown.fidelity,
  };
};

const blockedBy = (snapshot: SeatSnapshot, tag: BlockedReason["_tag"]): boolean =>
  snapshot.status._tag === "Blocked" && snapshot.status.reason._tag === tag;

/** A failed turn after a hard stop keeps the stop: the limit or error is why. */
const holdsThroughFailure = (snapshot: SeatSnapshot): boolean =>
  blockedBy(snapshot, "UsageLimit") || blockedBy(snapshot, "Error");

const dropKey = <T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> => {
  const { [key]: _dropped, ...rest } = value;
  return rest;
};

// ── Reducer ───────────────────────────────────────────────────────────────

const reduceHarness = (
  snapshot: SeatSnapshot,
  envelope: SignalEnvelope,
  signal: HarnessSignal,
): SeatSnapshot => {
  const at = envelope.at;
  switch (signal._tag) {
    case "SessionIdentified":
      return {
        ...snapshot,
        sessionId: signal.sessionId,
        ...(signal.transcriptPath === undefined ? {} : { transcriptPath: signal.transcriptPath }),
      };
    case "ActivityObserved":
      if (signal.activity === "idle") return withStatus(snapshot, envelope, { _tag: "Idle" });
      if (signal.activity === "unknown") return withStatus(snapshot, envelope, { _tag: "Unknown" });
      return withStatus(snapshot, envelope, {
        _tag: "Working",
        phase: snapshot.status._tag === "Working" ? snapshot.status.phase : "thinking",
      });
    case "TurnStarted": {
      const next = withStatus(snapshot, envelope, { _tag: "Working", phase: "thinking" });
      return next === snapshot ? snapshot : dropKey(next, "turnUnseen");
    }
    case "TurnEnded": {
      if (signal.outcome === "failed" && holdsThroughFailure(snapshot)) {
        return { ...snapshot, turnUnseen: { outcome: "failed", since: at } };
      }
      const next = withStatus(snapshot, envelope, { _tag: "Idle" });
      if (next === snapshot) return snapshot;
      if (signal.outcome === "interrupted") return dropKey(next, "turnUnseen");
      return { ...next, turnUnseen: { outcome: signal.outcome, since: at } };
    }
    case "ToolStarted":
      return withStatus(snapshot, envelope, { _tag: "Working", phase: "tool" });
    case "PermissionRequested":
      return withStatus(snapshot, envelope, {
        _tag: "Blocked",
        reason: {
          _tag: "Permission",
          ...(signal.requestId === undefined ? {} : { requestId: signal.requestId }),
          ...(signal.tool === undefined ? {} : { tool: signal.tool }),
        },
      });
    case "PermissionResolved":
      if (!blockedBy(snapshot, "Permission")) return snapshot;
      return withStatus(snapshot, envelope, {
        _tag: "Working",
        phase: signal.decision === "denied" ? "thinking" : "tool",
      });
    case "QuestionAsked":
      return withStatus(snapshot, envelope, {
        _tag: "Blocked",
        reason: { _tag: "Question", ...(signal.text === undefined ? {} : { text: signal.text }) },
      });
    case "DialogShown":
      return withStatus(snapshot, envelope, {
        _tag: "Blocked",
        reason: { _tag: "Dialog", kind: signal.kind },
      });
    case "UsageLimitHit":
      return withStatus(snapshot, envelope, {
        _tag: "Blocked",
        reason: {
          _tag: "UsageLimit",
          scope: signal.scope,
          ...(signal.resetsAt === undefined ? {} : { resetsAt: signal.resetsAt }),
        },
      });
    case "Retrying":
      return withStatus(snapshot, envelope, { _tag: "Working", phase: "retrying" });
    case "UsageLevel":
      return { ...snapshot, usage: { ...snapshot.usage, ...usageFields(signal), at } };
    case "CompactionStarted": {
      const next = withStatus(snapshot, envelope, { _tag: "Working", phase: "compacting" });
      return { ...next, compaction: { trigger: signal.trigger, since: at } };
    }
    case "CompactionEnded": {
      const trigger = snapshot.compaction?.trigger;
      const cleared = dropKey(snapshot, "compaction");
      if (!(snapshot.status._tag === "Working" && snapshot.status.phase === "compacting")) {
        return cleared;
      }
      return withStatus(
        cleared,
        envelope,
        trigger === "manual" ? { _tag: "Idle" } : { _tag: "Working", phase: "thinking" },
      );
    }
    case "ErrorRaised": {
      const recorded = { ...snapshot, lastError: { kind: signal.kind, message: signal.message, at } };
      if (signal.kind !== "auth" && signal.kind !== "crash") return recorded;
      return withStatus(recorded, envelope, {
        _tag: "Blocked",
        reason: { _tag: "Error", kind: signal.kind, message: signal.message },
      });
    }
    case "ProcessExited":
      return withStatus(snapshot, envelope, {
        _tag: "Exited",
        ...(signal.expected === undefined ? {} : { expected: signal.expected }),
        ...(signal.code === undefined ? {} : { code: signal.code }),
        ...(signal.signal === undefined ? {} : { signal: signal.signal }),
      });
  }
};

const usageFields = (signal: UsageLevel): Omit<UsageLevel, "_tag"> => {
  const { _tag, ...fields } = signal;
  return fields;
};

const openChannel = (snapshot: SeatSnapshot, source: SignalSource): SeatSnapshot =>
  isHarnessChannel(source) && !snapshot.channels.includes(source)
    ? { ...snapshot, channels: [...snapshot.channels, source] }
    : snapshot;

export const reduceSeat = (snapshot: SeatSnapshot, envelope: SignalEnvelope): SeatSnapshot => {
  if (envelope.seat !== snapshot.seat) return snapshot;
  const signal = envelope.signal;
  const at = envelope.at;
  const base = { ...openChannel(snapshot, envelope.source), updatedAt: Math.max(snapshot.updatedAt, at) };
  switch (signal._tag) {
    case "SeatReported": {
      const others = base.reports.filter((report) => report.signalId !== signal.signalId);
      if (signal.state === "closed") return { ...base, reports: others };
      return {
        ...base,
        reports: [
          ...others,
          {
            kind: signal.kind,
            signalId: signal.signalId,
            since: at,
            ...(signal.text === undefined ? {} : { text: signal.text }),
          },
        ],
      };
    }
    case "AwarenessAssessed": {
      // The newest evidence owns the set: readings on an older window retire.
      const others = base.awareness.filter(
        (reading) => reading.questionId !== signal.questionId && reading.evidenceHash === signal.evidenceHash,
      );
      if (!signal.present) return { ...base, awareness: others };
      return {
        ...base,
        awareness: [
          ...others,
          {
            questionId: signal.questionId,
            answer: signal.answer,
            probability: signal.probability,
            evidenceHash: signal.evidenceHash,
            since: at,
          },
        ],
      };
    }
    case "ChannelOpened":
      return openChannel(base, signal.channel);
    case "ChannelClosed":
      return { ...base, channels: base.channels.filter((channel) => channel !== signal.channel) };
    case "HeartbeatStalled":
      return { ...base, stalledSince: signal.lastSeenAt };
    case "HeartbeatResumed":
      return dropKey(base, "stalledSince");
    case "WakeScheduled":
      return blockedBy(base, "UsageLimit") ? { ...base, wakeAt: signal.at } : base;
    case "MailDelivered":
      return { ...base, lastDelivery: { messageId: signal.messageId, ok: true, at } };
    case "MailDeliveryFailed":
      return {
        ...base,
        lastDelivery: { messageId: signal.messageId, ok: false, reason: signal.reason, at },
      };
    case "OperatorViewed":
      return dropKey(base, "turnUnseen");
    case "AwarenessRetired":
      return { ...base, awareness: [] };
    default:
      return reduceHarness(base, envelope, signal);
  }
};

export const reduceSeatSignals = (
  snapshot: SeatSnapshot,
  envelopes: Iterable<SignalEnvelope>,
): SeatSnapshot => {
  let current = snapshot;
  for (const envelope of envelopes) current = reduceSeat(current, envelope);
  return current;
};
