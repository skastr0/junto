import { Chunk, Effect, Either, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  InstallationId,
  LogicalSequence,
  ProjectRequest,
  STATION_API_PROTOCOL,
  StationHostId,
  StationSha256,
  StatusResponse,
} from "../src/shared/station-api";
import {
  stationControlErr,
  stationControlOk,
} from "../src/shared/station-control";
import {
  SshEndpoint,
} from "../src/main/vellum/ssh/domain";
import { createSshProgramCompiler } from "../src/main/vellum/ssh/program";
import {
  DARWIN_PACKAGED_STATION_EXECUTABLE,
  RemotePlatformProbeError,
} from "../src/main/vellum/ssh/read-commands";
import {
  SshTransferExitError,
  type SshTransport,
} from "../src/main/vellum/ssh/service";
import {
  StationRemoteProtocolError,
  StationRemoteRejectedError,
  makeStationRemoteApiClient,
} from "../src/main/vellum/station/remote-client";

const decodeEndpoint = Schema.decodeUnknownSync(SshEndpoint);
const decodeInstallationId = Schema.decodeUnknownSync(InstallationId);
const decodeSequence = Schema.decodeUnknownSync(LogicalSequence);
const decodeHostId = Schema.decodeUnknownSync(StationHostId);
const decodeSha256 = Schema.decodeUnknownSync(StationSha256);

const ENDPOINT = decodeEndpoint("studio-mini");
const STATION = decodeInstallationId("station-studio");
const COMMAND_CENTER = decodeInstallationId("command-center");
const HASH = decodeSha256("a".repeat(64));

type Transfer = typeof SshTransport.Service["transfer"];
type Run = typeof SshTransport.Service["run"];

const collectInput = <E, R>(
  input: Stream.Stream<Uint8Array, E, R>,
): Effect.Effect<
  { readonly body: string; readonly chunks: ReadonlyArray<number> },
  E,
  R
> =>
  Stream.runCollect(input).pipe(
    Effect.map((collected) => {
      const parts = Chunk.toReadonlyArray(collected);
      return {
        body: Buffer.concat(parts.map((part) => Buffer.from(part)))
          .toString("utf8"),
        chunks: parts.map((part) => part.byteLength),
      };
    }),
  );

const fakeSsh = (
  transfer: Transfer,
  run: Run = (() =>
    Effect.succeed({
      stdout: "Darwin\n",
      stderr: "",
    })) as Run,
): typeof SshTransport.Service =>
  ({ run, transfer }) as unknown as typeof SshTransport.Service;

const successFrame = (response: unknown): string =>
  `${JSON.stringify(stationControlOk(response as never))}\n`;

describe("StationRemoteApiClient", () => {
  it("streams one typed request through the fixed vellum-station command", async () => {
    let request: unknown;
    let chunkSizes: ReadonlyArray<number> = [];
    let program: unknown;
    let probeProgram: unknown;
    let timeoutMs = 0;
    const response = StatusResponse.make({
      protocol: STATION_API_PROTOCOL,
      op: "status",
      installationId: STATION,
      state: "ready",
      configuration: {
        role: "remote",
        hostId: decodeHostId("studio"),
        agentHostId: decodeHostId("studio"),
        commandCenterInstallationId: COMMAND_CENTER,
        commandCenterRef: "command.tailnet",
        supervisedPreferred: true,
      },
      receivedThrough: [],
      readiness: {
        database: true,
        workControl: true,
        simulation: true,
      },
      observedAt: "2026-07-27T12:00:00.000Z",
    });
    const ssh = fakeSsh(
      ((candidate, input, timeout) => {
        program = candidate;
        timeoutMs = timeout;
        return collectInput(input).pipe(
          Effect.map((collected) => {
            request = JSON.parse(collected.body) as unknown;
            chunkSizes = collected.chunks;
            return { stdout: successFrame(response), stderr: "" };
          }),
        );
      }) as Transfer,
      ((candidate) => {
        probeProgram = candidate;
        return Effect.succeed({ stdout: "Darwin\n", stderr: "" });
      }) as Run,
    );

    const result = await Effect.runPromise(
      makeStationRemoteApiClient(ssh).status(ENDPOINT),
    );

    expect(result).toEqual(response);
    expect(request).toEqual({
      protocol: STATION_API_PROTOCOL,
      op: "status",
    });
    expect(chunkSizes).toEqual([expect.any(Number)]);
    expect(timeoutMs).toBe(60_000);
    const compiler = createSshProgramCompiler({
      controlDir: "/tmp/vellum-ssh",
      envExecutable: "/usr/bin/env",
      sshExecutable: "/usr/bin/ssh",
      environment: { PATH: "/tmp/attacker" },
    });
    const probe = compiler.oneShot(probeProgram as never);
    const compiled = compiler.stream(program as never);
    expect(String(probe.command)).toContain("/usr/bin/uname");
    expect(probe.input).toBeUndefined();
    expect(String(compiled.command)).toContain(
      DARWIN_PACKAGED_STATION_EXECUTABLE,
    );
    expect(String(compiled.command)).not.toMatch(
      /(?:^|[ '"])vellum-station(?:[ '"]|$)/u,
    );
    expect(String(compiled.command)).not.toContain("/bin/sh");
  });

  it("streams projection bodies in bounded chunks without a 16 MiB one-shot lane", async () => {
    const body = "x".repeat(2 * 1024 * 1024);
    let chunks: ReadonlyArray<number> = [];
    const ssh = fakeSsh(((_program, input) =>
      collectInput(input).pipe(
        Effect.map((collected) => {
          chunks = collected.chunks;
          const request = JSON.parse(collected.body) as {
            projection: { generation: string; contentSha256: string };
          };
          return {
            stdout: successFrame({
              protocol: STATION_API_PROTOCOL,
              op: "project",
              stationInstallationId: STATION,
              decision: "install",
              active: {
                generation: request.projection.generation,
                contentSha256: request.projection.contentSha256,
                receivedAt: "2026-07-27T12:00:00.000Z",
              },
            }),
            stderr: "",
          };
        }),
      )) as Transfer);
    const client = makeStationRemoteApiClient(ssh);

    const response = await Effect.runPromise(
      client.project(
        ENDPOINT,
        ProjectRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "project",
          stationInstallationId: STATION,
          projection: {
            scope: "full",
            generation: decodeSequence("9"),
            body,
            contentSha256: HASH,
            createdAt: "2026-07-27T12:00:00.000Z",
          },
        }),
      ),
    );

    expect(response.decision).toBe("install");
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks)).toBeLessThanOrEqual(512 * 1024);
  });

  it("never sends a Station frame when current platform evidence is not supported", async () => {
    let transferred = false;
    const ssh = fakeSsh(
      ((..._args: Parameters<Transfer>) => {
        transferred = true;
        return Effect.die("Station frame must not be transferred");
      }) as Transfer,
      (() =>
        Effect.succeed({
          stdout: "FreeBSD\n",
          stderr: "",
        })) as Run,
    );

    const outcome = await Effect.runPromise(
      Effect.either(makeStationRemoteApiClient(ssh).status(ENDPOINT)),
    );

    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) {
      expect(outcome.left).toBeInstanceOf(RemotePlatformProbeError);
    }
    expect(transferred).toBe(false);
  });

  it("preserves typed Station rejection envelopes from non-zero remote exits", async () => {
    const rejected = `${JSON.stringify(
      stationControlErr(
        "state_conflict",
        "generation identity conflict",
        false,
      ),
    )}\n`;
    const ssh = fakeSsh((() =>
      Effect.fail(
        new SshTransferExitError(
          ENDPOINT,
          1,
          rejected,
          "",
        ),
      )) as Transfer);

    const outcome = await Effect.runPromise(
      Effect.either(makeStationRemoteApiClient(ssh).status(ENDPOINT)),
    );

    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) {
      expect(outcome.left).toBeInstanceOf(StationRemoteRejectedError);
      expect(outcome.left).toMatchObject({
        code: "state_conflict",
        retryable: false,
      });
    }
  });

  it("fails closed when response operation or identity does not match the request", async () => {
    const wrongIdentity = StatusResponse.make({
      protocol: STATION_API_PROTOCOL,
      op: "status",
      installationId: decodeInstallationId("other-station"),
      state: "ready",
      receivedThrough: [],
      readiness: {
        database: true,
        workControl: true,
        simulation: true,
      },
      observedAt: "2026-07-27T12:00:00.000Z",
    });
    const wrongOperationSsh = fakeSsh((() =>
      Effect.succeed({
        stdout: successFrame({
          protocol: STATION_API_PROTOCOL,
          op: "report",
          stationInstallationId: STATION,
          inbound: [],
          acknowledgeOutbound: [],
        }),
        stderr: "",
      })) as Transfer);
    const wrongIdentitySsh = fakeSsh((() =>
      Effect.succeed({
        stdout: successFrame(wrongIdentity),
        stderr: "",
      })) as Transfer);

    const wrongOperation = await Effect.runPromise(
      Effect.either(
        makeStationRemoteApiClient(wrongOperationSsh).status(ENDPOINT),
      ),
    );
    expect(Either.isLeft(wrongOperation)).toBe(true);
    if (Either.isLeft(wrongOperation)) {
      expect(wrongOperation.left).toBeInstanceOf(
        StationRemoteProtocolError,
      );
      expect(wrongOperation.left).toMatchObject({
        reason: "operation-mismatch",
      });
    }

    // Status has no request identity to correlate; the caller's enrolled
    // target check belongs to StationPropagation.
    await expect(
      Effect.runPromise(
        makeStationRemoteApiClient(wrongIdentitySsh).status(ENDPOINT),
      ),
    ).resolves.toEqual(wrongIdentity);
  });
});
