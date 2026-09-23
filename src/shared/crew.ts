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
import { ActorRef } from "./work-reference";
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

const decodeMailEvidenceRef = Schema.decodeUnknownOption(MailEvidenceRef);

/**
 * Decode one mail evidence ref, or undefined when it does not validate. This is
 * the single codec boundary for evidence refs: the renderer delegates here
 * rather than decoding metadata itself.
 */
export const readMailEvidenceRef = (
  value: unknown,
): MailEvidenceRef | undefined => {
  const option = decodeMailEvidenceRef(value);
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
  // History only: the removed idle and settle gates wrote these. The
  // expand-only schema and decode-admits-history keep them readable; no
  // current path writes them.
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
  /**
   * Stamped durably immediately BEFORE the physical transport write, as an
   * intent witness. On recovery a row with `attemptedAt` set but no terminal
   * outcome (notified/unresolved/refused) is a crash-after-intent: it resolves
   * to `unresolved` (uncertain, preserved) and is never blindly replayed in the
   * same generation. `queuedAt` without `attemptedAt` is a clean durable
   * enqueue that no transport has touched.
   */
  attemptedAt: Schema.optionalKey(CrewTimestamp),
  notifiedAt: Schema.optionalKey(CrewTimestamp),
  unresolvedAt: Schema.optionalKey(CrewTimestamp),
  refusedAt: Schema.optionalKey(CrewTimestamp),
  refusedReason: Schema.optionalKey(MailAttemptReason),
});
export type MailAttemptFacts = typeof MailAttemptFacts.Type;

/**
 * The delivery projection stamps the current-generation attempt facts as FLAT
 * keys on a mailbox Message's metadata, using the {@link MailAttemptFacts}
 * field names directly (`queuedAt`, `notifiedAt`, `unresolvedAt`, `refusedAt`,
 * `refusedReason`, `generation`). The ledger reads them via
 * {@link readMailAttemptFacts}; the reason key is `refusedReason` only.
 */
const decodeMailAttemptFacts = Schema.decodeUnknownOption(MailAttemptFacts);

/** Read the current-generation attempt facts a projection stamped, if any. */
export const readMailAttemptFacts = (
  metadata: unknown,
): MailAttemptFacts | undefined => {
  if (metadata === null || typeof metadata !== "object") return undefined;
  const option = decodeMailAttemptFacts(metadata);
  return option._tag === "Some" ? option.value : undefined;
};

/** The flat metadata fragment a projection merges to carry the attempt facts. */
export const mailAttemptFactsMetadata = (
  facts: MailAttemptFacts,
): Record<string, unknown> => ({
  generation: facts.generation,
  queuedAt: facts.queuedAt,
  ...(facts.attemptedAt !== undefined ? { attemptedAt: facts.attemptedAt } : {}),
  ...(facts.notifiedAt !== undefined ? { notifiedAt: facts.notifiedAt } : {}),
  ...(facts.unresolvedAt !== undefined ? { unresolvedAt: facts.unresolvedAt } : {}),
  ...(facts.refusedAt !== undefined ? { refusedAt: facts.refusedAt } : {}),
  ...(facts.refusedReason !== undefined ? { refusedReason: facts.refusedReason } : {}),
});

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
  /**
   * Open/close intent versioning for the same-generation hold. A held row
   * (unresolved, un-notified) authorizes a fresh attempt only when an
   * operator grant opened a new intent (attemptSeq > resolvedSeq); a closed
   * held row never auto-retries. Absent on rows read through older doubles.
   */
  attemptSeq: Schema.optionalKey(Schema.Int),
  resolvedSeq: Schema.optionalKey(Schema.Int),
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
 * Rank the independent facts into one display state. Proven notification
 * resolves earlier transport uncertainty without implying recipient read.
 * Without that proof, unresolved outranks a no-write refusal. All historical
 * facts remain intact regardless of the displayed state.
 */
export const deriveMailDisplayState = (
  facts: MailDisplayFacts,
): MailDisplayState => {
  if (facts.reactedAt !== undefined) return "reacted";
  if (facts.repliedAt !== undefined) return "replied";
  if (facts.readAt !== undefined) return "read";
  if (facts.notifiedAt !== undefined) return "notified";
  if (facts.unresolvedAt !== undefined) return "unresolved";
  if (facts.refusedAt !== undefined) return "refused";
  return "queued";
};

// ---- Review verdicts ----

/** A verdict is green (clears the gate) or blocking (sends back with a defect). */
export const VerdictKind = Schema.Literals(["green", "blocking"]);
export type VerdictKind = typeof VerdictKind.Type;

/**
 * The exact subject a verdict binds to. A task subject carries the full task
 * identity — installation home, canvas, node, task id — plus the task epoch it
 * judged, never a bare task id. A commit subject carries the commit sha. Both
 * arms carry `subjectHash`, the authoritative canonical binding computed
 * server-side over the identity (see {@link verdictSubjectHashPayload}); the
 * gate compares that hash, so an old green cannot bless newly submitted refs.
 */
export const VerdictSubject = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("task"),
    installationId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    canvasName: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    nodeId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    taskId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    epoch: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
    subjectHash: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  }),
  Schema.Struct({
    kind: Schema.Literal("commit"),
    sha: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    subjectHash: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  }),
]);
export type VerdictSubject = typeof VerdictSubject.Type;

/**
 * An immutable, seat-stamped verdict. `verdictId` is a unique per-posting id
 * (a ULID minted at post); a reviewer may post blocking then later green on the
 * same binding, and each posting is its own immutable row, ordered by
 * `postedAtMs`. `epoch` is the task epoch the verdict is bound to (0 for an
 * unbound commit subject); a stale verdict from an older epoch cannot move a
 * newer one, and an old green cannot bless newly submitted refs because the
 * gate matches both `epoch` and `subjectHash`. `authorSeatId` and `subjectHash`
 * are server-derived at post, never client-supplied; `subjectHash` is also the
 * indexed gate key.
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

const decodeReviewVerdict = Schema.decodeUnknownOption(ReviewVerdict);

/**
 * Decode one canonical verdict, or undefined when it does not validate. The
 * single codec boundary for verdicts: the renderer delegates here rather than
 * decoding a verdict projection itself.
 */
export const readReviewVerdict = (
  value: unknown,
): ReviewVerdict | undefined => {
  const option = decodeReviewVerdict(value);
  return option._tag === "Some" ? option.value : undefined;
};

/** Domain separator for the subject hash, so hashes never collide across kinds. */
export const VERDICT_SUBJECT_HASH_DOMAIN = "junto/crew/verdict-subject/v1";

/**
 * The ordered, canonical payload the subject hash is computed over. The
 * repository applies sha256 to this string to produce `subjectHash`; every
 * lane must build the hash from this same function so the gate compares
 * identical bytes. Commit shas passed for a task subject are normalized
 * (lowercased, sorted, de-duplicated) so ref order never changes the identity.
 */
export type VerdictArtifactRef = {
  readonly nodeId: string;
  readonly artifactId: string;
};

export const verdictSubjectHashPayload = (
  input:
    | {
        readonly kind: "task";
        readonly installationId: string;
        readonly canvasName: string;
        readonly nodeId: string;
        readonly taskId: string;
        readonly epoch: number;
        readonly commitShas?: ReadonlyArray<string>;
        readonly artifactRefs?: ReadonlyArray<VerdictArtifactRef>;
        readonly claimRefs?: ReadonlyArray<string>;
      }
    | { readonly kind: "commit"; readonly sha: string },
): string => {
  if (input.kind === "commit") {
    return JSON.stringify([VERDICT_SUBJECT_HASH_DOMAIN, "commit", input.sha]);
  }
  // Commit shas: trim, lowercase (the only case-folding), dedupe, sort.
  const commits = [
    ...new Set((input.commitShas ?? []).map((sha) => sha.trim().toLowerCase())),
  ].sort();
  // Artifact refs: dedupe exact (nodeId, artifactId) pairs, sort by nodeId then
  // artifactId, case preserved. Emitted as [nodeId, artifactId] tuples.
  const artifactSeen = new Set<string>();
  const artifacts: Array<readonly [string, string]> = [];
  for (const ref of input.artifactRefs ?? []) {
    const key = `${ref.nodeId}\u0000${ref.artifactId}`;
    if (artifactSeen.has(key)) continue;
    artifactSeen.add(key);
    artifacts.push([ref.nodeId, ref.artifactId]);
  }
  artifacts.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  );
  // Claim refs: trim, dedupe, sort, case preserved.
  const claimRefs = [
    ...new Set((input.claimRefs ?? []).map((ref) => ref.trim())),
  ].sort();
  // Three distinct slots so a claim ref can never alias a sha or artifact pair.
  return JSON.stringify([
    VERDICT_SUBJECT_HASH_DOMAIN,
    "task",
    input.installationId,
    input.canvasName,
    input.nodeId,
    input.taskId,
    input.epoch,
    commits,
    artifacts,
    claimRefs,
  ]);
};
