import { Schema } from "effect";
import { MachineName } from "./machine-control";

/**
 * Schemas only. A failure as it crosses a machine or enters a log: its tag, its scrubbed message, the
 * machine it happened on, the operation id, and its cause chain as tag and
 * message pairs (docs/machines.md, Failures and logs). The one encoder is
 * `src/main/junto/failure-encode.ts`; nothing else builds this shape.
 */
export const MAX_FAILURE_CAUSES = 8;
export const OperationId = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(64)), Schema.check(Schema.isPattern(/^[A-Za-z0-9._-]+$/)));
export const FailureTag = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(64)), Schema.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]*$/)));
export const FailureText = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(1024)));
export const EncodedCause = Schema.Struct({ tag: FailureTag, message: FailureText });
export type EncodedCause = typeof EncodedCause.Type;
export const EncodedCauses = Schema.Array(EncodedCause).pipe(Schema.check(Schema.isMaxLength(MAX_FAILURE_CAUSES)));
export const EncodedFailure = Schema.Struct({
  tag: FailureTag,
  message: FailureText,
  machine: MachineName,
  /** Required on every failure that crosses a link; a local log row may have none. */
  operationId: Schema.optionalKey(OperationId),
  causes: EncodedCauses,
  /** Present when the chain was longer than its bound. */
  causesCut: Schema.optionalKey(Schema.Literal(true)),
  /** A channel's own closed failure, encoded by that channel's schema. */
  detail: Schema.optionalKey(Schema.Json),
});
export type EncodedFailure = typeof EncodedFailure.Type;

/** "message: cause: first cause", the sentence a person reads. */
export const failureSentence = (failure: Pick<EncodedFailure, "message" | "causes">): string =>
  [failure.message, ...failure.causes.map(link => link.message)].filter((part, index, all) => all.indexOf(part) === index).join(": ");
