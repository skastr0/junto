import { randomUUID } from "node:crypto";
import { Cause,
  Deferred,
  Effect,
  Result,
  Equal,
  Exit,
  Fiber,
  Option,
  Ref,
  Schema,
  Scope,
  Stream, Semaphore } from "effect";
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
import {
  STATION_PROTOCOL_BASELINE,
  selectStationProtocolCodec,
  type StationAppVersion,
  type StationProtocolSupport,
  type StationProtocolVersion,
  type StationStateSchemaVersion,
} from "@shared/station-protocol";

export const STATION_PEER_MAX_PENDING_REQUESTS = 64;
export const STATION_PEER_MAX_INBOUND_REQUESTS = 16;
export const STATION_PEER_REQUEST_TIMEOUT_MS = 30_000;

export class StationSessionTransportError extends Schema.TaggedErrorClass<StationSessionTransportError>()(
  "StationSessionTransportError",
  {
    reason: Schema.Literals(["closed", "read-failed",
    "write-failed",
    "malformed-frame",
    "frame-too-large",
    "queue-capacity",]),
    message: Schema.String,
  },
) {}

export class StationPeerSessionClosedError extends Schema.TaggedErrorClass<StationPeerSessionClosedError>()(
  "StationPeerSessionClosedError",
  {
    peerInstallationId: InstallationId,
    reason: Schema.Literals(["local-close", "scope-closed",
    "transport-ended",
    "transport-failed",
    "protocol-failed",
    "request-interrupted",
    "request-timeout",]),
    message: Schema.String,
  },
) {}

export class StationPeerSessionProtocolError extends Schema.TaggedErrorClass<StationPeerSessionProtocolError>()(
  "StationPeerSessionProtocolError",
  {
    peerInstallationId: InstallationId,
    reason: Schema.Literals(["outbound-verb-denied", "outbound-route-mismatch",
    "inbound-verb-denied",
    "inbound-route-mismatch",
    "duplicate-request-id",
    "unknown-response",
    "response-mismatch",
    "handler-response-mismatch",]),
    message: Schema.String,
  },
) {}

export class StationPeerSessionCapacityError extends Schema.TaggedErrorClass<StationPeerSessionCapacityError>()(
  "StationPeerSessionCapacityError",
  {
    peerInstallationId: InstallationId,
    limit: Schema.Number.pipe(Schema.check(Schema.isInt())),
    message: Schema.String,
  },
) {}

export class StationPeerRejectedError extends Schema.TaggedErrorClass<StationPeerRejectedError>()(
  "StationPeerRejectedError",
  {
    peerInstallationId: InstallationId,
    operation: Schema.Literals(["pair", "configure",
    "project",
    "report",
    "status",]),
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

export interface StationPeerProtocolDiagnostics {
  readonly appVersion: StationAppVersion;
  readonly stateSchemaVersion: StationStateSchemaVersion;
  readonly support: StationProtocolSupport;
}

export type StationPeerProtocolBinding = {
  readonly _tag: "negotiated";
  readonly negotiatedProtocol: typeof STATION_PROTOCOL_BASELINE;
  readonly compatibility: "compatible" | "deprecated";
  readonly local: StationPeerProtocolDiagnostics;
  readonly peer: StationPeerProtocolDiagnostics;
};

const freezeProtocolDiagnostics = (
  diagnostics: StationPeerProtocolDiagnostics,
): StationPeerProtocolDiagnostics =>
  Object.freeze({
    appVersion: diagnostics.appVersion,
    stateSchemaVersion: diagnostics.stateSchemaVersion,
    support: Object.freeze({ ...diagnostics.support }),
  });

/**
 * Bind a successful preface decision to the one exact session codec it
 * selected. Protocol 4 is currently the only compiled codec.
 */
export const bindNegotiatedStationProtocol = (input: {
  readonly negotiatedProtocol: StationProtocolVersion;
  readonly local: StationPeerProtocolDiagnostics;
  readonly peer: StationPeerProtocolDiagnostics;
}): StationPeerProtocolBinding => {
  const selected = selectStationProtocolCodec(input.negotiatedProtocol);
  if (Result.isFailure(selected)) {
    throw new TypeError(
      `Station protocol ${input.negotiatedProtocol} has no compiled codec`,
    );
  }
  const compatibility =
    selected.success < input.local.support.warnBelow ||
      selected.success < input.peer.support.warnBelow
      ? "deprecated"
      : "compatible";
  return Object.freeze({
    _tag: "negotiated",
    negotiatedProtocol: selected.success,
    compatibility,
    local: freezeProtocolDiagnostics(input.local),
    peer: freezeProtocolDiagnostics(input.peer),
  });
};

export interface StationPeerSession {
  readonly localInstallationId: InstallationIdValue;
  readonly peerInstallationId: InstallationIdValue;
  readonly protocol: StationPeerProtocolBinding;
  readonly request: <R extends StationApiRequest>(
    request: R,
  ) => Effect.Effect<StationApiResponseFor<R>, StationPeerRequestError>;
  /**
   * Run a commit-bound operation only while this session is logically open.
   *
   * Session closure and the guarded effect share one lifecycle gate. Whichever
   * acquires it first establishes the durable ordering: either the effect
   * completes before close is published, or it never starts.
   */
  readonly withOpen: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StationPeerSessionClosedError, R>;
  readonly isOpen: Effect.Effect<boolean>;
  readonly awaitClosed: Effect.Effect<StationPeerSessionClosedError>;
  readonly close: Effect.Effect<void>;
}

export interface StationPeerSessionOptions {
  readonly localRole: "command-center" | "remote";
  readonly localInstallationId: InstallationIdValue;
  readonly peerInstallationId: InstallationIdValue;
  readonly protocol: StationPeerProtocolBinding;
  readonly transport: StationSessionFrameTransport;
  readonly handleRequest: (
    request: StationApiRequest,
  ) => Effect.Effect<StationControlEnvelope>;
  readonly nextRequestId?: Effect.Effect<StationSessionRequestIdValue>;
  readonly maxPendingRequests?: number;
  readonly maxInboundRequests?: number;
  readonly requestTimeoutMs?: number;
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
  readonly inboundFibers: ReadonlySet<Fiber.RuntimeFiber<void, never>>;
}

interface SessionCloseTargets {
  readonly pending: ReadonlyArray<PendingRequest>;
  readonly inboundFibers: ReadonlyArray<Fiber.RuntimeFiber<void, never>>;
}

type RegisterPendingDecision =
  | { readonly _tag: "registered" }
  | {
      readonly _tag: "closed";
      readonly error: StationPeerSessionClosedError;
    }
  | { readonly _tag: "capacity" }
  | { readonly _tag: "duplicate" };

type AdmitInboundDecision =
  | { readonly _tag: "admitted" }
  | { readonly _tag: "closed" }
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
    const protocol = bindNegotiatedStationProtocol({
      negotiatedProtocol: options.protocol.negotiatedProtocol,
      local: options.protocol.local,
      peer: options.protocol.peer,
    });
    const maxPendingRequests =
      options.maxPendingRequests ?? STATION_PEER_MAX_PENDING_REQUESTS;
    const maxInboundRequests =
      options.maxInboundRequests ?? STATION_PEER_MAX_INBOUND_REQUESTS;
    const requestTimeoutMs =
      options.requestTimeoutMs ?? STATION_PEER_REQUEST_TIMEOUT_MS;
    const state = yield* Ref.make<SessionState>({
      closed: undefined,
      pending: new Map(),
      inbound: new Set(),
      inboundFibers: new Set(),
    });
    const closed = yield* Deferred.make<StationPeerSessionClosedError>();
    const inboundPermits = yield* Semaphore.make(maxInboundRequests);
    const lifecycle = yield* Semaphore.make(1);

    const closeWith = (
      error: StationPeerSessionClosedError,
    ): Effect.Effect<void> =>
      lifecycle.withPermits(1)(
        Effect.gen(function* () {
          const closingFiberId = yield* Effect.fiberId;
          const pending = yield* Ref.modify(state, (current): readonly [
            Option.Option<SessionCloseTargets>,
            SessionState,
          ] => {
            if (current.closed !== undefined) {
              return [
                Option.none<SessionCloseTargets>(),
                current,
              ];
            }
            return [
              Option.some({
                pending: [...current.pending.values()],
                inboundFibers: [...current.inboundFibers],
              }),
              {
                closed: error,
                pending:
                  new Map<StationSessionRequestIdValue, PendingRequest>(),
                inbound: new Set<StationSessionRequestIdValue>(),
                inboundFibers:
                  new Set<Fiber.RuntimeFiber<void, never>>(),
              },
            ];
          });
          if (Option.isNone(pending)) return;
          yield* Effect.forEach(
            pending.value.pending,
            ({ response }) =>
              Deferred.fail(response, error).pipe(Effect.asVoid),
            { discard: true },
          );
          yield* Fiber.interruptAll(
            pending.value.inboundFibers.filter(
              (fiber) =>
                !Equal.equals(Fiber.id(fiber), closingFiberId),
            ),
          );
          yield* options.transport.close;
          yield* Deferred.succeed(closed, error).pipe(Effect.asVoid);
        }),
      ).pipe(Effect.uninterruptible);

    const withOpen: StationPeerSession["withOpen"] = (effect) =>
      lifecycle.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.closed !== undefined) {
            return yield* current.closed;
          }
          return yield* effect;
        }),
      );

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

    const unregisterInboundFiber = (
      fiber: Fiber.RuntimeFiber<void, never>,
    ): Effect.Effect<void> =>
      Ref.update(state, (current) => {
        if (!current.inboundFibers.has(fiber)) return current;
        const next = new Set(current.inboundFibers);
        next.delete(fiber);
        return { ...current, inboundFibers: next };
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
        const sent = yield* options.transport.send(response).pipe(Effect.result);
        if (Result.isFailure(sent)) {
          yield* closeWith(
            sessionClosed(
              options.peerInstallationId,
              "transport-failed",
              sent.failure.message,
            ),
          );
        }
      });

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
        yield* inboundPermits.take(1);
        const admitted = yield* Ref.modify(state, (current): readonly [
          AdmitInboundDecision,
          SessionState,
        ] => {
          if (current.closed !== undefined) {
            return [{ _tag: "closed" }, current];
          }
          if (current.inbound.has(frame.requestId)) {
            return [{ _tag: "duplicate" }, current];
          }
          const next = new Set(current.inbound);
          next.add(frame.requestId);
          return [
            { _tag: "admitted" },
            { ...current, inbound: next },
          ];
        });
        if (admitted._tag === "closed") {
          yield* inboundPermits.release(1);
          return;
        }
        if (admitted._tag === "duplicate") {
          yield* inboundPermits.release(1);
          return yield* failProtocol(
            protocolFailure(
              options.peerInstallationId,
              "duplicate-request-id",
              "Station peer reused an active request ID",
            ),
          );
        }
        const start = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkScoped(
          Deferred.await(start).pipe(
            Effect.zipRight(processInboundRequest(frame)),
            Effect.ensuring(unregisterInbound(frame.requestId)),
            Effect.ensuring(
              inboundPermits.release(1).pipe(Effect.asVoid),
            ),
          ),
        );
        const registered = yield* Ref.modify(state, (current) => {
          if (current.closed !== undefined) {
            return [false, current] as const;
          }
          const next = new Set(current.inboundFibers);
          next.add(fiber);
          return [
            true,
            { ...current, inboundFibers: next },
          ] as const;
        });
        if (!registered) {
          yield* Fiber.interrupt(fiber);
          return;
        }
        yield* Effect.forkScoped(
          Fiber.await(fiber).pipe(
            Effect.zipRight(unregisterInboundFiber(fiber)),
          ),
        );
        yield* Deferred.succeed(start, undefined);
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

        const timeout = sessionClosed(
          options.peerInstallationId,
          "request-timeout",
          `Station request exceeded its ${requestTimeoutMs}ms deadline`,
        );
        const envelope = yield* Effect.gen(function* () {
          const sent = yield* options.transport
            .send(frame)
            .pipe(Effect.result);
          if (Result.isFailure(sent)) {
            const error = sessionClosed(
              options.peerInstallationId,
              "transport-failed",
              sent.failure.message,
            );
            yield* closeWith(error);
            return yield* error;
          }
          return yield* Deferred.await(response);
        }).pipe(
          Effect.timeoutFail({
            duration: requestTimeoutMs,
            onTimeout: () => timeout,
          }),
          Effect.tapError((error) =>
            error instanceof StationPeerSessionClosedError &&
              error.reason === "request-timeout"
              ? closeWith(error)
              : Effect.void
          ),
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
      protocol,
      request,
      withOpen,
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
