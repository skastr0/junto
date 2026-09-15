/**
 * Canonical crew domain: mail evidence refs, mail facts and delivery-attempt
 * outcomes, and review verdicts. This module is the single home for these
 * schemas; every other lane consumes these exports and the repository
 * projection rather than minting parallel metadata keys.
 *
 * Three durable planes meet here and are kept independent:
 *
 *  - Mail extension: typed sender stamp, kind, subject and evidence refs
 *    carried in a Message's open `metadata` (no parallel body store). Set once
 *    when the message is appended.
 *  - Delivery attempt facts: per (messageId, recipient seat, recipient
 *    generation), the transport truth — queued, notified, unresolved, refused
 *    with a reason, plus physical write evidence. Timestamps are independent
 *    and never overwrite one another: a later no-write refusal cannot erase a
 *    prior unresolved physical write. Read/reply/react remain in the existing
 *    receipt plane and are projected alongside for display.
 *  - Review verdicts: immutable, seat-stamped, epoch-bound green/blocking
 *    judgements bound to the exact full task identity and a canonical subject
 *    hash.
 *
 * `epoch` (a task epoch, a monotonic integer) and `generation` (a recipient
 * seat's terminal generation key from the seat delivery snapshot, an opaque
 * string) are distinct fields and never interchangeable.
 */

import { Schema } from "effect";
import { ActorRef, TaskRef } from "./work-reference";
import { ActorSeatId } from "./actor-seat";

/** ISO display timestamp, matching the durable receipt columns (<=64 chars). */
export const CrewTimestamp = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
);
export type CrewTimestamp = typeof CrewTimestamp.Type;

// ---- Mail evidence refs ----

/**
 * Typed citation attached to mail. A `session-read` ref is a citation only:
 * transcript reading is not implemented in this iteration. Names match the
 * renderer seam exactly (`sha`, `taskId`, `actorRef`, `sessionId`).
 */
export const MailEvidenceRef = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("commit"), sha: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("file"),
    path: Schema.String,
    line: Schema.optionalKey(
      Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(1))),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal("task"), taskId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("seat"), actorRef: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("session-read"), sessionId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
]);
export type MailEvidenceRef = typeof MailEvidenceRef.Type;

// ---- Mail kind, policy, sender stamp, and the Message metadata extension ----

/** notice = ordinary mail, prompt = immediate full-body turn, receipt = review feed. */
export const MailKind = Schema.Literals(["notice", "prompt", "receipt"]);
export type MailKind = typeof MailKind.Type;

/** Transport intent: an ordinary notice or an immediate full-body prompt. */
export const MailDeliveryPolicy = Schema.Literals(["notice", "immediate"]);
export type MailDeliveryPolicy = typeof MailDeliveryPolicy.Type;

/**
 * Server-stamped sender identity, taken from the admitted process and the
 * current live canvas — never a client-supplied stamp. `fromSeat` is the
 * stable seat id; `senderNodeId` and `senderName` are the readable canvas
 * handle and display name so a notice or ledger link never truncates to a
 * `seat_` hash. Control stamps all four; a client cannot supply any.
 */
export const MailSenderStamp = Schema.Struct({
  fromSeat: ActorSeatId,
  senderNodeId: Schema.optionalKey(Schema.String),
  senderName: Schema.optionalKey(Schema.String),
  senderGeneration: Schema.String,
  senderHarness: Schema.String,
});
export type MailSenderStamp = typeof MailSenderStamp.Type;

/**
 * The typed mail fields carried in a Message's `metadata`. Producers stamp it
 * via {@link mailExtensionMetadata}; the ledger reads it via
 * {@link readMailExtension}. Keys are flat so the existing open metadata record
 * carries them without a work-model schema change.
 */
export const MailExtension = Schema.Struct({
  mailKind: MailKind,
  subject: Schema.optionalKey(Schema.String),
  refs: Schema.optionalKey(Schema.Array(MailEvidenceRef)),
  fromSeat: ActorSeatId,
  senderNodeId: Schema.optionalKey(Schema.String),
  senderName: Schema.optionalKey(Schema.String),
  senderGeneration: Schema.String,
  senderHarness: Schema.String,
});
export type MailExtension = typeof MailExtension.Type;

const decodeMailExtension = Schema.decodeUnknownOption(MailExtension);

/**
 * Read the mail extension from a Message's metadata, or undefined when the
 * message predates crew mail (installed rows stay readable).
 */
export const readMailExtension = (
  metadata: unknown,
): MailExtension | undefined => {
  if (metadata === null || typeof metadata !== "object") return undefined;
  const option = decodeMailExtension(metadata);
  return option._tag === "Some" ? option.value : undefined;
};

/** The metadata keys a producer merges into a Message to carry mail fields. */
export const mailExtensionMetadata = (
  ext: MailExtension,
): Record<string, unknown> => ({
  mailKind: ext.mailKind,
  ...(ext.subject !== undefined ? { subject: ext.subject } : {}),
  ...(ext.refs !== undefined ? { refs: ext.refs } : {}),
  fromSeat: ext.fromSeat,
  ...(ext.senderNodeId !== undefined ? { senderNodeId: ext.senderNodeId } : {}),
  ...(ext.senderName !== undefined ? { senderName: ext.senderName } : {}),
  senderGeneration: ext.senderGeneration,
  senderHarness: ext.senderHarness,
});

/**
 * Canonical timestamp conversion between the two planes. Delivery-attempt
 * facts are stored ISO; the read/reply/react receipt stamps surface in a live
 * Message's metadata as numeric epoch milliseconds. Normalize those to ISO for
 * display without ever rewriting the historical receipt bytes.
 */
export const crewTimestampFromEpochMs = (ms: number): string =>
  new Date(ms).toISOString();

/** Accept a numeric-ms or ISO stamp (or undefined) and return ISO (or undefined). */
export const normalizeDisplayTimestamp = (
  value: number | string | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : typeof value === "number"
      ? crewTimestampFromEpochMs(value)
      : value;

// ---- Delivery attempt facts (transport truth, independent timestamps) ----

/**
 * Reason a transport attempt refused before any byte, or the note on an
 * unresolved write. Closed vocabulary so the reason survives as data.
 */
export const MailAttemptReason = Schema.Literals([
  "seat-busy",
  "composer-draft",
  "composer-unreadable",
  "operator-interlock",
  "not-idle",
  "not-settled",
  "paused",
  "no-lease",
  "seat-gone",
  "oversize",
  "written-no-evidence",
]);
export type MailAttemptReason = typeof MailAttemptReason.Type;

/**
 * Physical write evidence from the managed drive: the paste-envelope counter
 * before and after the attempt. `after > before` proves bytes reached the PTY
 * (an unresolved write); equality proves nothing was typed (a clean refusal).
 */
export const MailWriteEvidence = Schema.Struct({
  writesBefore: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  writesAfter: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  at: CrewTimestamp,
});
export type MailWriteEvidence = typeof MailWriteEvidence.Type;

/**
 * A recipient generation: the stable seat plus the exact terminal generation
 * an attempt targeted. `generation` is the `generationKey` from the seat
 * delivery snapshot — an opaque, stable per-binding generation, never a task
 * epoch.
 */
export const RecipientGeneration = Schema.Struct({
  seat: ActorRef,
  generation: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});
export type RecipientGeneration = typeof RecipientGeneration.Type;

/**
 * Independent transport-fact timestamps for one attempt. Each is set at most
 * once and never clears another: a later refusal keeps a prior `unresolvedAt`,
 * so an accepted-then-failed write is not laundered into a fresh eligible one.
 */
export const MailAttemptFacts = Schema.Struct({
  generation: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  queuedAt: CrewTimestamp,
  notifiedAt: Schema.optionalKey(CrewTimestamp),
  unresolvedAt: Schema.optionalKey(CrewTimestamp),
  refusedAt: Schema.optionalKey(CrewTimestamp),
  refusedReason: Schema.optionalKey(MailAttemptReason),
});
export type MailAttemptFacts = typeof MailAttemptFacts.Type;

/**
 * One durable delivery attempt, keyed by message id plus recipient seat plus
 * recipient generation. Enqueued (queued) before any transport action. When it
 * was delivered as part of one batched notify, `batchId` records the exact
 * membership persisted before the external write.
 */
export const DeliveryAttempt = Schema.Struct({
  messageId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  recipient: RecipientGeneration,
  policy: MailDeliveryPolicy,
  batchId: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMinLength(1)))),
  facts: MailAttemptFacts,
  write: Schema.optionalKey(MailWriteEvidence),
});
export type DeliveryAttempt = typeof DeliveryAttempt.Type;

/**
 * Whether a message may be attempted for a fresh recipient generation.
 * `notified` and `read` suppress across generations (a delivered or read
 * message is never re-typed); an `unresolved` prior attempt allows exactly one
 * attempt on a new generation; `none` means never attempted.
 */
export const MailAttemptDisposition = Schema.Literals([
  "none",
  "queued",
  "notified",
  "unresolved",
  "refused",
]);
export type MailAttemptDisposition = typeof MailAttemptDisposition.Type;

/**
 * Full display state for the actor ledger, derived from transport facts and
 * the existing read/reply/react receipt plane. Never stored.
 */
export const MailDisplayState = Schema.Literals([
  "queued",
  "notified",
  "unresolved",
  "refused",
  "read",
  "replied",
  "reacted",
]);
export type MailDisplayState = typeof MailDisplayState.Type;

/** Facts the display derivation reads; transport plus receipt-plane stamps. */
export type MailDisplayFacts = {
  readonly queuedAt?: string;
  readonly notifiedAt?: string;
  readonly unresolvedAt?: string;
  readonly refusedAt?: string;
  readonly readAt?: string;
  readonly repliedAt?: string;
  readonly reactedAt?: string;
};

/**
 * Rank the independent facts into one display state. Recipient acknowledgement
 * outranks transport; and per the root correction, `unresolved` outranks a
 * later `refused` so a no-write refusal cannot hide a prior physical write.
 */
export const deriveMailDisplayState = (
  facts: MailDisplayFacts,
): MailDisplayState => {
  if (facts.reactedAt !== undefined) return "reacted";
  if (facts.repliedAt !== undefined) return "replied";
  if (facts.readAt !== undefined) return "read";
  if (facts.unresolvedAt !== undefined) return "unresolved";
  if (facts.refusedAt !== undefined) return "refused";
  if (facts.notifiedAt !== undefined) return "notified";
  return "queued";
};

// ---- Review verdicts ----

/** A verdict is green (clears the gate) or blocking (sends back with a defect). */
export const VerdictKind = Schema.Literals(["green", "blocking"]);
export type VerdictKind = typeof VerdictKind.Type;

/**
 * The exact subject a verdict binds to. A task subject carries the full
 * {@link TaskRef} (sink canvas, node and item id) plus the task epoch it
 * judged — never a bare task id. A commit subject carries the commit sha and
 * optional checkout. The authoritative binding is {@link ReviewVerdict.subjectHash}.
 */
export const VerdictSubject = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("task"),
    task: TaskRef,
    epoch: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  Schema.Struct({
    kind: Schema.Literal("commit"),
    sha: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    checkout: Schema.optionalKey(Schema.String),
  }),
]);
export type VerdictSubject = typeof VerdictSubject.Type;

/**
 * An immutable, seat-stamped verdict. `verdictId` is a unique per-posting
 * idempotency key: a reviewer may post blocking then later green on a revised
 * subject, so each posting is its own immutable row. `epoch` is the task epoch
 * the verdict is bound to; a stale verdict from an older epoch cannot move a
 * newer one, and an old green cannot bless newly submitted refs because the
 * gate matches both `epoch` and `subjectHash`. `authorSeatId` records the
 * author for unambiguous reviewer-distinctness.
 */
export const ReviewVerdict = Schema.Struct({
  verdictId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  kind: VerdictKind,
  reviewerSeatId: ActorSeatId,
  reviewerNodeId: Schema.optionalKey(Schema.String),
  authorSeatId: ActorSeatId,
  subject: VerdictSubject,
  subjectHash: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  epoch: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  findings: Schema.Array(Schema.String),
  refs: Schema.Array(MailEvidenceRef),
  postedAtMs: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type ReviewVerdict = typeof ReviewVerdict.Type;

/**
 * Deterministic canonical string over a verdict's exact subject and refs. The
 * repository hashes this to produce `subjectHash`; every lane must derive the
 * hash from this same serialization so the gate compares identical bytes.
 * Object keys are emitted in sorted order; ref array order is preserved as
 * authored (the exact refs, not a set).
 */
export const canonicalSubjectString = (input: {
  readonly subject: VerdictSubject;
  readonly refs: ReadonlyArray<MailEvidenceRef>;
}): string => stableStringify({ subject: input.subject, refs: input.refs });

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
};
