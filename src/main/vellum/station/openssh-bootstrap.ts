import { randomUUID } from "node:crypto";
import { Effect, Schema, Stream } from "effect";
import {
  STATION_API_PROTOCOL,
  StatusRequest,
  type StatusResponse,
} from "@shared/station-api";
import {
  STATION_SESSION_PROTOCOL,
  StationSessionRequestFrame,
  StationSessionRequestId,
  decideStationSessionCorrelation,
  type StationSessionFrame,
} from "@shared/station-session";
import { STATION_CONTROL_REQUEST_TIMEOUT_MS } from "@shared/station-ssh-control";
import type { SshError, SshTarget } from "../ssh/domain";
import { sharedStream } from "../ssh/program";
import {
  resolveRemoteStationHelper,
  type RemotePackagedPlatform,
} from "../ssh/read-commands";
import {
  SshTransport,
  type SshLease,
} from "../ssh/service";
import {
  STATION_OPENSSH_MAX_FRAME_BYTES,
  makeOpenSshStationFrameTransport,
} from "./openssh-peer-exchange";
import type {
  StationSessionFrameTransport,
  StationSessionTransportError,
} from "./peer-session";

type Ssh = typeof SshTransport.Service;

export class OpenSshStationBootstrapError extends Schema.TaggedError<OpenSshStationBootstrapError>()(
  "OpenSshStationBootstrapError",
  {
    reason: Schema.Literal(
      "missing-response",
      "response-mismatch",
      "remote-rejected",
      "second-frame",
      "remote-exit",
      "timeout",
    ),
    message: Schema.String,
  },
) {}

export interface OpenSshStationBootstrapOptions {
  /** Tests may lower the product timeout; callers cannot raise it. */
  readonly timeoutMs?: number;
  /** Tests may lower the product frame bound; callers cannot raise it. */
  readonly maxFrameBytes?: number;
}

interface OpenBootstrapConnection {
  readonly lease: SshLease;
  readonly transport: StationSessionFrameTransport;
}

const bootstrapError = (
  reason: OpenSshStationBootstrapError["reason"],
  message: string,
): OpenSshStationBootstrapError =>
  OpenSshStationBootstrapError.make({ reason, message });

const boundedTimeout = (requested: number | undefined): number =>
  requested !== undefined &&
    Number.isFinite(requested) &&
    requested > 0
    ? Math.min(Math.floor(requested), STATION_CONTROL_REQUEST_TIMEOUT_MS)
    : STATION_CONTROL_REQUEST_TIMEOUT_MS;

const boundedFrameBytes = (requested: number | undefined): number =>
  requested !== undefined &&
    Number.isFinite(requested) &&
    requested > 0
    ? Math.min(Math.floor(requested), STATION_OPENSSH_MAX_FRAME_BYTES)
    : STATION_OPENSSH_MAX_FRAME_BYTES;

const makeStatusFrame = (): StationSessionRequestFrame =>
  StationSessionRequestFrame.make({
    protocol: STATION_SESSION_PROTOCOL,
    frame: "request",
    requestId: Schema.decodeUnknownSync(StationSessionRequestId)(randomUUID()),
    request: StatusRequest.make({
      protocol: STATION_API_PROTOCOL,
      op: "status",
    }),
  });

const statusFromFrame = (
  request: StationSessionRequestFrame,
  frame: StationSessionFrame,
): Effect.Effect<StatusResponse, OpenSshStationBootstrapError> => {
  if (frame.frame !== "response") {
    return Effect.fail(
      bootstrapError(
        "response-mismatch",
        "OpenSSH Station bootstrap received a request frame",
      ),
    );
  }
  const correlation = decideStationSessionCorrelation(request, frame);
  if (correlation._tag !== "correlated") {
    return Effect.fail(
      bootstrapError(
        "response-mismatch",
        "OpenSSH Station bootstrap response did not match its status request",
      ),
    );
  }
  if (!frame.envelope.ok) {
    return Effect.fail(
      bootstrapError(
        "remote-rejected",
        "Remote rejected the OpenSSH Station status bootstrap",
      ),
    );
  }
  if (frame.envelope.response.op !== "status") {
    return Effect.fail(
      bootstrapError(
        "response-mismatch",
        "OpenSSH Station bootstrap returned a non-status response",
      ),
    );
  }
  return Effect.succeed(frame.envelope.response);
};

/**
 * Discover one fresh Remote installation identity over its registered
 * operator-controlled OpenSSH route.
 *
 * This is deliberately not a Station peer session: a normal peer session
 * requires the enrolled installation identity that this single exchange
 * discovers. The fixed helper receives exactly one status request; input then
 * closes, every additional frame is rejected, and the whole SSH scope closes
 * before the returned routing fact can be admitted as a known peer.
 */
export const bootstrapOpenSshStationStatus = (
  ssh: Ssh,
  endpoint: SshTarget,
  platform: RemotePackagedPlatform,
  options: OpenSshStationBootstrapOptions = {},
): Effect.Effect<
  StatusResponse,
  SshError | StationSessionTransportError | OpenSshStationBootstrapError
> => {
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const maxFrameBytes = boundedFrameBytes(options.maxFrameBytes);
  return Effect.scoped(
    Effect.gen(function* () {
      const command = yield* resolveRemoteStationHelper(
        ssh,
        endpoint,
        platform,
        "session",
      );
      const connection = yield* ssh.connect(
        sharedStream(endpoint, command, "agent"),
        (lease, confirm) =>
          makeOpenSshStationFrameTransport(lease, {
            maxFrameBytes,
            maxQueuedBytes: maxFrameBytes,
          }).pipe(
            Effect.map((transport) =>
              confirm({ lease, transport } satisfies OpenBootstrapConnection)
            ),
          ),
      );
      const request = makeStatusFrame();
      let status: StatusResponse | undefined;

      yield* connection.transport.send(request);
      yield* Stream.runForEach(
        connection.transport.incoming,
        (frame) =>
          Effect.gen(function* () {
            if (status !== undefined) {
              return yield* bootstrapError(
                "second-frame",
                "OpenSSH Station bootstrap received more than one frame",
              );
            }
            status = yield* statusFromFrame(request, frame);
            yield* connection.lease.closeInput;
          }),
      );

      if (status === undefined) {
        return yield* bootstrapError(
          "missing-response",
          "OpenSSH Station bootstrap ended without a status response",
        );
      }
      const exitCode = yield* connection.lease.exitCode;
      if (exitCode !== 0) {
        return yield* bootstrapError(
          "remote-exit",
          "OpenSSH Station bootstrap helper exited unsuccessfully",
        );
      }
      yield* connection.transport.close;
      return status;
    }),
  ).pipe(
    Effect.timeoutFail({
      duration: timeoutMs,
      onTimeout: () =>
        bootstrapError(
          "timeout",
          `OpenSSH Station bootstrap exceeded its ${timeoutMs}ms deadline`,
        ),
    }),
  );
};
