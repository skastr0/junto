/**
 * Managed-prompt contract — the canonical delivery outcome vocabulary for the
 * drive and the delivery service.
 *
 * Mail evidence refs, mail kinds, attempt reasons, write evidence, recipient
 * generations, and the display derivation are the canonical storage-lane
 * domain (`@shared/crew`): this module re-exports them and adds only the
 * transport-internal outcome the drive resolves per attempt. Do not mint
 * parallel keys here — readers use the crew names, writers write them.
 *
 * Display state is derived from facts, never stored.
 */

export {
  deriveMailDisplayState,
  mailExtensionMetadata,
  readMailExtension,
  type DeliveryAttempt,
  type MailAttemptFacts,
  type MailAttemptReason,
  type MailDeliveryPolicy,
  type MailDisplayFacts,
  type MailDisplayState,
  type MailEvidenceRef,
  type MailExtension,
  type MailKind,
  type MailSenderStamp,
  type MailWriteEvidence,
  type RecipientGeneration,
  type ReviewVerdict,
  type VerdictKind,
  type VerdictSubject,
} from "./crew";

import { Schema } from "effect";
import type { MailAttemptReason } from "./crew";
import { MESSAGE_PTY_FULL_BODY_MAX } from "./message-delivery";

/**
 * Pre-write refusal reasons (transport-internal detail). Every one means no
 * prompt byte reached the PTY on this attempt, so the attempt is retryable
 * without replay risk. Mapped to the closed {@link MailAttemptReason} at the
 * durable record boundary — the drive keeps the finer cause, the ledger
 * keeps the canonical reason.
 */
export const ManagedPromptRefusalReason = Schema.Literals([
  "seat-busy",
  "composer-not-empty",
  "composer-unreadable",
  "not-ready",
  "operator-active",
  "clipboard-unsafe",
  "multiline-refused",
  "written-unresolved",
  "queue-timeout",
  "cancelled",
  "suspended",
  "over-limit",
]);
export type ManagedPromptRefusalReason =
  typeof ManagedPromptRefusalReason.Type;

/**
 * Written-but-unreceipted reasons. Bytes reached the PTY without turn-start
 * evidence, so the same generation must never replay them — only a new
 * recipient generation, an explicit resume batch, or operator action may.
 */
export const ManagedPromptUnresolvedReason = Schema.Literals([
  "no-turn-start",
  "chip-pending",
]);
export type ManagedPromptUnresolvedReason =
  typeof ManagedPromptUnresolvedReason.Type;

/**
 * Canonical result of one managed write attempt. The facts ride every
 * variant so the delivery layer can apply the transport policy without
 * re-reading drive internals:
 * - `bindingGeneration` — the drive terminal-epoch cut the attempt ran
 *   under (transport-internal; the durable attempt identity uses the
 *   recipient seat generation string, a distinct field);
 * - `writesBefore` / `writesAfter` — the drive paste-envelope counter
 *   around the attempt; `after > before` proves bytes reached the PTY and
 *   feeds `MailWriteEvidence` directly;
 * - `pasteWrites` — envelopes written by this attempt (`after - before`);
 * - `wrotePhysicalBytes` — any prompt byte reached the PTY on this attempt.
 */
export const ManagedPromptOutcomeFacts = Schema.Struct({
  bindingGeneration: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  writesBefore: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  writesAfter: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  pasteWrites: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  wrotePhysicalBytes: Schema.Boolean,
});
export type ManagedPromptOutcomeFacts =
  typeof ManagedPromptOutcomeFacts.Type;

/**
 * Canonical result of one managed write attempt, validated at the wire
 * (term/control-server managedPrompt) the same way. Callers map
 * submitted to success, refused to a retryable false, and unresolved (or
 * refused/written-unresolved) to an uncertainty error — never a bare
 * Boolean() of the payload.
 */
const ManagedPromptOutcomeUnion = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("submitted"),
    ...ManagedPromptOutcomeFacts.fields,
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: ManagedPromptRefusalReason,
    ...ManagedPromptOutcomeFacts.fields,
  }),
  Schema.Struct({
    status: Schema.Literal("unresolved"),
    reason: ManagedPromptUnresolvedReason,
    ...ManagedPromptOutcomeFacts.fields,
  }),
]);

const countersCoherent = Schema.makeFilter(
  (outcome: typeof ManagedPromptOutcomeUnion.Type): boolean =>
    outcome.writesAfter >= outcome.writesBefore &&
    outcome.pasteWrites === outcome.writesAfter - outcome.writesBefore,
);

export const ManagedPromptOutcome = ManagedPromptOutcomeUnion.pipe(
  // Counter coherence, matching the documented facts: an envelope delta
  // cannot go backwards, and the per-attempt count is exactly the delta.
  // A submitted receipt with contradictory counters proves nothing.
  Schema.check(countersCoherent),
);
export type ManagedPromptOutcome = typeof ManagedPromptOutcome.Type;

const decodeManagedPromptOutcome = Schema.decodeUnknownOption(
  ManagedPromptOutcome,
);

/** Validate a wire payload as an outcome, or undefined when it proves nothing. */
export const readManagedPromptOutcome = (
  value: unknown,
): ManagedPromptOutcome | undefined => {
  const option = decodeManagedPromptOutcome(value);
  return option._tag === "Some" ? option.value : undefined;
};

export const isPromptSubmitted = (
  outcome: ManagedPromptOutcome,
): boolean => outcome.status === "submitted";

export const isPromptRefused = (
  outcome: ManagedPromptOutcome,
): boolean => outcome.status === "refused";

/** True when the attempt put bytes on the PTY — replay is then forbidden in this generation. */
export const outcomeWrotePhysical = (
  outcome: ManagedPromptOutcome,
): boolean => outcome.wrotePhysicalBytes;

/**
 * Map a transport-internal refusal to the closed durable reason. Lifecycle
 * cuts (`cancelled`, `suspended`) map to undefined: they are not transport
 * verdicts, so they record nothing and leave the message pending.
 */
export const mailAttemptReasonOfRefusal = (
  reason: ManagedPromptRefusalReason,
): MailAttemptReason | undefined => {
  switch (reason) {
    case "seat-busy":
      return "seat-busy";
    case "composer-not-empty":
      return "composer-draft";
    case "composer-unreadable":
      return "composer-unreadable";
    case "operator-active":
      return "operator-interlock";
    case "clipboard-unsafe":
      return "operator-interlock";
    case "not-ready":
      return "seat-busy";
    case "queue-timeout":
      return "seat-busy";
    case "multiline-refused":
      return "oversize";
    case "over-limit":
      return "oversize";
    case "written-unresolved":
      return "written-no-evidence";
    case "cancelled":
    case "suspended":
      return undefined;
  }
};

/** Immediate-prompt body bound: a prompt pastes full-body only when short. */
export const MANAGED_PROMPT_IMMEDIATE_MAX = MESSAGE_PTY_FULL_BODY_MAX;

export type ImmediatePromptAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: "over-limit" };

/**
 * Immediate-prompt admission: a short body. The seat's state is not a
 * question here — a prompt goes to an idle or working seat like any mail,
 * and the drive alone refuses a draft or dialog screen. Oversize bodies
 * refuse over-limit. Ordinary-notice fallback happens only on explicit
 * request, never implicitly.
 */
export const admitImmediatePrompt = (input: {
  readonly bodyChars: number;
}): ImmediatePromptAdmission =>
  input.bodyChars > MANAGED_PROMPT_IMMEDIATE_MAX
    ? { admitted: false, reason: "over-limit" }
    : { admitted: true };
