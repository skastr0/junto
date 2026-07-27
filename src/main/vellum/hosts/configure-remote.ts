import type { Context } from "effect";
import { Effect, Either, Schema } from "effect";
import {
  ConfigureRequest,
  InstallationId,
  PairRequest,
  RemoteConfiguration,
  STATION_API_PROTOCOL,
  type ConfigureResponse,
} from "@shared/station-api";
import type { StationBrowserPinnedTrustRecord } from "@shared/station-browser";
import type { StationSettings } from "@shared/settings";
import {
  planRemoteStationConfig,
  type RemoteStationConfigInput,
} from "@shared/remote-station-config";
import type { RemoteHost } from "@shared/remote-hosts";
import { hermesKeyFor, RemoteHostsError } from "@shared/remote-hosts";
import { parseSshEndpoint } from "../ssh/domain";
import { SshTransport } from "../ssh/service";
import {
  makeStationRemoteApiClient,
  type StationRemoteApiError,
  StationRemoteApiClient,
} from "../station/remote-client";

type Ssh = Context.Tag.Service<typeof SshTransport>;
export type StationRemote = Context.Tag.Service<
  typeof StationRemoteApiClient
>;

export type ConfigureRemoteOptions = {
  /** Durable identity of this Command Center's SQLite installation. */
  readonly commandCenterInstallationId: typeof InstallationId.Type;
  /** Operator-facing route back to the Command Center. */
  readonly commandCenterRef: string;
  /** Version of the Command Center initiating the pairing ceremony. */
  readonly appVersion: string;
  /**
   * Public trust projected from Command Center custody. Private key material
   * never enters this contract.
   */
  readonly browserTrust: StationBrowserPinnedTrustRecord;
  readonly supervisedPreferred?: boolean;
};

export type ConfigureRemoteResult = {
  readonly ok: boolean;
  readonly detail: string;
  readonly station?: StationSettings;
  readonly stationInstallationId?: typeof InstallationId.Type;
  readonly configuredAt?: string;
  readonly code?: "io" | "validation" | "not_found" | "conflict";
  readonly message?: string;
};

const remoteErrorCode = (
  error: StationRemoteApiError,
): "io" | "validation" | "conflict" => {
  if (error._tag === "RemotePlatformProbeError") return "validation";
  if (error._tag === "StationRemoteRejectedError") {
    if (error.code === "state_conflict") return "conflict";
    if (
      error.code === "protocol_error" ||
      error.code === "request_rejected" ||
      error.code === "integrity_error"
    ) {
      return "validation";
    }
  }
  if (error._tag === "StationRemoteProtocolError") return "validation";
  return "io";
};

const remoteErrorMessage = (error: StationRemoteApiError): string => {
  switch (error._tag) {
    case "RemotePlatformProbeError":
    case "StationRemoteRejectedError":
    case "StationRemoteProtocolError":
    case "StationRemoteExecutionError":
    case "SshInputError":
    case "SshSpawnError":
    case "SshTimeoutError":
    case "SshExitError":
      return error.message;
    default:
      return String(error);
  }
};

const decodeRequest = <A, I>(
  schema: Schema.Schema<A, I>,
  value: unknown,
  operation: string,
): Effect.Effect<A, RemoteHostsError> => {
  const decoded = Schema.decodeUnknownEither(schema)(value);
  return Either.isRight(decoded)
    ? Effect.succeed(decoded.right)
    : Effect.fail(
        new RemoteHostsError(
          "validation",
          `${operation} request is invalid: ${decoded.left.message}`,
        ),
      );
};

const stationSettingsFromResponse = (
  response: ConfigureResponse,
): Effect.Effect<StationSettings, RemoteHostsError> => {
  if (response.configuration.role !== "remote") {
    return Effect.fail(
      new RemoteHostsError(
        "conflict",
        "Remote Station API acknowledged a Command Center configuration",
      ),
    );
  }
  return Effect.succeed({
    role: "remote",
    hostId: response.configuration.hostId,
    agentHostId: response.configuration.agentHostId,
    commandCenterRef: response.configuration.commandCenterRef,
    supervisedPreferred: response.configuration.supervisedPreferred,
  });
};

const sameHostRegistration = (
  left: RemoteHost,
  right: RemoteHost,
): boolean =>
  left.id === right.id &&
  left.label === right.label &&
  left.kind === right.kind &&
  left.endpoint === right.endpoint &&
  left.hermesId === right.hermesId &&
  left.appearance?.color === right.appearance?.color &&
  left.appearance?.glyph === right.appearance?.glyph &&
  left.capabilities.length === right.capabilities.length &&
  left.capabilities.every((capability) =>
    right.capabilities.includes(capability)
  );

/**
 * Pair and configure one registered Remote through its app-owned Station API.
 *
 * This is the only durable configuration lane. The Command Center never reads
 * or writes a remote settings file and never carries seal-era topology state.
 */
export const configureRemoteHost = (
  ssh: Ssh,
  host: RemoteHost,
  options: ConfigureRemoteOptions,
  remote: StationRemote = makeStationRemoteApiClient(ssh),
): Effect.Effect<ConfigureRemoteResult, RemoteHostsError> =>
  Effect.gen(function* () {
    if (host.kind !== "remote") {
      return yield* Effect.fail(
        new RemoteHostsError(
          "validation",
          `host ${host.id} is local — only remote hosts can be configured as Remote`,
        ),
      );
    }
    if (!host.endpoint) {
      return yield* Effect.fail(
        new RemoteHostsError(
          "validation",
          `remote host ${host.id} missing endpoint`,
        ),
      );
    }

    const endpoint = yield* parseSshEndpoint(host.endpoint).pipe(
      Effect.mapError(
        (error) =>
          new RemoteHostsError(
            "validation",
            `Invalid endpoint: ${error.message}`,
          ),
      ),
    );

    const planInput: RemoteStationConfigInput = {
      remoteHostId: host.id,
      agentHostId: hermesKeyFor(host),
      commandCenterRef: options.commandCenterRef,
      supervisedPreferred: options.supervisedPreferred ?? true,
    };
    const plan = yield* Effect.try({
      try: () => planRemoteStationConfig(planInput),
      catch: (error) =>
        new RemoteHostsError(
          "validation",
          error instanceof Error ? error.message : String(error),
        ),
    });

    const status = yield* remote.status(endpoint).pipe(
      Effect.mapError(
        (error) =>
          new RemoteHostsError(
            remoteErrorCode(error),
            `${host.label}: ${remoteErrorMessage(error)}`,
          ),
      ),
    );

    const pairRequest = yield* decodeRequest(
      PairRequest,
      {
        protocol: STATION_API_PROTOCOL,
        op: "pair",
        commandCenterInstallationId:
          options.commandCenterInstallationId,
        stationInstallationId: status.installationId,
        stationLabel: host.label,
        appVersion: options.appVersion,
      },
      "Station pair",
    );
    yield* remote.pair(endpoint, pairRequest).pipe(
      Effect.mapError(
        (error) =>
          new RemoteHostsError(
            remoteErrorCode(error),
            `${host.label}: ${remoteErrorMessage(error)}`,
          ),
      ),
    );

    const configuration = yield* decodeRequest(
      RemoteConfiguration,
      {
        role: "remote",
        hostId: plan.station.hostId,
        agentHostId: plan.station.agentHostId,
        commandCenterInstallationId:
          options.commandCenterInstallationId,
        commandCenterRef: plan.station.commandCenterRef,
        supervisedPreferred: plan.station.supervisedPreferred,
        browserTrust: options.browserTrust,
      },
      "Remote configuration",
    );
    const configureRequest = yield* decodeRequest(
      ConfigureRequest,
      {
        protocol: STATION_API_PROTOCOL,
        op: "configure",
        installationId: status.installationId,
        configuration,
        host: {
          ...host,
          kind: "remote",
          endpoint: host.endpoint,
        },
      },
      "Station configure",
    );
    const configured = yield* remote
      .configure(endpoint, configureRequest)
      .pipe(
        Effect.mapError(
          (error) =>
            new RemoteHostsError(
              remoteErrorCode(error),
              `${host.label}: ${remoteErrorMessage(error)}`,
            ),
        ),
      );
    const station = yield* stationSettingsFromResponse(configured);

    if (
      station.hostId !== plan.station.hostId ||
      station.agentHostId !== plan.station.agentHostId ||
      station.commandCenterRef !== plan.station.commandCenterRef ||
      station.supervisedPreferred !==
        plan.station.supervisedPreferred ||
      !sameHostRegistration(configured.host, host)
    ) {
      return yield* Effect.fail(
        new RemoteHostsError(
          "conflict",
          `${host.label}: Station API acknowledged a different Remote configuration`,
        ),
      );
    }

    return {
      ok: true,
      detail: `${host.label} (${host.endpoint}): configured through Station API (${plan.summary})`,
      station,
      stationInstallationId: status.installationId,
      configuredAt: configured.configuredAt,
    } satisfies ConfigureRemoteResult;
  }).pipe(Effect.withSpan("hosts.configure-remote"));
