import { Effect, Result } from "effect";
import { overseerOperationEnabled } from "@shared/features";
import {
  decodeOverseerArgs,
  OVERSEER_CATALOG,
  OVERSEER_MAX_ERROR_BYTES,
  OVERSEER_MAX_RESULT_BYTES,
  type OverseerCaller,
  type OverseerErrorType,
  type OverseerRequest,
  type OverseerResult,
} from "@shared/overseer-control";
import type { InstallationId } from "@shared/installation-id";
import type { WorkErrorBody } from "@shared/work-control";
import { admitOverseer, watchOverseerRevocation } from "./admission";
import { executeOverseerCanvas } from "./canvas";
import { executeOverseerWork } from "./work";

export interface OverseerRuntime {
  readonly native: (
    caller: OverseerCaller,
    request: OverseerRequest,
  ) => Effect.Effect<unknown, WorkErrorBody>;
  /** Uses only the already-open, paired Command Center session. */
  readonly forward: (
    caller: OverseerCaller,
    request: OverseerRequest,
  ) => Effect.Effect<OverseerResult, WorkErrorBody>;
}

const errorType = (type: WorkErrorBody["type"]): OverseerErrorType => {
  switch (type) {
    case "ScopeError": case "AuthError": case "ReviewerIsAuthor": return "Forbidden";
    case "UnknownTarget": case "StaleNodeRef": return "NotFound";
    case "InputError": case "ProtocolError": return "InvalidArguments";
    case "ClaimConflict": case "InvalidTransition": return "Conflict";
    case "RuntimeDown": case "Timeout": return "RuntimeDown";
    case "Paused": case "Blocked": case "SeatBusy": return "Conflict";
    case "InternalError": return "InternalError";
  }
};

const failed = (request: OverseerRequest, error: WorkErrorBody): OverseerResult => ({
  ok: false,
  operation: request.operation,
  error: {
    type: errorType(error.type),
    // Leave room for a replacement character if truncation splits UTF-8.
    message: Buffer.from(error.message || "overseer command failed", "utf8")
      .subarray(0, OVERSEER_MAX_ERROR_BYTES - 3).toString("utf8"),
    ...(error.details === undefined ? {} : { details: error.details }),
  },
});

/** Shared CC/Remote dispatcher; caller and source are never command arguments. */
export const executeOverseer = Effect.fn("overseer.execute")(function* (
  caller: OverseerCaller,
  request: OverseerRequest,
  runtime: OverseerRuntime,
  sourceInstallationId?: InstallationId,
) {
  // Feature gates land before admission and decode: a disabled family is
  // unreachable even when a client sends the raw operation name.
  if (!overseerOperationEnabled(request.operation)) {
    return failed(request, {
      type: "ScopeError",
      message:
        `overseer ${request.operation} is disabled in this Vellum Command build`,
      details: {
        retryable: false,
        missing: "feature enabled in this build",
      },
    });
  }
  const decoded = decodeOverseerArgs(request.operation, request.args);
  if (Result.isFailure(decoded)) {
    return failed(request, { type: "InputError", message: decoded.failure.message });
  }
  const admitted = yield* admitOverseer(caller, sourceInstallationId).pipe(Effect.result);
  if (Result.isFailure(admitted)) return failed(request, admitted.failure);
  const authority = admitted.success;
  const operation = request.operation;
  const localResource = operation.startsWith("page.") || operation.startsWith("content.");

  const run = Effect.gen(function* () {
    if (authority.configuration.role === "remote" && !localResource) {
      return yield* runtime.forward(caller, request);
    }
    if (sourceInstallationId !== undefined && operation.startsWith("page.")) {
      return failed(request, {
        type: "ScopeError",
        message: "browser pages are controlled on the overseer's own installation",
      });
    }
    if (operation === "status") {
      return {
        ok: true,
        operation,
        data: {
          actor: authority.actor,
          installationId: authority.installationId,
          authorialInstallationId: authority.localInstallationId,
          role: authority.configuration.role,
          scope: "portfolio",
          humanDelegationOnly: true,
          affectedByPause: false,
          restrictions: ["self-retirement", "overseer-delegation", "operator-viewport"],
          commands: OVERSEER_CATALOG,
        },
      } satisfies OverseerResult;
    }
    const canvasOperation = operation !== "canvas.screenshot" && (
      operation.startsWith("canvas.") || operation.startsWith("node.") ||
      operation.startsWith("edge.") || operation.startsWith("sheet.")
    );
    const workOperation = operation.startsWith("tasks.") || operation.startsWith("request.") ||
      operation.startsWith("artifact.") || operation.startsWith("msg.") ||
      operation.startsWith("board.") || operation.startsWith("pad.") ||
      operation.startsWith("content.");
    const data = yield* canvasOperation
      ? executeOverseerCanvas(caller, request)
      : workOperation
        ? executeOverseerWork(caller, request, { kind: "overseer", actor: authority.actor })
        : runtime.native(caller, request);
    return { ok: true, operation, data } satisfies OverseerResult;
  });
  const result = yield* Effect.raceFirst(
    watchOverseerRevocation(caller, authority.actor, sourceInstallationId),
    run,
  ).pipe(Effect.catch((error) => Effect.succeed(failed(request, error))));
  const bytes = yield* Effect.try({
    try: () => Buffer.byteLength(JSON.stringify(result), "utf8"),
    catch: (): WorkErrorBody => ({ type: "InternalError", message: "overseer result is not serializable" }),
  }).pipe(Effect.result);
  if (Result.isFailure(bytes)) return failed(request, bytes.failure);
  if (bytes.success > OVERSEER_MAX_RESULT_BYTES) {
    return failed(request, {
      type: "ProtocolError",
      message: "overseer result exceeds the response byte limit; narrow the query before retrying reads",
      details: { retryable: false },
    });
  }
  return result;
});
