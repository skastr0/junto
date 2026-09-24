/**
 * Canonical crew domain: mail evidence refs, the mail extension, and review
 * verdicts. This module is the single home for these schemas; every other
 * lane consumes these exports and the repository projection rather than
 * minting parallel metadata keys.
 *
 *  - Mail extension: typed sender stamp, kind, subject and evidence refs
 *    carried in a Message's open `metadata` (no parallel body store). Set once
 *    when the message is appended. Delivery, read, reply and react live in
 *    the receipt plane and are projected onto the message.
 *  - Review verdicts: immutable, seat-stamped, epoch-bound green/blocking
 *    judgements bound to the exact full task identity and a canonical subject
 *    hash.
 */

import { Schema } from "effect";
import { ActorSeatId } from "./actor-seat";

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

// ---- Mail kind, sender stamp, and the Message metadata extension ----

/**
 * The sender's choice of shape. notice = a short "mail from X" line typed
 * into the recipient's input; prompt = the full text typed in; receipt =
 * review feed. Every kind is typed at once, whatever the recipient is doing.
 */
export const MailKind = Schema.Literals(["notice", "prompt", "receipt"]);
export type MailKind = typeof MailKind.Type;

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
 * message predates the mail extension (installed rows stay readable).
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
