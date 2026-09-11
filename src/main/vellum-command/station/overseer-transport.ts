import { Effect, Result, Schema } from "effect";
import type {
  OverseerCaller,
  OverseerRequest,
  OverseerResult,
} from "@shared/overseer-control";
import {
  STATION_API_PROTOCOL,
  StationOverseerRequest,
  type InstallationId as InstallationIdValue,
} from "@shared/station-api";
import {
  StationControlReportError,
  type StationControlServer,
} from "./control-server";
import type { StationRemoteOverseerHandler } from "./peer-exchange";

let registeredHandler: StationRemoteOverseerHandler | undefined;

/**
 * Install the one main-owned Remote overseer authority callback.
 *
 * Runtime composition owns registration and disposal. Station has no import
 * of the canvas/work dispatcher, avoiding a service cycle. Duplicate
 * registration fails rather than silently changing authority under live
 * sessions.
 */
export const registerStationRemoteOverseerHandler = (
  handler: StationRemoteOverseerHandler,
): (() => void) => {
  if (registeredHandler !== undefined) {
    throw new Error("Remote Station overseer handler is already registered");
  }
  registeredHandler = handler;
  return () => {
    if (registeredHandler === handler) registeredHandler = undefined;
  };
};

/** Fail-closed bridge passed into each CC-opened live peer session. */
export const dispatchRegisteredStationRemoteOverseer: StationRemoteOverseerHandler =
  (request, source) => {
    const handler = registeredHandler;
    if (handler !== undefined) {
      return Effect.suspend(() => handler(request, source));
    }
    return Effect.succeed({
      ok: false,
      operation: request.operation,
      error: {
        type: "Forbidden",
        message: "Remote overseer authority is not available",
      },
    } satisfies OverseerResult);
  };

export type StationRemoteOverseerDispatchFailure =
  | "invalid-request"
  | "unavailable"
  | "capacity-exceeded"
  | "rejected"
  | "uncertain-completion";

/**
 * A transport failure after enqueue cannot prove whether Command Center
 * applied a mutation. Callers must surface this error and must not replay the
 * operation automatically.
 */
export class StationRemoteOverseerDispatchError extends Error {
  readonly name = "StationRemoteOverseerDispatchError";

  constructor(
    readonly failure: StationRemoteOverseerDispatchFailure,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

export interface RemoteStationOverseerDispatcher {
  readonly dispatch: (
    request: OverseerRequest,
    processDerivedCaller: OverseerCaller,
  ) => Promise<OverseerResult>;
}

export interface RemoteStationOverseerDispatcherOptions {
  readonly control: Pick<StationControlServer, "overseer" | "sessionReady">;
  readonly remoteInstallationId: InstallationIdValue;
  readonly commandCenterInstallationId: InstallationIdValue;
}

const strictDecodeStationOverseerRequest = Schema.decodeUnknownResult(
  StationOverseerRequest,
  { onExcessProperty: "error" },
);

const dispatchFailure = (
  failure: StationRemoteOverseerDispatchFailure,
  message: string,
  cause?: unknown,
): StationRemoteOverseerDispatchError =>
  new StationRemoteOverseerDispatchError(failure, message, cause);

/**
 * Production Remote adapter for process-bound local overseer commands.
 *
 * It uses only the existing CC-owned duplex Station connection. It never
 * dials Command Center, retries a mutation, or treats caller node identity as
 * authority.
 */
export const makeRemoteStationOverseerDispatcher = (
  options: RemoteStationOverseerDispatcherOptions,
): RemoteStationOverseerDispatcher => ({
  dispatch: async (request, processDerivedCaller) => {
    const decoded = strictDecodeStationOverseerRequest({
      protocol: STATION_API_PROTOCOL,
      op: "overseer",
      senderInstallationId: options.remoteInstallationId,
      targetInstallationId: options.commandCenterInstallationId,
      caller: processDerivedCaller,
      request,
    });
    if (Result.isFailure(decoded)) {
      throw dispatchFailure(
        "invalid-request",
        "Remote overseer request or process-derived caller is invalid",
      );
    }
    if (!options.control.sessionReady()) {
      throw dispatchFailure(
        "unavailable",
        "Command Center has no active Station session",
      );
    }
    try {
      const response = await options.control.overseer(decoded.success);
      return response.result;
    } catch (cause) {
      if (cause instanceof StationControlReportError) {
        switch (cause.failure) {
          case "invalid-local-request":
            throw dispatchFailure("invalid-request", cause.message, cause);
          case "capacity-exceeded":
            throw dispatchFailure("capacity-exceeded", cause.message, cause);
          case "remote-rejected":
            throw dispatchFailure("rejected", cause.message, cause);
          case "session-unavailable":
          case "local-handoff-lost":
          case "request-timeout":
          case "protocol-error":
            throw dispatchFailure(
              "uncertain-completion",
              "Remote overseer command completion is uncertain; do not retry automatically",
              cause,
            );
        }
      }
      throw dispatchFailure(
        "uncertain-completion",
        "Remote overseer command completion is uncertain; do not retry automatically",
        cause,
      );
    }
  },
});
