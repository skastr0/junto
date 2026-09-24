/**
 * Managed-prompt contract: the outcome vocabulary the drive resolves for each
 * gated write (pulses, doctrine, board, overseer). Mail does not use it: mail
 * goes through the drive's `writeMail`, which never refuses.
 */

import { Schema } from "effect";

/**
 * Pre-write refusal reasons for a gated write. Every one means no prompt byte
 * reached the PTY on this attempt, so the caller may retry without replay
 * risk.
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
]);
export type ManagedPromptRefusalReason =
  typeof ManagedPromptRefusalReason.Type;

/**
 * Written-but-unreceipted reasons. Bytes reached the PTY without turn-start
 * evidence, so the same generation must never replay them; only a new
 * generation may.
 */
export const ManagedPromptUnresolvedReason = Schema.Literals([
  "no-turn-start",
  "chip-pending",
]);
export type ManagedPromptUnresolvedReason =
  typeof ManagedPromptUnresolvedReason.Type;

/**
 * Canonical result of one managed write attempt. The facts ride every
 * variant so a caller can decide on a retry without re-reading drive
 * internals:
 * - `bindingGeneration` — the drive terminal-epoch cut the attempt ran under;
 * - `writesBefore` / `writesAfter` — the drive paste-envelope counter
 *   around the attempt; `after > before` proves bytes reached the PTY;
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
