import {
  Cause,
  Deferred,
  Effect,
  Either,
  Exit,
  Fiber,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
  TestClock,
  TestContext,
} from "effect";
import { describe, expect, it } from "vitest";
import {
  InstallationId,
  PairRequest,
  PairResponse,
  ReportRequest,
  ReportResponse,
  STATION_API_PROTOCOL,
  StatusRequest,
  StatusResponse,
  type StationApiRequest,
} from "../src/shared/station-api";
import {
  stationControlErr,
  stationControlOk,
  type StationControlEnvelope,
} from "../src/shared/station-api-envelope";
import {
  STATION_SESSION_PROTOCOL,
  StationSessionRequestFrame,
  StationSessionRequestId,
  StationSessionResponseFrame,
  type StationSessionFrame,
  type StationSessionRequestFrame as StationSessionRequestFrameValue,
} from "../src/shared/station-session";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  STATION_PROTOCOL_BASELINE,
  StationAppVersion,
  StationStateSchemaVersion,
} from "../src/shared/station-protocol";
import {
  bindNegotiatedStationProtocol,
  makeStationPeerSession,
  type StationPeerSessionOptions,
  type StationSessionFrameTransport,
} from "../src/main/vellum/station/peer-session";

const installationId = (value: string) =>
  Schema.decodeUnknownSync(InstallationId)(value);
const requestId = (value: string) =>
  Schema.decodeUnknownSync(StationSessionRequestId)(value);

const commandCenterInstallationId = installationId("cc-session-test");
const remoteInstallationId = installationId("remote-session-test");
const otherInstallationId = installationId("other-session-test");
const protocolDiagnostics = {
  appVersion: Schema.decodeUnknownSync(StationAppVersion)("test"),
  stateSchemaVersion: Schema.decodeUnknownSync(StationStateSchemaVersion)(1),
  support: CURRENT_STATION_PROTOCOL_SUPPORT,
};
const protocolBinding = bindNegotiatedStationProtocol({
  negotiatedProtocol: STATION_PROTOCOL_BASELINE,
  local: protocolDiagnostics,
  peer: protocolDiagnostics,
});

const statusRequest = StatusRequest.make({
  protocol: STATION_API_PROTOCOL,
  op: "status",
});

const pairRequest = PairRequest.make({
  protocol: STATION_API_PROTOCOL,
  op: "pair",
  commandCenterInstallationId,
  stationInstallationId: remoteInstallationId,
  stationLabel: "Remote session test",
  appVersion: "0.1.0",
});

const statusResponse = (
  respondingInstallationId = remoteInstallationId,
) =>
  StatusResponse.make({
    protocol: STATION_API_PROTOCOL,
    op: "status",
    installationId: respondingInstallationId,
    state: "ready",
    receivedThrough: [],
    peerAcknowledgedThrough: [],
    readiness: {
      database: true,
      workControl: true,
      simulation: true,
      session: true,
    },
    observedAt: "2026-07-27T15:00:00.000Z",
  });

const pairResponse = (
  respondingRemoteInstallationId = remoteInstallationId,
) =>
  PairResponse.make({
    protocol: STATION_API_PROTOCOL,
    op: "pair",
    commandCenterInstallationId,
    stationInstallationId: respondingRemoteInstallationId,
    pairedAt: "2026-07-27T15:00:00.000Z",
  });

const remoteReport = ReportRequest.make({
  protocol: STATION_API_PROTOCOL,
  op: "report",
  senderInstallationId: remoteInstallationId,
  targetInstallationId: commandCenterInstallationId,
  batch: {
    records: [],
    acknowledge: [],
    hasMore: false,
  },
});

const commandCenterReport = ReportResponse.make({
  protocol: STATION_API_PROTOCOL,
  op: "report",
  senderInstallationId: commandCenterInstallationId,
  targetInstallationId: remoteInstallationId,
  batch: {
    records: [],
    acknowledge: [],
    hasMore: false,
  },
});

const makeTransportHarness = Effect.gen(function* () {
  const incoming = yield* Queue.unbounded<StationSessionFrame>();
  const sent = yield* Queue.unbounded<StationSessionFrame>();
  const closeCount = yield* Ref.make(0);

  const transport: StationSessionFrameTransport = {
    incoming: Stream.fromQueue(incoming),
    send: (frame) => Queue.offer(sent, frame).pipe(Effect.asVoid),
    close: Ref.update(closeCount, (count) => count + 1).pipe(
      Effect.zipRight(Queue.shutdown(incoming)),
    ),
  };

  return {
    transport,
    offer: (frame: StationSessionFrame) =>
      Queue.offer(incoming, frame).pipe(Effect.asVoid),
    takeSent: Queue.take(sent),
    sentSize: Queue.size(sent),
    end: Queue.shutdown(incoming),
    closeCount: Ref.get(closeCount),
  };
});

const makeRequestIdSource = Effect.gen(function* () {
  const counter = yield* Ref.make(0);
  return Ref.getAndUpdate(counter, (value) => value + 1).pipe(
    Effect.map((value) => requestId(`peer-request-${value}`)),
  );
});

const defaultHandler = (_request: StationApiRequest) =>
  Effect.succeed(
    stationControlErr(
      "request_rejected",
      "No inbound request was expected",
      false,
    ),
  );

const makeSession = (
  transport: StationSessionFrameTransport,
  overrides: Partial<StationPeerSessionOptions> = {},
) =>
  Effect.gen(function* () {
    const nextRequestId = yield* makeRequestIdSource;
    return yield* makeStationPeerSession({
      localRole: "command-center",
      localInstallationId: commandCenterInstallationId,
      peerInstallationId: remoteInstallationId,
      transport,
      handleRequest: defaultHandler,
      nextRequestId,
      ...overrides,
      protocol: overrides.protocol ?? protocolBinding,
    });
  });

const asRequestFrame = (
  frame: StationSessionFrame,
): StationSessionRequestFrameValue => {
  expect(frame.frame).toBe("request");
  if (frame.frame !== "request") {
    throw new TypeError("Expected a Station request frame");
  }
  return frame;
};

const responseFrame = (
  request: StationSessionRequestFrameValue,
  envelope: StationControlEnvelope,
) =>
  StationSessionResponseFrame.make({
    protocol: STATION_SESSION_PROTOCOL,
    frame: "response",
    requestId: request.requestId,
    envelope,
  });

const failureFrom = <A, E>(exit: Exit.Exit<A, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) {
    throw new TypeError("Expected Effect failure");
  }
  const failure = Cause.failureOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (Option.isNone(failure)) {
    throw new TypeError("Expected a typed Effect failure");
  }
  return failure.value;
};

describe("persistent Station peer session", () => {
  it("retains one immutable protocol binding for its whole lifetime", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeTransportHarness;
          const session = yield* makeSession(harness.transport);

          expect(session.protocol).toMatchObject({
            _tag: "negotiated",
            negotiatedProtocol: STATION_PROTOCOL_BASELINE,
            compatibility: "compatible",
          });
          expect(Object.isFrozen(session.protocol)).toBe(true);
          expect(Object.isFrozen(session.protocol.local)).toBe(true);
          expect(Object.isFrozen(session.protocol.local.support)).toBe(true);
        }),
      ),
    );
  });

  it("correlates concurrent requests when replies arrive out of order", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeTransportHarness;
          const session = yield* makeSession(harness.transport);

          const pairFiber = yield* session.request(pairRequest).pipe(
            Effect.forkScoped,
          );
          const statusFiber = yield* session.request(statusRequest).pipe(
            Effect.forkScoped,
          );

          const first = asRequestFrame(yield* harness.takeSent);
          const second = asRequestFrame(yield* harness.takeSent);
          const pairFrame = [first, second].find(
            (frame) => frame.request.op === "pair",
          );
          const statusFrame = [first, second].find(
            (frame) => frame.request.op === "status",
          );
          expect(pairFrame).toBeDefined();
          expect(statusFrame).toBeDefined();
          if (pairFrame === undefined || statusFrame === undefined) {
            throw new TypeError("Expected one pair and one status request");
          }

          yield* harness.offer(
            responseFrame(
              statusFrame,
              stationControlOk(statusResponse()),
            ),
          );
          yield* harness.offer(
            responseFrame(pairFrame, stationControlOk(pairResponse())),
          );

          const status = yield* Fiber.join(statusFiber);
          const paired = yield* Fiber.join(pairFiber);
          expect(status.installationId).toBe(remoteInstallationId);
          expect(paired.stationInstallationId).toBe(remoteInstallationId);
          expect(yield* session.isOpen).toBe(true);
        }),
      ),
    );
  });

  it("closes on a same-operation response for a different request identity", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeTransportHarness;
          const session = yield* makeSession(harness.transport);
          const resultFiber = yield* session.request(pairRequest).pipe(
            Effect.exit,
            Effect.forkScoped,
          );
          const request = asRequestFrame(yield* harness.takeSent);

          yield* harness.offer(
            responseFrame(
              request,
              stationControlOk(pairResponse(otherInstallationId)),
            ),
          );

          const failure = failureFrom(yield* Fiber.join(resultFiber));
          expect(failure).toMatchObject({
            _tag: "StationPeerSessionProtocolError",
            reason: "response-mismatch",
          });
          expect(yield* session.awaitClosed).toMatchObject({
            reason: "protocol-failed",
          });
        }),
      ),
    );
  });

  it("binds a status response to the admitted peer identity", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeTransportHarness;
          const session = yield* makeSession(harness.transport);
          const resultFiber = yield* session.request(statusRequest).pipe(
            Effect.exit,
            Effect.forkScoped,
          );
          const request = asRequestFrame(yield* harness.takeSent);

          yield* harness.offer(
            responseFrame(
              request,
              stationControlOk(statusResponse(otherInstallationId)),
            ),
          );

          const failure = failureFrom(yield* Fiber.join(resultFiber));
          expect(failure).toMatchObject({
            _tag: "StationPeerSessionProtocolError",
            reason: "response-mismatch",
          });
          expect(yield* session.awaitClosed).toMatchObject({
            reason: "protocol-failed",
          });
        }),
      ),
    );
  });

  it("treats an unknown response ID as a fatal protocol error", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeTransportHarness;
          const session = yield* makeSession(harness.transport);

          yield* harness.offer(
            StationSessionResponseFrame.make({
              protocol: STATION_SESSION_PROTOCOL,
              frame: "response",
              requestId: requestId("never-requested"),
              envelope: stationControlOk(statusResponse()),
            }),
          );

          expect(yield* session.awaitClosed).toMatchObject({
            reason: "protocol-failed",
          });
          expect(yield* harness.closeCount).toBe(1);
        }),
      ),
    );
  });

  it("treats a duplicate response as a fatal protocol error", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeTransportHarness;
          const session = yield* makeSession(harness.transport);
          const resultFiber = yield* session.request(statusRequest).pipe(
            Effect.forkScoped,
          );
          const request = asRequestFrame(yield* harness.takeSent);
          const response = responseFrame(
            request,
            stationControlOk(statusResponse()),
          );

          yield* harness.offer(response);
          expect((yield* Fiber.join(resultFiber)).installationId).toBe(
            remoteInstallationId,
          );
          yield* harness.offer(response);

          expect(yield* session.awaitClosed).toMatchObject({
            reason: "protocol-failed",
          });
        }),
      ),
    );
  });

  it("admits Remote-initiated reports on a Command Center session", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeTransportHarness;
          const handled = yield* Ref.make<ReadonlyArray<StationApiRequest>>(
            [],
          );
          const session = yield* makeSession(harness.transport, {
            handleRequest: (request) =>
              Ref.update(handled, (requests) => [...requests, request]).pipe(
                Effect.as(stationControlOk(commandCenterReport)),
              ),
          });
          const inbound = StationSessionRequestFrame.make({
            protocol: STATION_SESSION_PROTOCOL,
            frame: "request",
            requestId: requestId("remote-report"),
            request: remoteReport,
          });

          yield* harness.offer(inbound);
          const sent = yield* harness.takeSent;

          expect(sent).toMatchObject({
            frame: "response",
            requestId: inbound.requestId,
            envelope: {
              ok: true,
              response: {
                op: "report",
                senderInstallationId: commandCenterInstallationId,
                targetInstallationId: remoteInstallationId,
              },
            },
          });
          expect(yield* handled).toEqual([remoteReport]);
          expect(yield* session.isOpen).toBe(true);
        }),
      ),
    );
  });

  it("denies every other Remote-initiated verb and never calls the handler", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeTransportHarness;
          const handled = yield* Ref.make(0);
          const session = yield* makeSession(harness.transport, {
            handleRequest: (_request) =>
              Ref.update(handled, (count) => count + 1).pipe(
                Effect.as(stationControlOk(statusResponse())),
              ),
          });
          const inbound = StationSessionRequestFrame.make({
            protocol: STATION_SESSION_PROTOCOL,
            frame: "request",
            requestId: requestId("remote-status"),
            request: statusRequest,
          });

          yield* harness.offer(inbound);
          const denied = yield* harness.takeSent;

          expect(denied).toMatchObject({
            frame: "response",
            requestId: inbound.requestId,
            envelope: {
              ok: false,
              error: { code: "authorization_denied" },
            },
          });
          expect(yield* session.awaitClosed).toMatchObject({
            reason: "protocol-failed",
          });
          expect(yield* handled).toBe(0);
        }),
      ),
    );
  });

  it("fails every pending request when the transport ends", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeTransportHarness;
          const session = yield* makeSession(harness.transport);
          const pending = yield* session.request(statusRequest).pipe(
            Effect.exit,
            Effect.forkScoped,
          );
          yield* harness.takeSent;

          yield* harness.end;

          const failure = failureFrom(yield* Fiber.join(pending));
          expect(failure).toMatchObject({
            _tag: "StationPeerSessionClosedError",
            reason: "transport-ended",
          });
          expect(yield* session.awaitClosed).toMatchObject({
            reason: "transport-ended",
          });
        }),
      ),
    );
  });

  it("closes the whole session when one request reaches its deadline", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeTransportHarness;
          const session = yield* makeSession(harness.transport, {
            requestTimeoutMs: 1_000,
          });
          const first = yield* session.request(statusRequest).pipe(
            Effect.exit,
            Effect.forkScoped,
          );
          yield* harness.takeSent;

          yield* TestClock.adjust(500);

          const second = yield* session.request(statusRequest).pipe(
            Effect.exit,
            Effect.forkScoped,
          );
          yield* harness.takeSent;

          yield* TestClock.adjust(500);

          const firstFailure = failureFrom(yield* Fiber.join(first));
          const secondFailure = failureFrom(yield* Fiber.join(second));
          expect(firstFailure).toMatchObject({
            _tag: "StationPeerSessionClosedError",
            reason: "request-timeout",
          });
          expect(secondFailure).toMatchObject({
            _tag: "StationPeerSessionClosedError",
            reason: "request-timeout",
          });
          expect(yield* session.awaitClosed).toMatchObject({
            reason: "request-timeout",
          });
          expect(yield* session.isOpen).toBe(false);
          expect(yield* harness.closeCount).toBe(1);
        }),
      ).pipe(Effect.provide(TestContext.TestContext)),
    );
  });

  it("interrupts and joins an in-flight inbound handler before close returns", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeTransportHarness;
          const handlerStarted = yield* Deferred.make<void>();
          const handlerBlock = yield* Deferred.make<void>();
          const finalizerStarted = yield* Deferred.make<void>();
          const releaseFinalizer = yield* Deferred.make<void>();
          const finalized = yield* Deferred.make<void>();
          const continuationCount = yield* Ref.make(0);
          const session = yield* makeSession(harness.transport, {
            handleRequest: (_request) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(
                  handlerStarted,
                  undefined,
                ).pipe(Effect.asVoid);
                yield* Deferred.await(handlerBlock);
                yield* Ref.update(
                  continuationCount,
                  (count) => count + 1,
                );
                return stationControlOk(commandCenterReport);
              }).pipe(
                Effect.ensuring(
                  Deferred.succeed(finalizerStarted, undefined).pipe(
                    Effect.asVoid,
                    Effect.zipRight(Deferred.await(releaseFinalizer)),
                    Effect.zipRight(
                      Deferred.succeed(finalized, undefined).pipe(
                        Effect.asVoid,
                      ),
                    ),
                  ),
                ),
              ),
          });
          const inbound = StationSessionRequestFrame.make({
            protocol: STATION_SESSION_PROTOCOL,
            frame: "request",
            requestId: requestId("close-inbound-handler"),
            request: remoteReport,
          });

          yield* harness.offer(inbound);
          yield* Deferred.await(handlerStarted);

          const closing = yield* session.close.pipe(Effect.forkScoped);
          yield* Deferred.await(finalizerStarted);
          expect(Option.isNone(yield* Fiber.poll(closing))).toBe(true);
          expect(yield* continuationCount).toBe(0);

          yield* Deferred.succeed(releaseFinalizer, undefined);
          yield* Fiber.join(closing);

          yield* Deferred.await(finalized);
          expect(yield* continuationCount).toBe(0);
          expect(yield* harness.sentSize).toBe(0);
          expect(yield* session.isOpen).toBe(false);
          expect(yield* session.awaitClosed).toMatchObject({
            reason: "local-close",
          });
        }),
      ),
    );
  });

  it("bounds outbound pending requests before sending another frame", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeTransportHarness;
          const session = yield* makeSession(harness.transport, {
            maxPendingRequests: 1,
          });
          const firstFiber = yield* session.request(statusRequest).pipe(
            Effect.forkScoped,
          );
          const first = asRequestFrame(yield* harness.takeSent);

          const second = yield* session.request(statusRequest).pipe(
            Effect.either,
          );
          expect(Either.isLeft(second)).toBe(true);
          if (Either.isLeft(second)) {
            expect(second.left).toMatchObject({
              _tag: "StationPeerSessionCapacityError",
              limit: 1,
            });
          }
          expect(yield* harness.sentSize).toBe(0);

          yield* harness.offer(
            responseFrame(first, stationControlOk(statusResponse())),
          );
          expect((yield* Fiber.join(firstFiber)).installationId).toBe(
            remoteInstallationId,
          );
        }),
      ),
    );
  });

  it("linearizes guarded commits with logical session close", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeTransportHarness;
          const session = yield* makeSession(harness.transport);
          const guardedStarted = yield* Deferred.make<void>();
          const releaseGuarded = yield* Deferred.make<void>();

          const guarded = yield* session.withOpen(
            Effect.gen(function* () {
              yield* Deferred.succeed(guardedStarted, undefined);
              yield* Deferred.await(releaseGuarded);
              return "committed" as const;
            }),
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(guardedStarted);

          const closing = yield* session.close.pipe(Effect.forkScoped);
          yield* Effect.yieldNow();

          expect(Option.isNone(yield* Fiber.poll(closing))).toBe(true);
          expect(yield* session.isOpen).toBe(true);

          yield* Deferred.succeed(releaseGuarded, undefined);
          expect(yield* Fiber.join(guarded)).toBe("committed");
          yield* Fiber.join(closing);

          expect(yield* session.isOpen).toBe(false);
          const afterClose = yield* session.withOpen(
            Effect.succeed("must-not-run"),
          ).pipe(Effect.either);
          expect(Either.isLeft(afterClose)).toBe(true);
          if (Either.isLeft(afterClose)) {
            expect(afterClose.left).toMatchObject({
              _tag: "StationPeerSessionClosedError",
              reason: "local-close",
            });
          }
        }),
      ),
    );
  });

  it("allows a Remote to initiate only report requests", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeTransportHarness;
          const session = yield* makeSession(harness.transport, {
            localRole: "remote",
            localInstallationId: remoteInstallationId,
            peerInstallationId: commandCenterInstallationId,
          });

          const denied = yield* session.request(statusRequest).pipe(
            Effect.either,
          );
          expect(Either.isLeft(denied)).toBe(true);
          if (Either.isLeft(denied)) {
            expect(denied.left).toMatchObject({
              _tag: "StationPeerSessionProtocolError",
              reason: "outbound-verb-denied",
            });
          }
          expect(yield* harness.sentSize).toBe(0);

          const reportFiber = yield* session.request(remoteReport).pipe(
            Effect.forkScoped,
          );
          const report = asRequestFrame(yield* harness.takeSent);
          yield* harness.offer(
            responseFrame(
              report,
              stationControlOk(commandCenterReport),
            ),
          );
          const response = yield* Fiber.join(reportFiber);
          expect(response).toMatchObject({
            senderInstallationId: commandCenterInstallationId,
            targetInstallationId: remoteInstallationId,
          });
        }),
      ),
    );
  });
});
