import { Effect, Result } from "effect";
import { overseerOperationEnabled } from "@shared/features";
import {
  decodeOverseerArgs,
  OVERSEER_CATALOG,
  OVERSEER_MAX_ERROR_BYTES,
  OVERSEER_MAX_RESULT_BYTES,
  type OverseerArgsFor,
  type OverseerCaller,
  type OverseerErrorType,
  type OverseerRequest,
  type OverseerResult,
} from "@shared/overseer-control";
import { narrowEnvironmentReport } from "@shared/overseer-env";
import type { InstallationId } from "@shared/installation-id";
import type { WorkErrorBody } from "@shared/work-control";
import { admitOverseer, watchOverseerRevocation } from "./admission";
import { asNodeId } from "@shared/model";
import { modelCanvas, type OverseerStores } from "./portfolio";
import { executeOverseerCanvas } from "./canvas";
import { overseerEnvReport, type OverseerEnvReport } from "./env-report-seam";
import { executeOverseerOffboard } from "./offboard";
import { overseerOffboard, type OverseerOffboard } from "./offboard-seam";
import { executeOverseerReferences } from "./references";
import { executeOverseerSecret } from "./secret";
import { overseerSecretStore, type OverseerSecretStore } from "./secret-store-seam";
import { executeOverseerWork } from "./work";

export interface OverseerRuntime {
  readonly native: (
    caller: OverseerCaller,
    request: OverseerRequest,
  ) => Effect.Effect<unknown, WorkErrorBody>;
  /** This machine's secret store. Defaults to the product store. */
  readonly secrets?: () => OverseerSecretStore | undefined;
  /** The region environment resolver's report. Defaults to the product resolver. */
  readonly envReport?: OverseerEnvReport;
  /** The operator's offboard entry point. Defaults to the product one. */
  readonly offboard?: OverseerOffboard;
}

const ENV_DOCTOR_MISSING =
  "the region environment resolver is not available in this build";

/** The resolver's canvas-wide report, narrowed to one node when asked. */
const runEnvDoctor = (
  caller: OverseerCaller,
  args: OverseerArgsFor<"env.doctor">,
  report: OverseerEnvReport,
): Effect.Effect<unknown, WorkErrorBody, OverseerStores> =>
  Effect.gen(function* () {
    const canvasName = args.canvas ?? caller.canvasName;
    const canvas = yield* modelCanvas(canvasName).pipe(
      Effect.mapError((error): WorkErrorBody => ({
        type: "UnknownTarget",
        message: error.message,
      })),
    );
    const nodeId = args.nodeId;
    if (nodeId !== undefined && !canvas.nodes.has(asNodeId(nodeId))) {
      return yield* Effect.fail<WorkErrorBody>({
        type: "UnknownTarget",
        message: `node "${nodeId}" was not found`,
      });
    }
    const whole = yield* Effect.tryPromise({
      try: () => report(canvasName),
      // A resolver failure is reported in fixed words: its own message could
      // quote what a store or a tool printed.
      catch: (): WorkErrorBody => ({
        type: "InternalError",
        message: "the region environment report could not be produced",
      }),
    });
    if (whole === undefined) {
      return yield* Effect.fail<WorkErrorBody>({
        type: "UnknownTarget",
        message: `canvas "${canvasName}" could not be read`,
      });
    }
    return nodeId === undefined ? whole : narrowEnvironmentReport(whole, nodeId);
  });

const errorType = (type: WorkErrorBody["type"]): OverseerErrorType => {
  switch (type) {
    case "ScopeError": case "AuthError": case "ReviewerIsAuthor": return "Forbidden";
    case "UnknownTarget": case "StaleNodeRef": return "NotFound";
    case "InputError": case "ProtocolError": return "InvalidArguments";
    case "ClaimConflict": case "InvalidTransition": return "Conflict";
    case "RuntimeDown": case "Timeout": return "RuntimeDown";
    case "Paused": return "Conflict";
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
/** The families the canvas handlers answer. A screenshot is taken by the window, so it is native. */
const CANVAS_FAMILIES = ["canvas", "node", "wire", "sheet", "env"] as const;
const WORK_FAMILIES = ["tasks", "request", "artifact", "msg", "board", "pad", "content"] as const;

const inFamily = (operation: string, families: ReadonlyArray<string>): boolean =>
  families.some((family) => operation.startsWith(`${family}.`));

/**
 * Which handlers answer an operation once it is admitted: the canvas
 * handlers, the work handlers, or the native adapter for everything else. A
 * family renamed in the catalog and not here falls through to the native
 * adapter, which refuses it; the catalog walk in the tests holds this list to
 * the catalog so that cannot happen unseen.
 */
export const overseerRouteOf = (operation: string): "canvas" | "work" | "native" =>
  operation !== "canvas.screenshot" && inFamily(operation, CANVAS_FAMILIES)
    ? "canvas"
    : inFamily(operation, WORK_FAMILIES)
      ? "work"
      : "native";

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
        `overseer ${request.operation} is disabled in this Junto build`,
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
  const run = Effect.gen(function* () {
    if (sourceInstallationId !== undefined && operation.startsWith("page.")) {
      return failed(request, {
        type: "ScopeError",
        message: "browser pages are controlled on the overseer's own installation",
      });
    }
    if (sourceInstallationId !== undefined && operation.startsWith("secret.")) {
      return failed(request, {
        type: "ScopeError",
        message: "secrets are kept on the overseer's own installation",
      });
    }
    if (operation.startsWith("secret.")) {
      const outcome = executeOverseerSecret(
        { operation, args: decoded.success },
        (runtime.secrets ?? overseerSecretStore)(),
      );
      return outcome.ok
        ? ({ ok: true, operation, data: outcome.data } satisfies OverseerResult)
        : ({ ok: false, operation, error: outcome.error } satisfies OverseerResult);
    }
    if (
      operation === "agent.offboard" ||
      operation === "agent.offboard-status" ||
      operation === "agent.offboard-rules" ||
      operation === "agent.offboard-configure"
    ) {
      const outcome = yield* Effect.promise(() =>
        executeOverseerOffboard(
          caller,
          { operation, args: decoded.success } as Parameters<typeof executeOverseerOffboard>[1],
          runtime.offboard ?? overseerOffboard,
        ),
      );
      return outcome.ok
        ? ({ ok: true, operation, data: outcome.data } satisfies OverseerResult)
        : ({ ok: false, operation, error: outcome.error } satisfies OverseerResult);
    }
    if (operation.startsWith("references.") || operation.startsWith("briefing.")) {
      const outcome = yield* executeOverseerReferences(caller, { operation, args: decoded.success });
      return outcome.ok
        ? ({ ok: true, operation, data: outcome.data } satisfies OverseerResult)
        : ({ ok: false, operation, error: outcome.error } satisfies OverseerResult);
    }
    if (operation === "env.doctor") {
      const report = runtime.envReport ?? overseerEnvReport;
      if (report === undefined) {
        return {
          ok: false,
          operation,
          error: { type: "Unsupported", message: ENV_DOCTOR_MISSING },
        } satisfies OverseerResult;
      }
      const data = yield* runEnvDoctor(
        caller,
        decoded.success as OverseerArgsFor<"env.doctor">,
        report,
      );
      return { ok: true, operation, data } satisfies OverseerResult;
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
    const route = overseerRouteOf(operation);
    const data = yield* route === "canvas"
      ? executeOverseerCanvas(caller, request)
      : route === "work"
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
