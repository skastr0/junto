import {
  Deferred,
  Effect,
  Either,
  Fiber,
  Queue,
  Schema,
  Stream,
} from "effect";
import { describe, expect, it } from "vitest";
import {
  InstallationId,
  ReportRequest,
  ReportResponse,
  STATION_API_PROTOCOL,
  StatusRequest,
  StatusResponse,
} from "../src/shared/station-api";
import {
  stationControlErr,
  stationControlOk,
} from "../src/shared/station-api-envelope";
import {
  STATION_SESSION_PROTOCOL,
  StationSessionRequestFrame,
  StationSessionRequestId,
  StationSessionResponseFrame,
  stationSessionResponse,
  type StationSessionFrame,
} from "../src/shared/station-session";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  STATION_PROTOCOL_BASELINE,
  STATION_PROTOCOL_PREFACE,
  StationAppVersion,
  StationProtocolAccept,
  StationProtocolReject,
  StationStateSchemaVersion,
  type StationProtocolOffer,
} from "../src/shared/station-protocol";
import {
  SshEndpoint,
  SshIoError,
} from "../src/main/vellum/ssh/domain";
import {
  resolveRemotePackagedPlatform,
} from "../src/main/vellum/ssh/read-commands";
import type {
  ConfirmSshReady,
  SshLease,
  SshTransport,
} from "../src/main/vellum/ssh/service";
import {
  admitEnrolledOpenSshStationPeer,
  encodeOpenSshStationFrame,
  makeOpenSshStationFrameDecoder,
  makeOpenSshStationFrameTransport,
  makeOpenSshStationPeerExchange,
} from "../src/main/vellum/station/openssh-peer-exchange";

const decodeInstallationId = Schema.decodeUnknownSync(InstallationId);
const decodeRequestId = Schema.decodeUnknownSync(StationSessionRequestId);
const decodeEndpoint = Schema.decodeUnknownSync(SshEndpoint);

const COMMAND_CENTER = decodeInstallationId("command-center");
const REMOTE = decodeInstallationId("remote-station");
const ENDPOINT = decodeEndpoint("remote-station");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const statusRequest = StatusRequest.make({
  protocol: STATION_API_PROTOCOL,
  op: "status",
});

const statusResponse = StatusResponse.make({
  protocol: STATION_API_PROTOCOL,
  op: "status",
  installationId: REMOTE,
  state: "ready",
  receivedThrough: [],
  peerAcknowledgedThrough: [],
  readiness: {
    database: true,
    workControl: true,
    simulation: true,
    session: true,
  },
  observedAt: "2026-07-27T18:00:00.000Z",
});

const requestFrame = (id: string): StationSessionRequestFrame =>
  StationSessionRequestFrame.make({
    protocol: STATION_SESSION_PROTOCOL,
    frame: "request",
    requestId: decodeRequestId(id),
    request: statusRequest,
  });

const responseFrame = (
  request: StationSessionRequestFrame,
): StationSessionResponseFrame =>
  stationSessionResponse(request, stationControlOk(statusResponse));

const expectFailureReason = async (
  effect: Effect.Effect<unknown, { readonly reason: string }>,
  reason: string,
): Promise<void> => {
  const result = await Effect.runPromise(Effect.either(effect));
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
    expect(result.left.reason).toBe(reason);
  }
};

const dormantLease = (
  write: SshLease["write"],
  close: Effect.Effect<void> = Effect.void,
): SshLease => ({
  write,
  writeSensitive: () => Effect.void,
  closeInput: Effect.void,
  stdout: Stream.fromEffect(Effect.never),
  stderr: Stream.empty,
  exitCode: Effect.never,
  close,
});

describe("OpenSSH Station session NDJSON", () => {
  it("incrementally decodes fragmented input and multiple frames per chunk", async () => {
    const first = requestFrame("fragmented-01");
    const second = responseFrame(first);
    const firstBytes = await Effect.runPromise(
      encodeOpenSshStationFrame(first),
    );
    const secondBytes = await Effect.runPromise(
      encodeOpenSshStationFrame(second),
    );
    const all = Buffer.concat([
      Buffer.from(firstBytes),
      Buffer.from(secondBytes),
    ]);
    const cut = Math.floor(firstBytes.byteLength / 2);
    const stream = makeOpenSshStationFrameDecoder();

    expect(
      await Effect.runPromise(stream.push(all.subarray(0, cut))),
    ).toEqual([]);
    const decoded = await Effect.runPromise(stream.push(all.subarray(cut)));

    expect(decoded).toEqual([first, second]);
    expect(await Effect.runPromise(stream.end)).toEqual([]);
  });

  it("rejects malformed UTF-8, malformed JSON, and excess properties", async () => {
    const malformedUtf8 = makeOpenSshStationFrameDecoder();
    await expectFailureReason(
      malformedUtf8.push(Uint8Array.from([0xc3, 0x28, 0x0a])),
      "malformed-frame",
    );

    const malformedJson = makeOpenSshStationFrameDecoder();
    await expectFailureReason(
      malformedJson.push(encoder.encode("{not-json}\n")),
      "malformed-frame",
    );

    const excessProperty = makeOpenSshStationFrameDecoder();
    await expectFailureReason(
      excessProperty.push(
        encoder.encode(
          `${JSON.stringify({
            ...requestFrame("excess-01"),
            unexpected: true,
          })}\n`,
        ),
      ),
      "malformed-frame",
    );
  });

  it("rejects oversized and truncated frames at the byte boundary", async () => {
    const oversized = makeOpenSshStationFrameDecoder(16);
    await expectFailureReason(
      oversized.push(encoder.encode("x".repeat(16))),
      "frame-too-large",
    );

    const truncated = makeOpenSshStationFrameDecoder();
    await Effect.runPromise(
      truncated.push(
        encoder.encode(JSON.stringify(requestFrame("truncated-01"))),
      ),
    );
    await expectFailureReason(truncated.end, "malformed-frame");
  });

  it("encodes exactly one newline-terminated frame and enforces its byte bound", async () => {
    const frame = requestFrame("encode-01");
    const bytes = await Effect.runPromise(encodeOpenSshStationFrame(frame));

    expect(bytes.at(-1)).toBe(0x0a);
    expect(decoder.decode(bytes).endsWith("\n")).toBe(true);
    expect(JSON.parse(decoder.decode(bytes))).toEqual(frame);
    expect(
      await Effect.runPromise(
        encodeOpenSshStationFrame(frame, bytes.byteLength),
      ),
    ).toEqual(bytes);
    await expectFailureReason(
      encodeOpenSshStationFrame(frame, bytes.byteLength - 1),
      "frame-too-large",
    );
  });
});

describe("OpenSSH Station frame transport", () => {
  it("serializes bounded writes even when callers send concurrently", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const firstStarted = yield* Deferred.make<void>();
          const secondStarted = yield* Deferred.make<void>();
          const firstRelease = yield* Deferred.make<void>();
          const secondRelease = yield* Deferred.make<void>();
          const started = [firstStarted, secondStarted];
          const releases = [firstRelease, secondRelease];
          let writeCalls = 0;
          let activeWrites = 0;
          let maximumActiveWrites = 0;

          const lease = dormantLease((bytes) =>
            Effect.gen(function* () {
              expect(bytes.at(-1)).toBe(0x0a);
              const index = writeCalls;
              writeCalls += 1;
              activeWrites += 1;
              maximumActiveWrites = Math.max(
                maximumActiveWrites,
                activeWrites,
              );
              yield* Deferred.succeed(started[index]!, undefined);
              yield* Deferred.await(releases[index]!);
              activeWrites -= 1;
            }),
          );
          const transport = yield* makeOpenSshStationFrameTransport(lease, {
            maxFrameBytes: 4_096,
            maxQueuedBytes: 8_192,
            maxQueuedFrames: 1,
          });
          const first = yield* Effect.fork(
            transport.send(requestFrame("serialized-01")),
          );
          yield* Deferred.await(firstStarted);
          const second = yield* Effect.fork(
            transport.send(requestFrame("serialized-02")),
          );
          yield* Effect.yieldNow();

          expect(yield* Deferred.isDone(secondStarted)).toBe(false);
          expect(maximumActiveWrites).toBe(1);

          yield* Deferred.succeed(firstRelease, undefined);
          yield* Deferred.await(secondStarted);
          expect(maximumActiveWrites).toBe(1);
          yield* Deferred.succeed(secondRelease, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);

          expect(writeCalls).toBe(2);
          expect(maximumActiveWrites).toBe(1);
        }),
      ),
    );
  });

  it("rejects a frame larger than the bounded byte queue before writing", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let writes = 0;
          const lease = dormantLease(() =>
            Effect.sync(() => {
              writes += 1;
            }),
          );
          const transport = yield* makeOpenSshStationFrameTransport(lease, {
            maxFrameBytes: 4_096,
            maxQueuedBytes: 32,
          });

          const result = yield* Effect.either(
            transport.send(requestFrame("bounded-01")),
          );
          expect(Either.isLeft(result)).toBe(true);
          if (Either.isLeft(result)) {
            expect(result.left.reason).toBe("queue-capacity");
          }
          expect(writes).toBe(0);
        }),
      ),
    );
  });

  it("fails the active send and closes the lease after a write disconnect", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const closeObserved = yield* Deferred.make<void>();
          let closes = 0;
          const lease = dormantLease(
            () =>
              Effect.fail(
                new SshIoError({
                  endpoint: ENDPOINT,
                  operation: "write",
                  message: "injected disconnect",
                }),
              ),
            Effect.sync(() => {
              closes += 1;
            }).pipe(
              Effect.zipRight(
                Deferred.succeed(closeObserved, undefined),
              ),
              Effect.asVoid,
            ),
          );
          const transport = yield* makeOpenSshStationFrameTransport(lease, {
            maxFrameBytes: 4_096,
            maxQueuedBytes: 8_192,
          });

          const first = yield* Effect.either(
            transport.send(requestFrame("disconnect-01")),
          );
          expect(Either.isLeft(first)).toBe(true);
          if (Either.isLeft(first)) {
            expect(first.left.reason).toBe("write-failed");
          }
          yield* Deferred.await(closeObserved);

          const afterClose = yield* Effect.either(
            transport.send(requestFrame("disconnect-02")),
          );
          expect(Either.isLeft(afterClose)).toBe(true);
          if (Either.isLeft(afterClose)) {
            expect(afterClose.left.reason).toBe("closed");
          }
          expect(closes).toBe(1);
        }),
      ),
    );
  });

  it("settles active, queued, and offer-blocked sends when close races enqueue", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const firstWriteStarted = yield* Deferred.make<void>();
          const releaseFirstWrite = yield* Deferred.make<void>();
          const lease = dormantLease(
            () =>
              Deferred.succeed(firstWriteStarted, undefined).pipe(
                Effect.zipRight(Deferred.await(releaseFirstWrite)),
                Effect.asVoid,
              ),
            Deferred.succeed(releaseFirstWrite, undefined).pipe(
              Effect.asVoid,
            ),
          );
          const transport = yield* makeOpenSshStationFrameTransport(lease, {
            maxFrameBytes: 4_096,
            maxQueuedBytes: 12_288,
            maxQueuedFrames: 1,
          });

          const first = yield* Effect.fork(
            Effect.either(
              transport.send(requestFrame("close-race-01")),
            ),
          );
          yield* Deferred.await(firstWriteStarted);
          const second = yield* Effect.fork(
            Effect.either(
              transport.send(requestFrame("close-race-02")),
            ),
          );
          yield* Effect.yieldNow();
          const third = yield* Effect.fork(
            Effect.either(
              transport.send(requestFrame("close-race-03")),
            ),
          );
          yield* Effect.yieldNow();

          yield* transport.close;

          for (const result of [
            yield* Fiber.join(first),
            yield* Fiber.join(second),
            yield* Fiber.join(third),
          ]) {
            expect(Either.isLeft(result)).toBe(true);
            if (Either.isLeft(result)) {
              expect(result.left.reason).toBe("closed");
            }
          }
          const afterClose = yield* Effect.either(
            transport.send(requestFrame("close-race-04")),
          );
          expect(Either.isLeft(afterClose)).toBe(true);
          if (Either.isLeft(afterClose)) {
            expect(afterClose.left.reason).toBe("closed");
          }
        }),
      ),
    );
  });
});

describe("OpenSSH Station peer exchange", () => {
  const localDiagnostics = {
    appVersion: Schema.decodeUnknownSync(StationAppVersion)("cc-test"),
    stateSchemaVersion: Schema.decodeUnknownSync(StationStateSchemaVersion)(1),
    support: CURRENT_STATION_PROTOCOL_SUPPORT,
  };
  const peerDiagnostics = {
    appVersion: Schema.decodeUnknownSync(StationAppVersion)("remote-test"),
    stateSchemaVersion: Schema.decodeUnknownSync(StationStateSchemaVersion)(1),
    support: CURRENT_STATION_PROTOCOL_SUPPORT,
  };

  type WriteFrame = (
    frame: unknown,
    stdout: Queue.Queue<Uint8Array>,
  ) => Effect.Effect<void>;

  const liveLease = async (
    onWrite: WriteFrame,
  ): Promise<{
    readonly lease: SshLease;
    readonly written: unknown[];
  }> => {
    const stdout = await Effect.runPromise(Queue.unbounded<Uint8Array>());
    const written: unknown[] = [];
    const lease: SshLease = {
      write: (bytes) =>
        Effect.gen(function* () {
          const frame = JSON.parse(decoder.decode(bytes).trim()) as unknown;
          written.push(frame);
          yield* onWrite(frame, stdout);
        }),
      writeSensitive: () => Effect.void,
      closeInput: Effect.void,
      stdout: Stream.fromQueue(stdout),
      stderr: Stream.empty,
      exitCode: Effect.never,
      close: Queue.shutdown(stdout),
    };
    return { lease, written };
  };

  const endedLease = (
    code: number,
    written: unknown[],
    stdoutBytes?: Uint8Array,
  ): SshLease => ({
    write: (bytes) =>
      Effect.sync(() => {
        written.push(JSON.parse(decoder.decode(bytes).trim()) as unknown);
      }),
    writeSensitive: () => Effect.void,
    closeInput: Effect.void,
    stdout:
      stdoutBytes === undefined
        ? Stream.empty
        : Stream.make(stdoutBytes),
    stderr: Stream.empty,
    exitCode: Effect.succeed(code),
    close: Effect.void,
  });

  const scriptedSsh = (
    leases: ReadonlyArray<SshLease>,
  ): {
    readonly ssh: typeof SshTransport.Service;
    readonly connectCalls: () => number;
  } => {
    let connectCalls = 0;
    const connect = (
      _program: unknown,
      awaitReady: (
        lease: SshLease,
        confirm: ConfirmSshReady,
      ) => Effect.Effect<unknown, unknown, unknown>,
    ) =>
      Effect.gen(function* () {
        const lease = leases[connectCalls];
        connectCalls += 1;
        if (lease === undefined) {
          throw new TypeError("Unexpected extra SSH connection");
        }
        const ready = yield* awaitReady(
          lease,
          ((value: unknown) => ({ value })) as ConfirmSshReady,
        );
        return (ready as { readonly value: unknown }).value;
      });
    let platformProbes = 0;
    const ssh = {
      run: () =>
        Effect.sync(() => {
          platformProbes += 1;
          return platformProbes === 1
            ? { stdout: "Linux\n", stderr: "" }
            : { stdout: "/home/remote\n", stderr: "" };
        }),
      connect,
      connectWithExitObservation: connect,
      transfer: () => Effect.die("Station exchange must not use transfer"),
      transact: () => Effect.die("Station exchange must not use transact"),
    } as unknown as typeof SshTransport.Service;
    return { ssh, connectCalls: () => connectCalls };
  };

  const makeExchange = async (leases: ReadonlyArray<SshLease>) => {
    const harness = scriptedSsh(leases);
    const platform = await Effect.runPromise(
      resolveRemotePackagedPlatform(harness.ssh, ENDPOINT),
    );
    const route = admitEnrolledOpenSshStationPeer({
      peerInstallationId: REMOTE,
      endpoint: ENDPOINT,
      platform,
    });
    return {
      ...harness,
      route,
      exchange: makeOpenSshStationPeerExchange(
        harness.ssh,
        COMMAND_CENTER,
        localDiagnostics,
      ),
    };
  };

  const respondToStatus = (
    frame: unknown,
    stdout: Queue.Queue<Uint8Array>,
  ): Effect.Effect<void> => {
    const request = frame as StationSessionFrame;
    if (request.frame !== "request") return Effect.void;
    const response = StationSessionResponseFrame.make({
      protocol: STATION_SESSION_PROTOCOL,
      frame: "response",
      requestId: request.requestId,
      envelope: stationControlOk(statusResponse),
    });
    return Queue.offer(
      stdout,
      encoder.encode(`${JSON.stringify(response)}\n`),
    ).pipe(Effect.asVoid);
  };

  const openFailure = (
    exchange: ReturnType<typeof makeOpenSshStationPeerExchange>,
    route: ReturnType<typeof admitEnrolledOpenSshStationPeer>,
  ) =>
    Effect.scoped(
      exchange.open(
        route,
        () =>
          Effect.succeed(
            stationControlErr(
              "authorization_denied",
              "unexpected report",
              false,
            ),
          ),
      ),
    ).pipe(Effect.either);

  it("negotiates v4 on the persistent connection before domain traffic", async () => {
    const scripted = await liveLease((frame, stdout) => {
      const record = frame as Record<string, unknown>;
      if (record.frame === "offer") {
        const response = StationProtocolAccept.make({
          protocol: STATION_PROTOCOL_PREFACE,
          frame: "accept",
          ...peerDiagnostics,
          selected: STATION_PROTOCOL_BASELINE,
        });
        return Queue.offer(
          stdout,
          encoder.encode(`${JSON.stringify(response)}\n`),
        ).pipe(Effect.asVoid);
      }
      return respondToStatus(frame, stdout);
    });
    const harness = await makeExchange([scripted.lease]);

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* harness.exchange.open(
            harness.route,
            () =>
              Effect.succeed(
                stationControlErr(
                  "authorization_denied",
                  "unexpected report",
                  false,
                ),
              ),
          );
          expect(session.protocol).toMatchObject({
            _tag: "negotiated",
            negotiatedProtocol: STATION_PROTOCOL_BASELINE,
            compatibility: "compatible",
            peer: peerDiagnostics,
          });
          return yield* session.request(statusRequest);
        }),
      ),
    );

    expect(result).toEqual(statusResponse);
    expect(harness.connectCalls()).toBe(1);
    expect((scripted.written[0] as StationProtocolOffer).frame).toBe("offer");
    expect((scripted.written[1] as StationSessionFrame).frame).toBe("request");
  });

  it("holds an early Remote report until same-session status verifies route identity", async () => {
    const statusObserved = await Effect.runPromise(Deferred.make<void>());
    const releaseStatus = await Effect.runPromise(Deferred.make<void>());
    const reportHandled = await Effect.runPromise(Deferred.make<void>());
    const report = ReportRequest.make({
      protocol: STATION_API_PROTOCOL,
      op: "report",
      senderInstallationId: REMOTE,
      targetInstallationId: COMMAND_CENTER,
      batch: {
        records: [],
        acknowledge: [],
        hasMore: false,
      },
    });
    const reportFrame = StationSessionRequestFrame.make({
      protocol: STATION_SESSION_PROTOCOL,
      frame: "request",
      requestId: decodeRequestId("early-report-01"),
      request: report,
    });
    let reportCalls = 0;
    const scripted = await liveLease((frame, stdout) => {
      const record = frame as Record<string, unknown>;
      if (record.frame === "offer") {
        const accept = StationProtocolAccept.make({
          protocol: STATION_PROTOCOL_PREFACE,
          frame: "accept",
          ...peerDiagnostics,
          selected: STATION_PROTOCOL_BASELINE,
        });
        return Effect.forEach(
          [accept, reportFrame],
          (outbound) =>
            Queue.offer(
              stdout,
              encoder.encode(`${JSON.stringify(outbound)}\n`),
            ),
          { discard: true },
        );
      }
      const request = frame as StationSessionFrame;
      if (
        request.frame === "request" &&
        request.request.op === "status"
      ) {
        return Deferred.succeed(statusObserved, undefined).pipe(
          Effect.zipRight(Deferred.await(releaseStatus)),
          Effect.zipRight(respondToStatus(frame, stdout)),
          Effect.asVoid,
        );
      }
      return Effect.void;
    });
    const harness = await makeExchange([scripted.lease]);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const opening = yield* Effect.fork(
            harness.exchange.open(harness.route, () => {
              reportCalls += 1;
              return Effect.void.pipe(
                Effect.zipRight(
                  Deferred.succeed(reportHandled, undefined),
                ),
                Effect.as(
                  stationControlOk(
                    ReportResponse.make({
                      protocol: STATION_API_PROTOCOL,
                      op: "report",
                      senderInstallationId: COMMAND_CENTER,
                      targetInstallationId: REMOTE,
                      batch: {
                        records: [],
                        acknowledge: [],
                        hasMore: false,
                      },
                    }),
                  ),
                ),
              );
            }),
          );
          yield* Deferred.await(statusObserved).pipe(
            Effect.timeoutFail({
              duration: 1_000,
              onTimeout: () =>
                new Error("identity status request was not sent"),
            }),
          );
          yield* Effect.yieldNow();
          expect(reportCalls).toBe(0);

          yield* Deferred.succeed(releaseStatus, undefined);
          yield* Fiber.join(opening).pipe(
            Effect.timeoutFail({
              duration: 1_000,
              onTimeout: () =>
                new Error("identity status verification did not finish"),
            }),
          );
          yield* Deferred.await(reportHandled).pipe(
            Effect.timeoutFail({
              duration: 1_000,
              onTimeout: () =>
                new Error("early report did not resume after verification"),
            }),
          );
          expect(reportCalls).toBe(1);
        }),
      ),
    );
  });

  it("fails the session without admitting reports when status names another installation", async () => {
    const wrongRemote = decodeInstallationId("different-remote");
    const wrongStatus = StatusResponse.make({
      ...statusResponse,
      installationId: wrongRemote,
    });
    const report = ReportRequest.make({
      protocol: STATION_API_PROTOCOL,
      op: "report",
      senderInstallationId: REMOTE,
      targetInstallationId: COMMAND_CENTER,
      batch: {
        records: [],
        acknowledge: [],
        hasMore: false,
      },
    });
    const reportFrame = StationSessionRequestFrame.make({
      protocol: STATION_SESSION_PROTOCOL,
      frame: "request",
      requestId: decodeRequestId("wrong-identity-report"),
      request: report,
    });
    let reportCalls = 0;
    const scripted = await liveLease((frame, stdout) => {
      const record = frame as Record<string, unknown>;
      if (record.frame === "offer") {
        const accept = StationProtocolAccept.make({
          protocol: STATION_PROTOCOL_PREFACE,
          frame: "accept",
          ...peerDiagnostics,
          selected: STATION_PROTOCOL_BASELINE,
        });
        return Effect.forEach(
          [accept, reportFrame],
          (outbound) =>
            Queue.offer(
              stdout,
              encoder.encode(`${JSON.stringify(outbound)}\n`),
            ),
          { discard: true },
        );
      }
      const request = frame as StationSessionFrame;
      if (
        request.frame === "request" &&
        request.request.op === "status"
      ) {
        return Queue.offer(
          stdout,
          encoder.encode(
            `${JSON.stringify(
              StationSessionResponseFrame.make({
                protocol: STATION_SESSION_PROTOCOL,
                frame: "response",
                requestId: request.requestId,
                envelope: stationControlOk(wrongStatus),
              }),
            )}\n`,
          ),
        ).pipe(Effect.asVoid);
      }
      return Effect.void;
    });
    const harness = await makeExchange([scripted.lease]);

    const result = await Effect.runPromise(
      Effect.scoped(
        harness.exchange.open(harness.route, () => {
          reportCalls += 1;
          return Effect.succeed(
            stationControlErr(
              "authorization_denied",
              "unexpected report",
              false,
            ),
          );
        }),
      ).pipe(Effect.either),
    );

    expect(Either.isLeft(result)).toBe(true);
    expect(reportCalls).toBe(0);
    expect(harness.connectCalls()).toBe(1);
  });

  it("does not reconnect after a pre-negotiation helper rejection", async () => {
    const firstWritten: unknown[] = [];
    const harness = await makeExchange([
      endedLease(64, firstWritten),
    ]);

    const result = await Effect.runPromise(
      openFailure(harness.exchange, harness.route),
    );

    expect(Either.isLeft(result)).toBe(true);
    expect(harness.connectCalls()).toBe(1);
    expect((firstWritten[0] as StationProtocolOffer).frame).toBe("offer");
  });

  it("does not fall back after another helper exit code", async () => {
    const written: unknown[] = [];
    const harness = await makeExchange([endedLease(1, written)]);

    const result = await Effect.runPromise(
      openFailure(harness.exchange, harness.route),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.reason).toBe("connect-failed");
    }
    expect(harness.connectCalls()).toBe(1);
  });

  it("does not fall back when code 64 races with any peer stdout byte", async () => {
    const written: unknown[] = [];
    const harness = await makeExchange([
      endedLease(64, written, encoder.encode("{")),
    ]);

    const result = await Effect.runPromise(
      openFailure(harness.exchange, harness.route),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.reason).toBe("protocol-negotiation");
    }
    expect(harness.connectCalls()).toBe(1);
  });

  it("does not fall back after any malformed peer bytes", async () => {
    const scripted = await liveLease((_frame, stdout) =>
      Queue.offer(stdout, encoder.encode("{malformed}\n")).pipe(
        Effect.asVoid,
      )
    );
    const harness = await makeExchange([scripted.lease]);

    const result = await Effect.runPromise(
      openFailure(harness.exchange, harness.route),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.reason).toBe("protocol-negotiation");
    }
    expect(harness.connectCalls()).toBe(1);
  });

  it("reports no-overlap as update-required evidence without fallback", async () => {
    const scripted = await liveLease((_frame, stdout) => {
      const reject = StationProtocolReject.make({
        protocol: STATION_PROTOCOL_PREFACE,
        frame: "reject",
        appVersion: peerDiagnostics.appVersion,
        stateSchemaVersion: peerDiagnostics.stateSchemaVersion,
        support: {
          preferred: 3,
          compatibleFrom: 3,
          warnBelow: 3,
        },
        reason: "no-common-version",
        retryable: false,
      });
      return Queue.offer(
        stdout,
        encoder.encode(`${JSON.stringify(reject)}\n`),
      ).pipe(Effect.asVoid);
    });
    const harness = await makeExchange([scripted.lease]);

    const result = await Effect.runPromise(
      openFailure(harness.exchange, harness.route),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({
        reason: "protocol-incompatible",
        localProtocol: localDiagnostics,
        peerProtocol: {
          appVersion: peerDiagnostics.appVersion,
          support: { compatibleFrom: 3, preferred: 3 },
        },
      });
    }
    expect(harness.connectCalls()).toBe(1);
  });

  it("rejects an inconsistent accept without fallback", async () => {
    const scripted = await liveLease((_frame, stdout) => {
      const accept = StationProtocolAccept.make({
        protocol: STATION_PROTOCOL_PREFACE,
        frame: "accept",
        appVersion: peerDiagnostics.appVersion,
        stateSchemaVersion: peerDiagnostics.stateSchemaVersion,
        support: {
          preferred: 3,
          compatibleFrom: 2,
          warnBelow: 2,
        },
        selected: 2,
      });
      return Queue.offer(
        stdout,
        encoder.encode(`${JSON.stringify(accept)}\n`),
      ).pipe(Effect.asVoid);
    });
    const harness = await makeExchange([scripted.lease]);

    const result = await Effect.runPromise(
      openFailure(harness.exchange, harness.route),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.reason).toBe("protocol-negotiation");
      expect(result.left.peerProtocol?.support.preferred).toBe(3);
    }
    expect(harness.connectCalls()).toBe(1);
  });
});
