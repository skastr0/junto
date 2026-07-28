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
  it("opens one scoped SSH session without one-shot fallback and correlates status", async () => {
    const stdout = await Effect.runPromise(Queue.unbounded<Uint8Array>());
    let runCalls = 0;
    let connectCalls = 0;
    let transferCalls = 0;
    let transactCalls = 0;
    let leaseCloses = 0;
    const writtenFrames: StationSessionFrame[] = [];

    const lease: SshLease = {
      write: (bytes) =>
        Effect.gen(function* () {
          const frame = JSON.parse(decoder.decode(bytes).trim()) as
            StationSessionFrame;
          writtenFrames.push(frame);
          if (frame.frame !== "request") return;
          const response = StationSessionResponseFrame.make({
            protocol: STATION_SESSION_PROTOCOL,
            frame: "response",
            requestId: frame.requestId,
            envelope: stationControlOk(statusResponse),
          });
          yield* Queue.offer(
            stdout,
            encoder.encode(`${JSON.stringify(response)}\n`),
          );
        }),
      writeSensitive: () => Effect.void,
      closeInput: Effect.void,
      stdout: Stream.fromQueue(stdout),
      stderr: Stream.empty,
      exitCode: Effect.never,
      close: Effect.sync(() => {
        leaseCloses += 1;
      }).pipe(
        Effect.zipRight(Queue.shutdown(stdout)),
        Effect.asVoid,
      ),
    };

    const ssh = {
      run: () =>
        Effect.sync(() => {
          runCalls += 1;
          return { stdout: "Linux\n", stderr: "" };
        }),
      connect: (
        _program: unknown,
        awaitReady: (
          lease: SshLease,
          confirm: ConfirmSshReady,
        ) => Effect.Effect<unknown, unknown, unknown>,
      ) =>
        Effect.gen(function* () {
          connectCalls += 1;
          const ready = yield* awaitReady(
            lease,
            ((value: unknown) => ({ value })) as ConfirmSshReady,
          );
          return (ready as { readonly value: unknown }).value;
        }),
      transfer: () =>
        Effect.sync(() => {
          transferCalls += 1;
          throw new Error("Station exchange must not use transfer");
        }),
      transact: () =>
        Effect.sync(() => {
          transactCalls += 1;
          throw new Error("Station exchange must not use transact");
        }),
    } as unknown as typeof SshTransport.Service;

    const platform = await Effect.runPromise(
      resolveRemotePackagedPlatform(ssh, ENDPOINT),
    );
    runCalls = 0;
    const route = admitEnrolledOpenSshStationPeer({
      peerInstallationId: REMOTE,
      endpoint: ENDPOINT,
      platform,
    });
    const exchange = makeOpenSshStationPeerExchange(
      ssh,
      COMMAND_CENTER,
    );

    const response = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* exchange.open(
            route,
            () =>
              Effect.succeed(
                stationControlErr(
                  "authorization_denied",
                  "unexpected report",
                  false,
                ),
              ),
          );
          expect(connectCalls).toBe(1);
          expect(runCalls).toBe(0);
          expect(transferCalls).toBe(0);
          expect(transactCalls).toBe(0);
          return yield* session.request(statusRequest);
        }),
      ),
    );

    expect(response).toEqual(statusResponse);
    expect(writtenFrames).toHaveLength(1);
    expect(writtenFrames[0]?.frame).toBe("request");
    expect(connectCalls).toBe(1);
    expect(runCalls).toBe(0);
    expect(transferCalls).toBe(0);
    expect(transactCalls).toBe(0);
    expect(leaseCloses).toBe(1);
  });
});
