import { Effect, Either, Schema } from "effect";
import {
  ConfigureRequest,
  InstallationId,
  PairRequest,
  RemoteConfiguration,
  RemoteHostRegistration,
  STATION_API_PROTOCOL,
  type ConfigureResponse,
} from "@shared/station-api";
import { stationControlErr } from "@shared/station-api-envelope";
import { CURRENT_STATION_PROTOCOL_SUPPORT } from "@shared/station-protocol";
import type { StationSettings } from "@shared/settings";
import {
  planRemoteStationConfig,
  type RemoteStationConfigInput,
} from "@shared/remote-station-config";
import type { RemoteHost } from "@shared/remote-hosts";
import { hermesKeyFor, RemoteHostsError } from "@shared/remote-hosts";
import { parseHostSshRoute } from "../ssh/domain";
import { resolveRemotePackagedPlatform } from "../ssh/read-commands";
import { SshTransport } from "../ssh/service";
import { bootstrapOpenSshStationStatus } from "../station/openssh-bootstrap";
import {
  admitEnrolledOpenSshStationPeer,
  makeOpenSshStationPeerExchange,
} from "../station/openssh-peer-exchange";
import { CURRENT_STATE_SCHEMA_VERSION } from "../state/migrations";

type Ssh = typeof SshTransport.Service;

export type ConfigureRemoteOptions = {
  /** Durable identity of this Command Center's SQLite installation. */
  readonly commandCenterInstallationId: typeof InstallationId.Type;
  /** Version of the Command Center initiating the pairing ceremony. */
  readonly appVersion: string;
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

const taggedError = (
  error: unknown,
): {
  readonly _tag?: string;
  readonly code?: string;
  readonly reason?: string;
  readonly message?: string;
} =>
  typeof error === "object" && error !== null
    ? error as {
        readonly _tag?: string;
        readonly code?: string;
        readonly reason?: string;
        readonly message?: string;
      }
    : {};

const stationErrorCode = (
  error: unknown,
): "io" | "validation" | "conflict" => {
  const tagged = taggedError(error);
  if (tagged._tag === "RemotePlatformProbeError") return "validation";
  if (tagged._tag === "StationPeerRejectedError") {
    if (tagged.code === "state_conflict") return "conflict";
    if (
      tagged.code === "protocol_error" ||
      tagged.code === "request_rejected" ||
      tagged.code === "integrity_error" ||
      tagged.code === "authorization_denied"
    ) {
      return "validation";
    }
  }
  if (
    tagged._tag === "StationPeerSessionProtocolError" ||
    tagged._tag === "StationPeerSessionCapacityError" ||
    tagged._tag === "SshInputError"
  ) {
    return "validation";
  }
  if (tagged._tag === "StationSessionTransportError") {
    return tagged.reason === "malformed-frame" ||
        tagged.reason === "frame-too-large" ||
        tagged.reason === "queue-capacity"
      ? "validation"
      : "io";
  }
  if (tagged._tag === "OpenSshStationBootstrapError") {
    return tagged.reason === "timeout" ? "io" : "validation";
  }
  return "io";
};

const stationErrorMessage = (error: unknown): string =>
  taggedError(error).message ??
  (error instanceof Error ? error.message : String(error));

const mapStationError = (
  host: RemoteHost,
  error: unknown,
): RemoteHostsError =>
  new RemoteHostsError(
    stationErrorCode(error),
    `${host.label}: ${stationErrorMessage(error)}`,
  );

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
    supervisedPreferred: response.configuration.supervisedPreferred,
  });
};

const remoteHostRegistration = (
  host: RemoteHost,
): typeof RemoteHostRegistration.Type =>
  Schema.decodeUnknownSync(RemoteHostRegistration)({
    id: host.id,
    label: host.label,
    kind: "remote",
    capabilities: host.capabilities,
    ...(host.hermesId === undefined ? {} : { hermesId: host.hermesId }),
  });

const sameHostRegistration = (
  left: typeof RemoteHostRegistration.Type,
  right: typeof RemoteHostRegistration.Type,
): boolean =>
  left.id === right.id &&
  left.label === right.label &&
  left.kind === right.kind &&
  left.hermesId === right.hermesId &&
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
    if (!host.sshEndpoint) {
      return yield* Effect.fail(
        new RemoteHostsError(
          "validation",
          `remote host ${host.id} missing endpoint`,
        ),
      );
    }

    const endpoint = yield* parseHostSshRoute(host).pipe(
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

    const platform = yield* resolveRemotePackagedPlatform(ssh, endpoint).pipe(
      Effect.mapError((error) => mapStationError(host, error)),
    );
    const status = yield* bootstrapOpenSshStationStatus(
      ssh,
      endpoint,
      platform,
    ).pipe(
      Effect.mapError((error) => mapStationError(host, error)),
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
    const configuration = yield* decodeRequest(
      RemoteConfiguration,
      {
        role: "remote",
        hostId: plan.station.hostId,
        agentHostId: plan.station.agentHostId,
        commandCenterInstallationId:
          options.commandCenterInstallationId,
        supervisedPreferred: plan.station.supervisedPreferred,
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
        host: remoteHostRegistration(host),
      },
      "Station configure",
    );
    const route = admitEnrolledOpenSshStationPeer({
      peerInstallationId: status.installationId,
      endpoint,
      platform,
    });
    const exchange = makeOpenSshStationPeerExchange(
      ssh,
      options.commandCenterInstallationId,
      {
        appVersion: options.appVersion,
        stateSchemaVersion: CURRENT_STATE_SCHEMA_VERSION,
        support: CURRENT_STATION_PROTOCOL_SUPPORT,
      },
    );
    const configured = yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* exchange.open(
          route,
          () =>
            Effect.succeed(
              stationControlErr(
                "authorization_denied",
                "Remote reports are not admitted during enrollment",
                false,
              ),
            ),
        );
        yield* session.request(pairRequest);
        return yield* session.request(configureRequest);
      }),
    ).pipe(
      Effect.mapError((error) => mapStationError(host, error)),
    );
    const station = yield* stationSettingsFromResponse(configured);

    if (
      station.hostId !== plan.station.hostId ||
      station.agentHostId !== plan.station.agentHostId ||
      station.supervisedPreferred !==
        plan.station.supervisedPreferred ||
      !sameHostRegistration(configured.host, remoteHostRegistration(host))
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
      detail: `${host.label} (${host.sshEndpoint}): configured through Station API (${plan.summary})`,
      station,
      stationInstallationId: status.installationId,
      configuredAt: configured.configuredAt,
    } satisfies ConfigureRemoteResult;
  }).pipe(Effect.withSpan("hosts.configure-remote"));
