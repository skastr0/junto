/**
 * A seat's status as it crosses the seats channel, from the machine that
 * runs the seat to the machine that edits its canvas.
 *
 * The wire is a closed schema with a bound on every string, built field by
 * field from the approved list, never by spreading the local snapshot, so a
 * field added to the snapshot later stays home until it is named here.
 *
 * Crosses: the status (Permission with its tool name and request id,
 * Question bare, Dialog kind, UsageLimit scope, reset and auto-resume, Error
 * kind, Exited code, signal name and expectation), its time, source and
 * fidelity, how long ago the seat last left rest (a duration, read against
 * the receiver's clock), the activity owner's view, open channels, usage
 * numbers, the last error's kind and time, compaction, the unseen turn,
 * declared signals by kind and id, awareness readings, stall and wake times,
 * the last delivery's id and outcome, and the top need.
 *
 * Stays home: Question text, every error message, declared signal text,
 * a delivery failure's reason, sessionId and transcriptPath. The encoder
 * omits a stripped field; it never blanks one.
 */
import { Schema } from "effect";
import type { AgentSeatStatus } from "@shared/agent-seat-state";
import {
  AwarenessAnswer,
  CompactionTrigger,
  DialogKind,
  ErrorKind,
  Fidelity,
  HarnessChannel,
  NeedActor,
  NeedCause,
  SignalSource,
  UsageLimitScope,
  WorkingPhase,
  type BindingId,
  type SeatSnapshot,
  type SeatStatus,
} from "@shared/harness-domain";
import { UrgencyLevel, UrgencyRank } from "@shared/wire/urgency";
import { SeatRaiseKind } from "@shared/wire/agent-signals";
import { ACTIVITY_AGO_MAX_MS, BoundedMs, clampMs } from "./seats-launch";

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TOOL = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const SIGNAL_NAME = /^SIG[A-Z0-9]{1,16}$/;
const HASH = /^[A-Za-z0-9_-]{1,128}$/;

const Id = Schema.String.pipe(Schema.check(Schema.isPattern(ID)));
const ToolName = Schema.String.pipe(Schema.check(Schema.isPattern(TOOL)));
const SignalName = Schema.String.pipe(Schema.check(Schema.isPattern(SIGNAL_NAME)));
const EvidenceHash = Schema.String.pipe(Schema.check(Schema.isPattern(HASH)));
const Ms = Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const Count = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const Pct = Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 })));
const Probability = Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 })));

const WireReason = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Permission"), requestId: Schema.optionalKey(Id), tool: Schema.optionalKey(ToolName) }),
  Schema.Struct({ _tag: Schema.Literal("Question") }),
  Schema.Struct({ _tag: Schema.Literal("Dialog"), kind: DialogKind }),
  Schema.Struct({
    _tag: Schema.Literal("UsageLimit"),
    scope: UsageLimitScope,
    resetsAt: Schema.optionalKey(Ms),
    autoResume: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ _tag: Schema.Literal("Error"), kind: ErrorKind }),
]);

const WireStatus = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Starting") }),
  Schema.Struct({ _tag: Schema.Literal("Idle") }),
  Schema.Struct({ _tag: Schema.Literal("Unknown") }),
  Schema.Struct({ _tag: Schema.Literal("Working"), phase: WorkingPhase }),
  Schema.Struct({ _tag: Schema.Literal("Blocked"), reason: WireReason }),
  Schema.Struct({
    _tag: Schema.Literal("Exited"),
    code: Schema.optionalKey(Schema.Int),
    signal: Schema.optionalKey(SignalName),
    expected: Schema.optionalKey(Schema.Boolean),
  }),
]);
type WireStatus = typeof WireStatus.Type;

const WireSnapshot = Schema.Struct({
  status: WireStatus,
  since: Ms,
  statusSource: SignalSource,
  statusFidelity: Fidelity,
  /** How long before sending the seat last left rest (`activitySince`). */
  activityAgoMs: Schema.optionalKey(BoundedMs(ACTIVITY_AGO_MAX_MS)),
  activity: Schema.optionalKey(Schema.Struct({ status: WireStatus, source: SignalSource, fidelity: Fidelity })),
  channels: Schema.Array(HarnessChannel).pipe(Schema.check(Schema.isMaxLength(8))),
  usage: Schema.optionalKey(
    Schema.Struct({
      contextPct: Schema.optionalKey(Pct),
      contextTokens: Schema.optionalKey(Count),
      contextWindow: Schema.optionalKey(Count),
      quotaPct: Schema.optionalKey(Pct),
      quotaWindow: Schema.optionalKey(UsageLimitScope),
      quotaResetsAt: Schema.optionalKey(Ms),
      costUsd: Schema.optionalKey(Ms),
      at: Ms,
    }),
  ),
  lastError: Schema.optionalKey(Schema.Struct({ kind: ErrorKind, at: Ms })),
  compaction: Schema.optionalKey(Schema.Struct({ trigger: CompactionTrigger, since: Ms })),
  turnUnseen: Schema.optionalKey(Schema.Struct({ outcome: Schema.Literals(["completed", "failed"]), since: Ms })),
  reports: Schema.Array(Schema.Struct({ kind: SeatRaiseKind, signalId: Id, since: Ms })).pipe(
    Schema.check(Schema.isMaxLength(32)),
  ),
  awareness: Schema.Array(
    Schema.Struct({ questionId: Id, answer: AwarenessAnswer, probability: Probability, evidenceHash: EvidenceHash, since: Ms }),
  ).pipe(Schema.check(Schema.isMaxLength(32))),
  stalledSince: Schema.optionalKey(Ms),
  wakeAt: Schema.optionalKey(Ms),
  lastDelivery: Schema.optionalKey(Schema.Struct({ messageId: Id, ok: Schema.Boolean, at: Ms })),
  updatedAt: Ms,
});

// Both machines run one build (the link refuses any other at hello), so the
// need crosses in the urgency module's own types.
const WireNeed = Schema.Struct({
  cause: NeedCause,
  level: UrgencyLevel,
  urgency: UrgencyRank,
  actor: NeedActor,
  since: Ms,
  source: SignalSource,
  probability: Schema.optionalKey(Probability),
});

/** A seat's status on the seats channel. */
export const SeatsStatus = Schema.Struct({ snapshot: WireSnapshot, need: WireNeed });
export type SeatsStatus = typeof SeatsStatus.Type;

export const decodeSeatsStatus = Schema.decodeUnknownSync(SeatsStatus, { onExcessProperty: "error" });

// ── Encoder: field by field ───────────────────────────────────────────────

const ok = (pattern: RegExp, value: string | undefined): value is string =>
  value !== undefined && pattern.test(value);
const ms = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0;
const count = (value: number | undefined): value is number => ms(value) && Number.isInteger(value);
const pct = (value: number | undefined): value is number => ms(value) && value <= 100;
const probability = (value: number | undefined): value is number => ms(value) && value <= 1;

const wireStatus = (status: SeatStatus): WireStatus => {
  switch (status._tag) {
    case "Starting":
    case "Idle":
    case "Unknown":
      return { _tag: status._tag };
    case "Working":
      return { _tag: "Working", phase: status.phase };
    case "Exited":
      return {
        _tag: "Exited",
        ...(status.code !== undefined && Number.isInteger(status.code) ? { code: status.code } : {}),
        ...(ok(SIGNAL_NAME, status.signal) ? { signal: status.signal } : {}),
        ...(status.expected === undefined ? {} : { expected: status.expected }),
      };
    case "Blocked": {
      const reason = status.reason;
      switch (reason._tag) {
        case "Permission":
          return {
            _tag: "Blocked",
            reason: {
              _tag: "Permission",
              ...(ok(ID, reason.requestId) ? { requestId: reason.requestId } : {}),
              ...(ok(TOOL, reason.tool) ? { tool: reason.tool } : {}),
            },
          };
        case "Question":
          return { _tag: "Blocked", reason: { _tag: "Question" } };
        case "Dialog":
          return { _tag: "Blocked", reason: { _tag: "Dialog", kind: reason.kind } };
        case "UsageLimit":
          return {
            _tag: "Blocked",
            reason: {
              _tag: "UsageLimit",
              scope: reason.scope,
              ...(ms(reason.resetsAt) ? { resetsAt: reason.resetsAt } : {}),
              ...(reason.autoResume === undefined ? {} : { autoResume: reason.autoResume }),
            },
          };
        case "Error":
          return { _tag: "Blocked", reason: { _tag: "Error", kind: reason.kind } };
      }
    }
  }
};

const wireUsage = (usage: NonNullable<SeatSnapshot["usage"]>) => ({
  ...(pct(usage.contextPct) ? { contextPct: usage.contextPct } : {}),
  ...(count(usage.contextTokens) ? { contextTokens: usage.contextTokens } : {}),
  ...(count(usage.contextWindow) ? { contextWindow: usage.contextWindow } : {}),
  ...(pct(usage.quotaPct) ? { quotaPct: usage.quotaPct } : {}),
  ...(usage.quotaWindow === undefined ? {} : { quotaWindow: usage.quotaWindow }),
  ...(ms(usage.quotaResetsAt) ? { quotaResetsAt: usage.quotaResetsAt } : {}),
  ...(ms(usage.costUsd) ? { costUsd: usage.costUsd } : {}),
  at: usage.at,
});

/**
 * The approved fields of a seat's status, and nothing else. An id or name
 * outside its pattern is left out; an entry that cannot cross without one
 * (a declared signal, an awareness reading, a delivery) is left out whole.
 * Durations are measured at `now`. Undefined when what remains still does
 * not read as the wire schema.
 */
export const toSeatsStatus = ({ snapshot, need }: AgentSeatStatus, now: number): SeatsStatus | undefined => {
  const wire = {
    snapshot: {
      status: wireStatus(snapshot.status),
      since: snapshot.since,
      statusSource: snapshot.statusSource,
      statusFidelity: snapshot.statusFidelity,
      ...(ms(snapshot.activitySince) ? { activityAgoMs: clampMs(now - snapshot.activitySince, ACTIVITY_AGO_MAX_MS) } : {}),
      ...(snapshot.activity === undefined
        ? {}
        : {
            activity: {
              status: wireStatus(snapshot.activity.status),
              source: snapshot.activity.source,
              fidelity: snapshot.activity.fidelity,
            },
          }),
      channels: snapshot.channels.slice(0, 8),
      ...(snapshot.usage === undefined ? {} : { usage: wireUsage(snapshot.usage) }),
      ...(snapshot.lastError === undefined ? {} : { lastError: { kind: snapshot.lastError.kind, at: snapshot.lastError.at } }),
      ...(snapshot.compaction === undefined
        ? {}
        : { compaction: { trigger: snapshot.compaction.trigger, since: snapshot.compaction.since } }),
      ...(snapshot.turnUnseen === undefined
        ? {}
        : { turnUnseen: { outcome: snapshot.turnUnseen.outcome, since: snapshot.turnUnseen.since } }),
      reports: snapshot.reports
        .filter((report) => ok(ID, report.signalId))
        .slice(0, 32)
        .map((report) => ({ kind: report.kind, signalId: report.signalId, since: report.since })),
      awareness: snapshot.awareness
        .filter((reading) => ok(ID, reading.questionId) && ok(HASH, reading.evidenceHash) && probability(reading.probability))
        .slice(0, 32)
        .map((reading) => ({
          questionId: reading.questionId,
          answer: reading.answer,
          probability: reading.probability,
          evidenceHash: reading.evidenceHash,
          since: reading.since,
        })),
      ...(ms(snapshot.stalledSince) ? { stalledSince: snapshot.stalledSince } : {}),
      ...(ms(snapshot.wakeAt) ? { wakeAt: snapshot.wakeAt } : {}),
      ...(snapshot.lastDelivery !== undefined && ok(ID, snapshot.lastDelivery.messageId)
        ? { lastDelivery: { messageId: snapshot.lastDelivery.messageId, ok: snapshot.lastDelivery.ok, at: snapshot.lastDelivery.at } }
        : {}),
      updatedAt: snapshot.updatedAt,
    },
    need: {
      cause: need.cause,
      level: need.level,
      urgency: need.urgency,
      actor: need.actor,
      since: need.since,
      source: need.source,
      ...(probability(need.probability) ? { probability: need.probability } : {}),
    },
  };
  try {
    return decodeSeatsStatus(wire);
  } catch {
    return undefined;
  }
};

const SEGMENT = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Where a status failed to read, as fixed copy: the field path and the kind
 * of issue, never the decoder's text, since that may quote what the peer
 * sent. A key outside a plain name reads as "?".
 */
export const statusIssueAt = (cause: unknown): string => {
  const path: string[] = [];
  let issue: unknown = typeof cause === "object" && cause !== null && "issue" in cause ? cause.issue : undefined;
  let kind = "Unknown";
  for (let depth = 0; depth < 32 && typeof issue === "object" && issue !== null; depth++) {
    const node = issue as { readonly _tag?: unknown; readonly path?: unknown; readonly issue?: unknown; readonly issues?: unknown };
    if (Array.isArray(node.path)) {
      for (const key of node.path) path.push(typeof key === "number" || (typeof key === "string" && SEGMENT.test(key)) ? String(key) : "?");
    }
    if (typeof node._tag === "string" && SEGMENT.test(node._tag)) kind = node._tag;
    issue = node.issue ?? (Array.isArray(node.issues) ? node.issues[0] : undefined);
  }
  return `${kind} at ${path.length === 0 ? "the status" : path.slice(0, 12).join(".")}`;
};

/**
 * The status as the receiving machine holds it, on its own node's binding
 * and its own clock at `now`. What stayed home stays absent.
 */
export const fromSeatsStatus = (wire: SeatsStatus, seat: BindingId, now: number): AgentSeatStatus => {
  const { activityAgoMs, ...snapshot } = wire.snapshot;
  return {
    snapshot: { ...snapshot, seat, ...(activityAgoMs === undefined ? {} : { activitySince: Math.max(0, now - activityAgoMs) }) },
    need: wire.need,
  };
};
