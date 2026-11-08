/**
 * A work op's answer and refusal as the socket writes them: a store's code
 * as a v1 error, and a write's outcome as its answer.
 */
import { Result } from "effect";
import { type WorkErrorDetails, type WorkErrorBody } from "@shared/work-control";
import { type WorkOpResult } from "../work/service";

/**
 * Deterministic code → wire mapping. Structured facts travel in
 * WorkServiceError.details straight from the service; nothing here is parsed
 * out of message text.
 */
export const mapWorkCode = (
  code: import("../work/service").WorkServiceErrorCode,
  message: string,
  details?: WorkErrorDetails,
): WorkErrorBody => {
  switch (code) {
    case "reviewer_is_author":
      return { type: "ReviewerIsAuthor", message, details: { ...details, retryable: false } };
    case "scope_error":
      return { type: "ScopeError", message, details: { ...details, retryable: false } };
    case "claim_contention":
      return {
        type: "ClaimConflict",
        message,
        details: {
          ...details,
          retryable: false,
          next_step:
            details?.next_step ??
            "wait for the holder to release, or pick another task",
        },
      };
    case "operator_owned":
      return {
        type: "ClaimConflict",
        message,
        details: {
          ...details,
          retryable: false,
          next_step:
            details?.next_step ??
            "the operator works tasks at this board; pick a board agents can claim",
        },
      };
    case "illegal_transition":
      return {
        type: "InvalidTransition",
        message,
        details: {
          ...details,
          retryable: false,
        },
      };
    case "node_not_found":
    case "task_not_found":
      return {
        type: "UnknownTarget",
        message,
        details: { ...details, retryable: false },
      };
    case "canvas_not_found":
      return {
        type: "StaleNodeRef",
        message,
        details: {
          ...details,
          retryable: false,
          next_step:
            details?.next_step ??
            "the canvas for this call is not loaded; ask the operator to open it in Junto",
        },
      };
    case "illegal_kind":
      return {
        type: "ScopeError",
        message,
        details: {
          ...details,
          retryable: false,
          hint: details?.hint ?? "pick a target whose kind supports this op",
          next_step:
            details?.next_step ??
            "call a connected node of a kind that supports this op; if none is connected, ask the operator to wire an edge to one on the canvas",
        },
      };
    case "not_ready":
      return {
        type: "InputError",
        message,
        details: {
          ...details,
          retryable: false,
          next_step:
            details?.next_step ??
            "finish the prerequisites before claiming this task",
        },
      };
    case "unadmitted":
      return {
        type: "InputError",
        message,
        details: {
          ...details,
          retryable: false,
          next_step:
            details?.next_step ??
            "wait for the operator or for the wait before starting to pass, or pick another task",
        },
      };
    case "fork_choice":
      return {
        type: "InputError",
        message,
        details: {
          ...details,
          retryable: false,
          next_step: details?.next_step ?? "name the next board",
        },
      };
    case "wrong_home":
      return {
        type: "InputError",
        message,
        details: {
          ...details,
          retryable: false,
          next_step:
            details?.next_step ??
            "run this op on the installation that owns the task",
        },
      };
    default:
      return {
        type: "InputError",
        message,
        details: { ...details, retryable: details?.retryable ?? false },
      };
  }
};

export type WorkMutationOutcome<T> = {
  readonly value: T;
  readonly disposition: "applied" | "queued";
  readonly message?: string;
};

export const fromWorkResult = <T>(
  result: WorkOpResult<T>,
): Result.Result<WorkMutationOutcome<T>, WorkErrorBody> => {
  if (result.ok) {
    return Result.succeed({
      value: result.data,
      disposition: result.disposition,
      ...(result.message === undefined ? {} : { message: result.message }),
    });
  }
  return Result.fail(
    mapWorkCode(result.code, result.message, result.details),
  );
};

export const exposeWorkMutation = <T extends object>(
  outcome: WorkMutationOutcome<T>,
): T & { readonly disposition: "applied" | "queued"; readonly message?: string } => ({
  ...outcome.value,
  disposition: outcome.disposition,
  ...(outcome.message === undefined ? {} : { message: outcome.message }),
});
