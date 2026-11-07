import { Effect, Option, Result, Schema } from "effect";
import { ContentStageArgs, type ContentStageResult } from "@shared/content-stage";
import type { WorkErrorBody } from "@shared/work-control";
import { ContentService } from "../content/service";
import {
  contentStagerFor,
  type ContentStageError,
  type ContentStageSeat,
} from "../content/stage";

/**
 * Work op `content.stage`: the calling seat puts a file of its own into the
 * content store, in pieces, ahead of the record that will name it.
 *
 * Seat-local like the signal ops: no edge, no port, and the seat is the
 * process-bound caller, never an argument. Nothing answered here names a
 * path on the operator's disk or repeats a byte of what was sent.
 */
const SCHEMA_HINT = "junto schema show content.stage";

const refusal = (error: ContentStageError): WorkErrorBody => {
  switch (error.code) {
    case "invalid":
    case "mismatch":
      return {
        type: "InputError",
        message: error.message,
        details: { path: "args", retryable: false, hint: SCHEMA_HINT },
      };
    case "not-found":
      return {
        type: "UnknownTarget",
        message: error.message,
        details: { retryable: false, next_step: "send the file again from its first piece" },
      };
    case "too-many":
      return { type: "ProtocolError", message: error.message, details: { retryable: false } };
    case "disk-low":
      return { type: "RuntimeDown", message: error.message, details: { retryable: true } };
    case "failed":
      return { type: "InternalError", message: error.message, details: { retryable: true } };
  }
};

export const handleContentStage = (
  seat: ContentStageSeat,
  args: unknown,
): Effect.Effect<ContentStageResult, WorkErrorBody> =>
  Effect.gen(function* () {
    const decoded = Schema.decodeUnknownResult(ContentStageArgs, {
      onExcessProperty: "error",
    })(args ?? {});
    if (Result.isFailure(decoded)) {
      // Fixed words: a schema message describes what it was given, and what
      // it was given here is file content.
      return yield* Effect.fail<WorkErrorBody>({
        type: "InputError",
        message:
          "content.stage takes {stageId?, bytesBase64?, done?: {mediaType, displayName?, expected?}} with a piece, a done, or both",
        details: { path: "args", retryable: false, hint: SCHEMA_HINT },
      });
    }
    const content = yield* Effect.serviceOption(ContentService);
    if (Option.isNone(content)) {
      return yield* Effect.fail<WorkErrorBody>({
        type: "RuntimeDown",
        message: "the content store is unavailable in this Junto runtime",
        details: { retryable: false },
      });
    }
    return yield* contentStagerFor(content.value)
      .stage(seat, decoded.success)
      .pipe(Effect.mapError(refusal));
  });
