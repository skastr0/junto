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
 * words. As a function, it is handed the schema's words, for an op whose v1
 * refusal kept them in a body of its own.
 */
export const WorkInputRefusal = Context.Reference<WorkErrorBody | ((message: string) => WorkErrorBody) | undefined>("@junto/contract/work/WorkInputRefusal", {
  defaultValue: () => undefined,
});

/**
 * The hint an op's argument refusal carries, for an op whose refusal keeps
 * the schema's words but names its own place to look. Absent, the hint is the
 * command schema's.
 */
export const WorkInputHint = Context.Reference<string | undefined>("@junto/contract/work/WorkInputHint", {
  defaultValue: () => undefined,
});
