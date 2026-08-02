import {
  Deferred,
  Effect,
  Result,
  Schema,
  Stream,
} from "effect";
import { describe, expect, it } from "vitest";
import {
  InstallationId,
  STATION_API_PROTOCOL,
  StatusResponse,
} from "../src/shared/station-api";
import { stationControlOk } from "../src/shared/station-api-envelope";
import {
  STATION_SESSION_PROTOCOL,
  StationSessionRequestId,
  StationSessionResponseFrame,
  type StationSessionFrame,
  type StationSessionRequestFrame,
} from "../src/shared/station-session";
import { SshEndpoint } from "../src/main/vellum/ssh/domain";
import { resolveRemotePackagedPlatform } from "../src/main/vellum/ssh/read-commands";
import type {
  ConfirmSshReady,
  SshLease,
  SshTransport,
} from "../src/main/vellum/ssh/service";
import {
  OpenSshStationBootstrapError,
  bootstrapOpenSshStationStatus,
} from "../src/main/vellum/station/openssh-bootstrap";

const decodeInstallationId = Schema.decodeUnknownSync(InstallationId);
const decodeRequestId = Schema.decodeUnknownSync(StationSessionRequestId);
const decodeEndpoint = Schema.decodeUnknownSync(SshEndpoint);
const remoteInstallationId = decodeInstallationId("remote-bootstrap");
const endpoint = decodeEndpoint("remote-bootstrap");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const statusResponse = StatusResponse.make({
  protocol: STATION_API_PROTOCOL,
  op: "status",
  installationId: remoteInstallationId,
  state: "unenrolled",
  receivedThrough: [],
  peerAcknowledgedThrough: [],
  readiness: {
    database: true,
    workControl: true,
    simulation: true,
    session: true,
  },
  observedAt: "2026-07-27T20:00:00.000Z",
});

const encodedFrame = (frame: StationSessionFrame): Uint8Array =>
  encoder.encode(`${JSON.stringify(frame)}\n`);

const correlatedStatus = (
  request: StationSessionRequestFrame,
): StationSessionResponseFrame =>
  StationSessionResponseFrame.make({
    protocol: STATION_SESSION_PROTOCOL,
    frame: "response",
    requestId: request.requestId,
    envelope: stationControlOk(statusResponse),
  });

type BootstrapReply = (
  request: StationSessionRequestFrame,
) => Effect.Effect<ReadonlyArray<Uint8Array>>;

const makeBootstrapSsh = (
  reply: BootstrapReply,
  exitCode = 0,
): {
  readonly ssh: typeof SshTransport.Service;
  readonly events: string[];
} => {
  const events: string[] = [];
  let platformProbes = 0;
  const ssh = {
    run: () =>
      Effect.sync(() => {
        platformProbes += 1;
        if (platformProbes === 1) {
          events.push("platform");
          return { stdout: "Linux\n", stderr: "" };
        }
        events.push("home");
        return { stdout: "/home/remote\n", stderr: "" };
      }),
    connect: (
      _program: unknown,
      awaitReady: (
        lease: SshLease,
        confirm: ConfirmSshReady,
      ) => Effect.Effect<unknown, unknown, unknown>,
    ) =>
      Effect.gen(function* () {
        events.push("open");
        const output = yield* Deferred.make<ReadonlyArray<Uint8Array>>();
        const lease: SshLease = {
          write: (bytes) =>
            Effect.gen(function* () {
              events.push("write");
              const frame = JSON.parse(
                decoder.decode(bytes).trim(),
              ) as StationSessionFrame;
              if (frame.frame !== "request") {
                return yield* Effect.dieMessage(
                  "bootstrap wrote a response frame",
                );
              }
              const chunks = yield* reply(frame);
              yield* Deferred.succeed(output, chunks);
            }),
          writeSensitive: () => Effect.dieMessage("unexpected sensitive write"),
          closeInput: Effect.sync(() => {
            events.push("close-input");
          }),
          stdout: Stream.fromEffect(Deferred.await(output)).pipe(
            Stream.flatMap((chunks) => Stream.fromIterable(chunks)),
          ),
          stderr: Stream.empty,
          exitCode: Effect.succeed(exitCode),
          close: Effect.sync(() => {
            events.push("close");
          }),
        };
        const ready = yield* awaitReady(
          lease,
          ((value: unknown) => ({ value })) as ConfirmSshReady,
        );
        return (ready as { readonly value: unknown }).value;
      }),
    transfer: () => Effect.dieMessage("bootstrap must not transfer"),
    transact: () => Effect.dieMessage("bootstrap must not transact"),
  } as unknown as typeof SshTransport.Service;
  return { ssh, events };
};

const runBootstrap = async (
  fixture: ReturnType<typeof makeBootstrapSsh>,
  options: Parameters<typeof bootstrapOpenSshStationStatus>[3] = {},
) => {
  const platform = await Effect.runPromise(
    resolveRemotePackagedPlatform(fixture.ssh, endpoint),
  );
  return Effect.runPromise(
    Effect.result(
      bootstrapOpenSshStationStatus(
        fixture.ssh,
        endpoint,
        platform,
        options,
      ),
    ),
  );
};

describe("OpenSSH Station status bootstrap", () => {
  it("accepts exactly one correlated status and closes the bootstrap", async () => {
    const fixture = makeBootstrapSsh((request) =>
      Effect.succeed([encodedFrame(correlatedStatus(request))])
    );

    const result = await runBootstrap(fixture);

    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success).toEqual(statusResponse);
    }
    expect(fixture.events).toEqual([
      "platform",
      "home",
      "open",
      "write",
      "close-input",
      "close",
    ]);
  });

  it("rejects a second frame even when both arrive in one SSH chunk", async () => {
    const fixture = makeBootstrapSsh((request) => {
      const response = encodedFrame(correlatedStatus(request));
      return Effect.succeed([
        Buffer.concat([Buffer.from(response), Buffer.from(response)]),
      ]);
    });

    const result = await runBootstrap(fixture);

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: "OpenSshStationBootstrapError",
        reason: "second-frame",
      });
    }
    expect(fixture.events.filter((event) => event === "write")).toHaveLength(1);
    expect(fixture.events.at(-1)).toBe("close");
  });

  it("rejects correlation mismatch and malformed or oversized frames", async () => {
    const mismatched = makeBootstrapSsh((request) =>
      Effect.succeed([
        encodedFrame(
          StationSessionResponseFrame.make({
            protocol: STATION_SESSION_PROTOCOL,
            frame: "response",
            requestId: decodeRequestId(`${request.requestId}-other`),
            envelope: stationControlOk(statusResponse),
          }),
        ),
      ])
    );
    const malformed = makeBootstrapSsh(() =>
      Effect.succeed([encoder.encode("{not-json}\n")])
    );
    const oversized = makeBootstrapSsh(() =>
      Effect.succeed([encoder.encode(`${"x".repeat(512)}\n`)])
    );

    const mismatchResult = await runBootstrap(mismatched);
    const malformedResult = await runBootstrap(malformed);
    const oversizedResult = await runBootstrap(oversized, {
      maxFrameBytes: 256,
    });

    expect(Result.isFailure(mismatchResult)).toBe(true);
    if (Result.isFailure(mismatchResult)) {
      expect(mismatchResult.fail).toMatchObject({
        _tag: "OpenSshStationBootstrapError",
        reason: "response-mismatch",
      });
    }
    expect(Result.isFailure(malformedResult)).toBe(true);
    if (Result.isFailure(malformedResult)) {
      expect(malformedResult.fail).toMatchObject({
        _tag: "StationSessionTransportError",
        reason: "malformed-frame",
      });
    }
    expect(Result.isFailure(oversizedResult)).toBe(true);
    if (Result.isFailure(oversizedResult)) {
      expect(oversizedResult.fail).toMatchObject({
        _tag: "StationSessionTransportError",
        reason: "frame-too-large",
      });
    }
  });

  it("times out and closes when the helper never returns a frame", async () => {
    const fixture = makeBootstrapSsh(() => Effect.never);

    const result = await runBootstrap(fixture, { timeoutMs: 10 });

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(OpenSshStationBootstrapError);
      expect(result.failure).toMatchObject({ reason: "timeout" });
    }
    expect(fixture.events.at(-1)).toBe("close");
  });
});
