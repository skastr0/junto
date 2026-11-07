/**
 * How a work op refuses, on its RPC error channel: the v1 error body,
 * `{type, message, details}`, as one tagged error. The work socket writes it
 * back as v1's `error`, without the tag, so a seat reads what it read before.
 */
import { Context, Schema } from "effect";
import { type WorkErrorBody, WorkErrorDetails, WorkErrorType } from "../../shared/work-control";

export class WorkFailure extends Schema.TaggedError<WorkFailure>()("WorkFailure", {
  type: WorkErrorType,
  message: Schema.String,
  details: Schema.optionalKey(WorkErrorDetails),
}) {}

/** A v1 error body as a work op's failure. */
export const workFailure = (body: WorkErrorBody): WorkFailure => new WorkFailure(body);

/** A work op's failure as v1 writes it: the body, without the tag. */
export const workErrorBody = (failure: Pick<WorkFailure, "type" | "message" | "details">): WorkErrorBody => ({
  type: failure.type,
  message: failure.message,
  ...(failure.details === undefined ? {} : { details: failure.details }),
});

/**
 * The refusal an op answers when its arguments do not decode, for an op whose
 * words must not quote the input. Absent, the refusal carries the schema's own
 * words.
 */
export const WorkInputRefusal = Context.Reference<WorkErrorBody | undefined>("@junto/contract/work/WorkInputRefusal", {
  defaultValue: () => undefined,
});
