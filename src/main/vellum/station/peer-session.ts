import { randomUUID } from "node:crypto";
import {
  Cause,
  Deferred,
  Effect,
  Either,
  Exit,
  Option,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
  type StationApiRequest,
  type StationApiResponse,
} from "@shared/station-api";
import {
  StationControlErrorCode,
  stationControlErr,
  type StationControlEnvelope,
} from "@shared/station-api-envelope";
import {
  STATION_SESSION_PROTOCOL,
  StationSessionRequestFrame,
  StationSessionRequestId,
  StationSessionResponseFrame,
  decideStationSessionCorrelation,
  type StationSessionFrame,
  type StationSessionRequestId as StationSessionRequestIdValue,
} from "@shared/station-session";

export const STATION_PEER_MAX_PENDING_REQUESTS = 64;
export const STATION_PEER_MAX_INBOUND_REQUESTS = 16;

export class StationSessionTransportError extends Schema.TaggedError<StationSessionTransportError>()(
  "StationSessionTransportError",
  {
    reason: Schema.Literal(
      "closed",
      "read-failed",
      "write-failed",
      "malformed-frame",
      "frame-too-large",
      "queue-capacity",
    ),
    message: Schema.String,
  },
) {}

export class StationPeerSessionClosedError extends Schema.TaggedError<StationPeerSessionClosedError>()(
  "StationPeerSessionClosedError",
  {
    peerInstallationId: InstallationId,
    reason: Schema.Literal(
      "local-close",
      "scope-closed",
      "transport-ended",
      "transport-failed",
      "protocol-failed",
      "request-interrupted",
    ),
    message: Schema.String,
  },
) {}

export class StationPeerSessionProtocolError extends Schema.TaggedError<StationPeerSessionProtocolError>()(
  "StationPeerSessionProtocolError",
  {
    peerInstallationId: InstallationId,
    reason: Schema.Literal(
      "outbound-verb-denied",
      "outbound-route-mismatch",
      "inbound-verb-denied",
      "inbound-route-mismatch",
      "duplicate-request-id",
      "unknown-response",
      "response-mismatch",
      "handler-response-mismatch",
    ),
    message: Schema.String,
  },
) {}

export class StationPeerSessionCapacityError extends Schema.TaggedError<StationPeerSessionCapacityError>()(
  "StationPeerSessionCapacityError",
  {
    peerInstallationId: InstallationId,
    limit: Schema.Int,
    message: Schema.String,
  },
) {}

export class StationPeerRejectedError extends Schema.TaggedError<StationPeerRejectedError>()(
  "StationPeerRejectedError",
  {
    peerInstallationId: InstallationId,
    operation: Schema.Literal(
      "pair",
      "configure",
      "project",
      "report",
      "status",
    ),
    code: StationControlErrorCode,
    message: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

export type StationPeerRequestError =
  | StationPeerSessionClosedError
  | StationPeerSessionProtocolError
  | StationPeerSessionCapacityError
  | StationPeerRejectedError;

export type StationApiResponseFor<R extends StationApiRequest> = Extract<
  StationApiResponse,
  { readonly op: R["op"] }
>;

/**
 * A transport presents decoded frames to the session coordinator.
 *
 * NDJSON, SSH, HTTPS, and socket mechanics remain adapter-owned. `send` must
 * be bounded and serialized by the adapter.
 */
export interface StationSessionFrameTransport {
  readonly incoming: Stream.Stream<
    StationSessionFrame,
    StationSessionTransportError
  >;
  readonly send: (
    frame: StationSessionFrame,
  ) => Effect.Effect<void, StationSessionTransportError>;
  readonly close: Effect.Effect<void>;
}

export interface StationPeerSession {
  readonly localInstallationId: InstallationIdValue;
  readonly peerInstallationId: InstallationIdValue;
  readonly request: <R extends StationApiRequest>(
    request: R,
  ) => Effect.Effect<StationApiResponseFor<R>, StationPeerRequestError>;
  readonly isOpen: Effect.Effect<boolean>;
  readonly awaitClosed: Effect.Effect<StationPeerSessionClosedError>;
  readonly close: Effect.Effect<void>;
}

export interface StationPeerSessionOptions {
  readonly localRole: "command-center" | "remote";
  readonly localInstallationId: InstallationIdValue;
  readonly peerInstallationId: InstallationIdValue;
  readonly transport: StationSessionFrameTransport;
  readonly handleRequest: (
    request: StationApiRequest,
  ) => Effect.Effect<StationControlEnvelope>;
  readonly nextRequestId?: Effect.Effect<StationSessionRequestIdValue>;
  readonly maxPendingRequests?: number;
  readonly maxInboundRequests?: number;
}

interface PendingRequest {
  readonly frame: StationSessionRequestFrame;
  readonly response: Deferred.Deferred<
    StationControlEnvelope,
    StationPeerSessionClosedError | StationPeerSessionProtocolError
  >;
}

interface SessionState {
  readonly closed: StationPeerSessionClosedError | undefined;
  readonly pending: ReadonlyMap<StationSessionRequestIdValue, PendingRequest>;
  readonly inbound: ReadonlySet<StationSessionRequestIdValue>;
}

type RegisterPendingDecision =
  | { readonly _tag: "registered" }
  | {
      readonly _tag: "closed";
      readonly error: StationPeerSessionClosedError;
    }
  | { readonly _tag: "capacity" }
  | { readonly _tag: "duplicate" };

const routeMatches = (
  localRole: StationPeerSessionOptions["localRole"],
  local: InstallationIdValue,
  peer: InstallationIdValue,
  request: StationApiRequest,
  direction: "outbound" | "inbound",
): boolean => {
  const sender = direction === "outbound" ? local : peer;
  const target = direction === "outbound" ? peer : local;
  switch (request.op) {
    case "pair":
      return (
        request.commandCenterInstallationId ===
          (localRole === "command-center" ? local : peer) &&
        request.stationInstallationId ===
          (localRole === "command-center" ? peer : local)
      );
    case "configure":
      return (
        request.installationId ===
          (localRole === "command-center" ? peer : local) &&
        request.configuration.commandCenterInstallationId ===
          (localRole === "command-center" ? local : peer)
      );
    case "project":
      return (
        request.stationInstallationId ===
        (localRole === "command-center" ? peer : local)
      );
    case "report":
      return (
        request.senderInstallationId === sender &&
        request.targetInstallationId === target
      );
    case "status":
      return true;
  }
};

const statusResponseMatchesPeer = (
  request: StationApiRequest,
  response: StationApiResponse,
  expectedStatusInstallationId: InstallationIdValue,
): boolean => {
  return request.op !== "status" ||
    (
      response.op === "status" &&
      response.installationId === expectedStatusInstallationId
    );
};

const sessionClosed = (
  peerInstallationId: InstallationIdValue,
  reason: StationPeerSessionClosedError["reason"],
  message: string,
): StationPeerSessionClosedError =>
  StationPeerSessionClosedError.make({
    peerInstallationId,
    reason,
    message,
  });

const protocolFailure = (
  peerInstallationId: InstallationIdValue,
  reason: StationPeerSessionProtocolError["reason"],
  message: string,
): StationPeerSessionProtocolError =>
  StationPeerSessionProtocolError.make({
    peerInstallationId,
    reason,
    message,
  });

const defaultRequestId = Effect.sync(() =>
  Schema.decodeUnknownSync(StationSessionRequestId)(randomUUID()),
);

/**
 * Build one scoped, transport-neutral Station session.
 *
 * Durable replay and cursor state live outside this object. This coordinator
 * owns only ephemeral request correlation, bounded in-flight work, and
 * fail-closed session lifecycle.
 */
export const makeStationPeerSession = (
  options: StationPeerSessionOptions,
): Effect.Effect<StationPeerSession, never, Scope.Scope> =>
  Effect.gen(function* () {
    const maxPendingRequests =
      options.maxPendingRequests ?? STATION_PEER_MAX_PENDING_REQUESTS;
    const maxInboundRequests =
      options.maxInboundRequests ?? STATION_PEER_MAX_INBOUND_REQUESTS;
    const state = yield* Ref.make<SessionState>({
      closed: undefined,
      pending: new Map(),
      inbound: new Set(),
    });
    const closed = yield* Deferred.make<StationPeerSessionClosedError>();
    const inboundPermits = yield* Effect.makeSemaphore(maxInboundRequests);

    const closeWith = (
      error: StationPeerSessionClosedError,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const pending = yield* Ref.modify(state, (current): readonly [
          Option.Option<ReadonlyArray<PendingRequest>>,
          SessionState,
        ] => {
          if (current.closed !== undefined) {
            return [
              Option.none<ReadonlyArray<PendingRequest>>(),
              current,
            ];
          }
          return [
            Option.some([...current.pending.values()]),
            {
              closed: error,
              pending:
                new Map<StationSessionRequestIdValue, PendingRequest>(),
              inbound: new Set<StationSessionRequestIdValue>(),
            },
          ];
        });
        if (Option.isNone(pending)) return;
        yield* Effect.forEach(
          pending.value,
          ({ response }) =>
            Deferred.fail(response, error).pipe(Effect.asVoid),
          { discard: true },
        );
        yield* options.transport.close;
        yield* Deferred.succeed(closed, error).pipe(Effect.asVoid);
      }).pipe(Effect.uninterruptible);

    const failProtocol = (
      error: StationPeerSessionProtocolError,
    ): Effect.Effect<void> =>
      closeWith(
        sessionClosed(
          options.peerInstallationId,
          "protocol-failed",
          error.message,
        ),
      );

    const registerPending = (
      requestId: StationSessionRequestIdValue,
      pending: PendingRequest,
    ): Effect.Effect<RegisterPendingDecision> =>
      Ref.modify(state, (current): readonly [
        RegisterPendingDecision,
        SessionState,
      ] => {
        if (current.closed !== undefined) {
          return [
            { _tag: "closed", error: current.closed } as const,
            current,
          ];
        }
        if (current.pending.size >= maxPendingRequests) {
          return [{ _tag: "capacity" } as const, current];
        }
        if (current.pending.has(requestId)) {
          return [{ _tag: "duplicate" } as const, current];
        }
        const next = new Map(current.pending);
        next.set(requestId, pending);
        return [
          { _tag: "registered" } as const,
          { ...current, pending: next },
        ];
      });

    const removePending = (
      requestId: StationSessionRequestIdValue,
    ): Effect.Effect<void> =>
      Ref.update(state, (current) => {
        if (!current.pending.has(requestId)) return current;
        const next = new Map(current.pending);
        next.delete(requestId);
        return { ...current, pending: next };
      });

    const handleResponse = (
      frame: StationSessionResponseFrame,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const pending = yield* Ref.modify(state, (current) => {
          const found = current.pending.get(frame.requestId);
          if (found === undefined) {
            return [Option.none(), current] as const;
          }
          const next = new Map(current.pending);
          next.delete(frame.requestId);
          return [
            Option.some(found),
            { ...current, pending: next },
          ] as const;
        });
        if (Option.isNone(pending)) {
          const error = protocolFailure(
            options.peerInstallationId,
            "unknown-response",
            "Station peer returned an unknown or duplicate request ID",
          );
          return yield* failProtocol(error);
        }

        const correlation = decideStationSessionCorrelation(
          pending.value.frame,
          frame,
        );
        const statusMatchesPeer =
          !frame.envelope.ok ||
          statusResponseMatchesPeer(
            pending.value.frame.request,
            frame.envelope.response,
            options.peerInstallationId,
          );
        if (
          correlation._tag !== "correlated" ||
          !statusMatchesPeer
        ) {
          const error = protocolFailure(
            options.peerInstallationId,
            "response-mismatch",
            "Station peer response does not exactly match its request",
          );
          yield* Deferred.fail(pending.value.response, error);
          return yield* failProtocol(error);
        }
        yield* Deferred.succeed(pending.value.response, frame.envelope);
      });

    const unregisterInbound = (
      requestId: StationSessionRequestIdValue,
    ): Effect.Effect<void> =>
      Ref.update(state, (current) => {
        if (!current.inbound.has(requestId)) return current;
        const next = new Set(current.inbound);
        next.delete(requestId);
        return { ...current, inbound: next };
      });

    const processInboundRequest = (
      frame: StationSessionRequestFrame,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const envelopeExit = yield* options
          .handleRequest(frame.request)
          .pipe(Effect.exit);
        if (
          Exit.isFailure(envelopeExit) &&
          Cause.isInterruptedOnly(envelopeExit.cause)
        ) {
          return;
        }
        const envelope = Exit.isSuccess(envelopeExit)
          ? envelopeExit.value
          : stationControlErr(
              "internal_error",
              "Station request handler failed",
              false,
            );
        const response = StationSessionResponseFrame.make({
          protocol: STATION_SESSION_PROTOCOL,
          frame: "response",
          requestId: frame.requestId,
          envelope,
        });
        const correlation = decideStationSessionCorrelation(
          frame,
          response,
        );
        const statusMatchesLocal =
          !envelope.ok ||
          statusResponseMatchesPeer(
            frame.request,
            envelope.response,
            options.localInstallationId,
          );
        if (
          correlation._tag !== "correlated" ||
          !statusMatchesLocal
        ) {
          const error = protocolFailure(
            options.peerInstallationId,
            "handler-response-mismatch",
            "Local Station handler returned a response for another request",
          );
          return yield* failProtocol(error);
        }
        const sent = yield* options.transport.send(response).pipe(Effect.either);
        if (Either.isLeft(sent)) {
          yield* closeWith(
            sessionClosed(
              options.peerInstallationId,
              "transport-failed",
              sent.left.message,
            ),
          );
        }
      }).pipe(
        Effect.ensuring(unregisterInbound(frame.requestId)),
        Effect.ensuring(inboundPermits.release(1).pipe(Effect.asVoid)),
      );

    const launchInboundRequest = (
      frame: StationSessionRequestFrame,
    ): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        if (
          options.localRole === "command-center" &&
          frame.request.op !== "report"
        ) {
          const denied = StationSessionResponseFrame.make({
            protocol: STATION_SESSION_PROTOCOL,
            frame: "response",
            requestId: frame.requestId,
            envelope: stationControlErr(
              "authorization_denied",
              "A Remote may initiate only report on the CC-opened session",
              false,
            ),
          });
          yield* options.transport.send(denied).pipe(Effect.ignore);
          return yield* failProtocol(
            protocolFailure(
              options.peerInstallationId,
              "inbound-verb-denied",
              "Remote initiated a forbidden Station operation",
            ),
          );
        }
        if (
          !routeMatches(
            options.localRole,
            options.localInstallationId,
            options.peerInstallationId,
            frame.request,
            "inbound",
          )
        ) {
          return yield* failProtocol(
            protocolFailure(
              options.peerInstallationId,
              "inbound-route-mismatch",
              "Inbound Station request does not match this peer route",
            ),
          );
        }
        const admitted = yield* Ref.modify(state, (current) => {
          if (
            current.closed !== undefined ||
            current.inbound.has(frame.requestId)
          ) {
            return [false, current] as const;
          }
          const next = new Set(current.inbound);
          next.add(frame.requestId);
          return [true, { ...current, inbound: next }] as const;
        });
        if (!admitted) {
          return yield* failProtocol(
            protocolFailure(
              options.peerInstallationId,
              "duplicate-request-id",
              "Station peer reused an active request ID",
            ),
          );
        }
        yield* inboundPermits.take(1);
        yield* Effect.forkScoped(processInboundRequest(frame));
      });

    const reader = Stream.runForEach(
      options.transport.incoming,
      (frame) =>
        frame.frame === "response"
          ? handleResponse(frame)
          : launchInboundRequest(frame),
    ).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          closeWith(
            sessionClosed(
              options.peerInstallationId,
              "transport-failed",
              error.message,
            ),
          ),
        onSuccess: () =>
          closeWith(
            sessionClosed(
              options.peerInstallationId,
              "transport-ended",
              "Station peer transport ended",
            ),
          ),
      }),
    );

    yield* Effect.addFinalizer(() =>
      closeWith(
        sessionClosed(
          options.peerInstallationId,
          "scope-closed",
          "Station peer session scope closed",
        ),
      ),
    );
    yield* Effect.forkScoped(reader);

    const request: StationPeerSession["request"] = <R extends StationApiRequest>(
      outbound: R,
    ): Effect.Effect<StationApiResponseFor<R>, StationPeerRequestError> =>
      Effect.gen(function* () {
        if (
          options.localRole === "remote" &&
          outbound.op !== "report"
        ) {
          return yield* StationPeerSessionProtocolError.make({
            peerInstallationId: options.peerInstallationId,
            reason: "outbound-verb-denied",
            message:
              "A Remote may initiate only report on the CC-opened session",
          });
        }
        if (
          !routeMatches(
            options.localRole,
            options.localInstallationId,
            options.peerInstallationId,
            outbound,
            "outbound",
          )
        ) {
          return yield* StationPeerSessionProtocolError.make({
            peerInstallationId: options.peerInstallationId,
            reason: "outbound-route-mismatch",
            message: "Outbound Station request does not match this peer route",
          });
        }

        const requestId = yield* (
          options.nextRequestId ?? defaultRequestId
        );
        const frame = StationSessionRequestFrame.make({
          protocol: STATION_SESSION_PROTOCOL,
          frame: "request",
          requestId,
          request: outbound,
        });
        const response = yield* Deferred.make<
          StationControlEnvelope,
          StationPeerSessionClosedError | StationPeerSessionProtocolError
        >();
        const registration = yield* registerPending(requestId, {
          frame,
          response,
        });
        switch (registration._tag) {
          case "closed":
            return yield* registration.error;
          case "capacity":
            return yield* StationPeerSessionCapacityError.make({
              peerInstallationId: options.peerInstallationId,
              limit: maxPendingRequests,
              message: "Station session pending request limit reached",
            });
          case "duplicate":
            return yield* StationPeerSessionProtocolError.make({
              peerInstallationId: options.peerInstallationId,
              reason: "duplicate-request-id",
              message: "Station session generated a duplicate request ID",
            });
          case "registered":
            break;
        }

        const sent = yield* options.transport.send(frame).pipe(Effect.either);
        if (Either.isLeft(sent)) {
          const error = sessionClosed(
            options.peerInstallationId,
            "transport-failed",
            sent.left.message,
          );
          yield* closeWith(error);
          return yield* error;
        }

        const envelope = yield* Deferred.await(response).pipe(
          Effect.onInterrupt(() =>
            closeWith(
              sessionClosed(
                options.peerInstallationId,
                "request-interrupted",
                "Station request was interrupted before its response",
              ),
            ),
          ),
          Effect.ensuring(removePending(requestId)),
        );
        if (!envelope.ok) {
          return yield* StationPeerRejectedError.make({
            peerInstallationId: options.peerInstallationId,
            operation: outbound.op,
            code: envelope.error.code,
            message: envelope.error.message,
            retryable: envelope.error.retryable,
          });
        }
        return envelope.response as StationApiResponseFor<R>;
      });

    return {
      localInstallationId: options.localInstallationId,
      peerInstallationId: options.peerInstallationId,
      request,
      isOpen: Deferred.isDone(closed).pipe(Effect.map((done) => !done)),
      awaitClosed: Deferred.await(closed),
      close: closeWith(
        sessionClosed(
          options.peerInstallationId,
          "local-close",
          "Station peer session closed locally",
        ),
      ),
    };
  });
