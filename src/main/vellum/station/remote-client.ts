import { Context, Effect, Either, Layer, Schema, Stream } from "effect";
import {
  ConfigureResponse,
  PairResponse,
  ProjectResponse,
  ReportResponse,
  STATION_API_PROTOCOL,
  StatusRequest,
  StatusResponse,
  type ConfigureRequest,
  type PairRequest,
  type ProjectRequest,
  type ReportRequest,
  type StationApiRequest,
  type StationApiResponse,
} from "@shared/station-api";
import {
  STATION_CONTROL_MAX_FRAME_BYTES,
  StationControlErrorCode,
  decodeStationControlEnvelope,
  type StationControlEnvelope,
} from "@shared/station-control";
import {
  SshEndpoint,
  type SshError,
} from "../ssh/domain";
import { sharedStream } from "../ssh/program";
import {
  SshTransferExitError,
  SshTransport,
} from "../ssh/service";
import {
  RemotePlatformProbeError,
  remoteVellumStation,
  resolveRemotePackagedPlatform,
} from "../ssh/read-commands";

const STATION_REMOTE_INPUT_CHUNK_BYTES = 512 * 1024;
export const STATION_REMOTE_TRANSFER_TIMEOUT_MS = 60_000;

type StationOperation = StationApiRequest["op"];

export class StationRemoteProtocolError extends Schema.TaggedError<StationRemoteProtocolError>()(
  "StationRemoteProtocolError",
  {
    endpoint: SshEndpoint,
    operation: Schema.Literal(
      "pair",
      "configure",
      "project",
      "report",
      "status",
    ),
    reason: Schema.Literal(
      "request-encoding",
      "malformed-response",
      "operation-mismatch",
      "identity-mismatch",
      "unexpected-success-exit",
    ),
    message: Schema.String,
  },
) {}

export class StationRemoteRejectedError extends Schema.TaggedError<StationRemoteRejectedError>()(
  "StationRemoteRejectedError",
  {
    endpoint: SshEndpoint,
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

export class StationRemoteExecutionError extends Schema.TaggedError<StationRemoteExecutionError>()(
  "StationRemoteExecutionError",
  {
    endpoint: SshEndpoint,
    operation: Schema.Literal(
      "pair",
      "configure",
      "project",
      "report",
      "status",
    ),
    exitCode: Schema.Int,
    message: Schema.String,
  },
) {}

export type StationRemoteApiError =
  | SshError
  | RemotePlatformProbeError
  | StationRemoteProtocolError
  | StationRemoteRejectedError
  | StationRemoteExecutionError;

const protocolError = (
  endpoint: SshEndpoint,
  operation: StationOperation,
  reason: StationRemoteProtocolError["reason"],
  message: string,
): StationRemoteProtocolError =>
  StationRemoteProtocolError.make({
    endpoint,
    operation,
    reason,
    message,
  });

const encodeRequest = (
  endpoint: SshEndpoint,
  request: StationApiRequest,
): Effect.Effect<Uint8Array, StationRemoteProtocolError> =>
  Effect.try({
    try: () => {
      const bytes = new TextEncoder().encode(JSON.stringify(request));
      if (
        bytes.byteLength === 0 ||
        bytes.byteLength > STATION_CONTROL_MAX_FRAME_BYTES
      ) {
        throw new Error(
          `Station API frame exceeds ${STATION_CONTROL_MAX_FRAME_BYTES} bytes`,
        );
      }
      return bytes;
    },
    catch: (error) =>
      protocolError(
        endpoint,
        request.op,
        "request-encoding",
        error instanceof Error
          ? error.message
          : "Station API request could not be encoded",
      ),
  });

const inputChunks = (bytes: Uint8Array): ReadonlyArray<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  for (
    let offset = 0;
    offset < bytes.byteLength;
    offset += STATION_REMOTE_INPUT_CHUNK_BYTES
  ) {
    chunks.push(
      bytes.subarray(
        offset,
        Math.min(offset + STATION_REMOTE_INPUT_CHUNK_BYTES, bytes.byteLength),
      ),
    );
  }
  return chunks;
};

const decodeEnvelopeOutput = (
  endpoint: SshEndpoint,
  operation: StationOperation,
  stdout: string,
): Effect.Effect<StationControlEnvelope, StationRemoteProtocolError> => {
  if (
    !stdout.endsWith("\n") ||
    stdout.indexOf("\n") !== stdout.length - 1
  ) {
    return Effect.fail(
      protocolError(
        endpoint,
        operation,
        "malformed-response",
        "remote Station API must return exactly one newline-terminated frame",
      ),
    );
  }

  return Effect.try({
    try: () => JSON.parse(stdout.slice(0, -1)) as unknown,
    catch: () =>
      protocolError(
        endpoint,
        operation,
        "malformed-response",
        "remote Station API returned invalid JSON",
      ),
  }).pipe(
    Effect.flatMap((raw) => {
      const decoded = decodeStationControlEnvelope(raw);
      return Either.isRight(decoded)
        ? Effect.succeed(decoded.right)
        : Effect.fail(
            protocolError(
              endpoint,
              operation,
              "malformed-response",
              "remote Station API response violates the control contract",
            ),
          );
    }),
  );
};

const requireMatchingResponse = (
  endpoint: SshEndpoint,
  request: StationApiRequest,
  response: StationApiResponse,
): Effect.Effect<StationApiResponse, StationRemoteProtocolError> => {
  if (response.op !== request.op) {
    return Effect.fail(
      protocolError(
        endpoint,
        request.op,
        "operation-mismatch",
        `remote Station API returned ${response.op} for ${request.op}`,
      ),
    );
  }

  switch (request.op) {
    case "status":
      return Effect.succeed(response);
    case "pair":
      return response.op === "pair" &&
          response.commandCenterInstallationId ===
            request.commandCenterInstallationId &&
          response.stationInstallationId === request.stationInstallationId
        ? Effect.succeed(response)
        : Effect.fail(
            protocolError(
              endpoint,
              request.op,
              "identity-mismatch",
              "remote pair response changed an installation identity",
            ),
          );
    case "configure":
      return response.op === "configure" &&
          response.installationId === request.installationId
        ? Effect.succeed(response)
        : Effect.fail(
            protocolError(
              endpoint,
              request.op,
              "identity-mismatch",
              "remote configure response changed the installation identity",
            ),
          );
    case "project":
      return response.op === "project" &&
          response.stationInstallationId === request.stationInstallationId
        ? Effect.succeed(response)
        : Effect.fail(
            protocolError(
              endpoint,
              request.op,
              "identity-mismatch",
              "remote project response changed the Station identity",
            ),
          );
    case "report":
      return response.op === "report" &&
          response.stationInstallationId === request.stationInstallationId
        ? Effect.succeed(response)
        : Effect.fail(
            protocolError(
              endpoint,
              request.op,
              "identity-mismatch",
              "remote report response changed the Station identity",
            ),
          );
  }
};

const responseFromEnvelope = (
  endpoint: SshEndpoint,
  request: StationApiRequest,
  envelope: StationControlEnvelope,
): Effect.Effect<
  StationApiResponse,
  StationRemoteProtocolError | StationRemoteRejectedError
> =>
  envelope.ok
    ? requireMatchingResponse(endpoint, request, envelope.response)
    : Effect.fail(
        StationRemoteRejectedError.make({
          endpoint,
          operation: request.op,
          code: envelope.error.code,
          message: envelope.error.message,
          retryable: envelope.error.retryable,
        }),
      );

const invokeRemote = (
  ssh: Context.Tag.Service<typeof SshTransport>,
  endpoint: SshEndpoint,
  request: StationApiRequest,
): Effect.Effect<StationApiResponse, StationRemoteApiError> =>
  Effect.gen(function* () {
    // Resolve the current host first. No Station frame is sent until a closed
    // platform witness selects one immutable packaged executable.
    const platform = yield* resolveRemotePackagedPlatform(ssh, endpoint);
    const command = yield* remoteVellumStation(platform);
    const bytes = yield* encodeRequest(endpoint, request);
    const outcome = yield* ssh
      .transfer(
        sharedStream(endpoint, command, "agent"),
        Stream.fromIterable(inputChunks(bytes)),
        STATION_REMOTE_TRANSFER_TIMEOUT_MS,
      )
      .pipe(Effect.either);

    if (Either.isLeft(outcome)) {
      const error = outcome.left;
      if (error instanceof SshTransferExitError) {
        const envelope = yield* decodeEnvelopeOutput(
          endpoint,
          request.op,
          error.stdout,
        ).pipe(
          Effect.catchTag("StationRemoteProtocolError", () =>
            StationRemoteExecutionError.make({
              endpoint,
              operation: request.op,
              exitCode: error.code,
              message:
                "remote vellum-station command failed without a valid error envelope",
            })
          ),
        );
        if (envelope.ok) {
          return yield* protocolError(
            endpoint,
            request.op,
            "unexpected-success-exit",
            "remote Station API returned success with a non-zero exit",
          );
        }
        return yield* StationRemoteRejectedError.make({
          endpoint,
          operation: request.op,
          code: envelope.error.code,
          message: envelope.error.message,
          retryable: envelope.error.retryable,
        });
      }
      return yield* Effect.fail(error);
    }

    const envelope = yield* decodeEnvelopeOutput(
      endpoint,
      request.op,
      outcome.right.stdout,
    );
    return yield* responseFromEnvelope(endpoint, request, envelope);
  }).pipe(Effect.withSpan(`station.remote.${request.op}`));

const impossibleResponse = (
  endpoint: SshEndpoint,
  operation: StationOperation,
): StationRemoteProtocolError =>
  protocolError(
    endpoint,
    operation,
    "operation-mismatch",
    "remote Station API response escaped operation correlation",
  );

export class StationRemoteApiClient extends Context.Tag(
  "@vellum/StationRemoteApiClient",
)<
  StationRemoteApiClient,
  {
    readonly status: (
      endpoint: SshEndpoint,
    ) => Effect.Effect<StatusResponse, StationRemoteApiError>;
    readonly pair: (
      endpoint: SshEndpoint,
      request: PairRequest,
    ) => Effect.Effect<PairResponse, StationRemoteApiError>;
    readonly configure: (
      endpoint: SshEndpoint,
      request: ConfigureRequest,
    ) => Effect.Effect<ConfigureResponse, StationRemoteApiError>;
    readonly project: (
      endpoint: SshEndpoint,
      request: ProjectRequest,
    ) => Effect.Effect<ProjectResponse, StationRemoteApiError>;
    readonly report: (
      endpoint: SshEndpoint,
      request: ReportRequest,
    ) => Effect.Effect<ReportResponse, StationRemoteApiError>;
  }
>() {}

export const makeStationRemoteApiClient = (
  ssh: Context.Tag.Service<typeof SshTransport>,
): Context.Tag.Service<typeof StationRemoteApiClient> => {
  const status = Effect.fn("StationRemoteApiClient.status")(
    (endpoint: SshEndpoint) =>
      invokeRemote(
        ssh,
        endpoint,
        StatusRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "status",
        }),
      ).pipe(
        Effect.flatMap((response) =>
          response.op === "status"
            ? Effect.succeed(response)
            : Effect.fail(impossibleResponse(endpoint, "status"))
        ),
      ),
  );
  const pair = Effect.fn("StationRemoteApiClient.pair")(
    (endpoint: SshEndpoint, request: PairRequest) =>
      invokeRemote(ssh, endpoint, request).pipe(
        Effect.flatMap((response) =>
          response.op === "pair"
            ? Effect.succeed(response)
            : Effect.fail(impossibleResponse(endpoint, "pair"))
        ),
      ),
  );
  const configure = Effect.fn("StationRemoteApiClient.configure")(
    (endpoint: SshEndpoint, request: ConfigureRequest) =>
      invokeRemote(ssh, endpoint, request).pipe(
        Effect.flatMap((response) =>
          response.op === "configure"
            ? Effect.succeed(response)
            : Effect.fail(impossibleResponse(endpoint, "configure"))
        ),
      ),
  );
  const project = Effect.fn("StationRemoteApiClient.project")(
    (endpoint: SshEndpoint, request: ProjectRequest) =>
      invokeRemote(ssh, endpoint, request).pipe(
        Effect.flatMap((response) =>
          response.op === "project"
            ? Effect.succeed(response)
            : Effect.fail(impossibleResponse(endpoint, "project"))
        ),
      ),
  );
  const report = Effect.fn("StationRemoteApiClient.report")(
    (endpoint: SshEndpoint, request: ReportRequest) =>
      invokeRemote(ssh, endpoint, request).pipe(
        Effect.flatMap((response) =>
          response.op === "report"
            ? Effect.succeed(response)
            : Effect.fail(impossibleResponse(endpoint, "report"))
        ),
      ),
  );

  return StationRemoteApiClient.of({
    status,
    pair,
    configure,
    project,
    report,
  });
};

export const StationRemoteApiClientLive = Layer.effect(
  StationRemoteApiClient,
  Effect.map(SshTransport, makeStationRemoteApiClient),
);
