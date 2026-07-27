import { createHash, randomUUID } from "node:crypto";
import { Context, Effect, Either, Layer, Schema } from "effect";
import {
  ConfigureResponse,
  DisplayTimestamp,
  InstallationId,
  LogicalSequence,
  PairResponse,
  ProjectResponse,
  STATION_API_MAX_ACKS_PER_REPORT,
  STATION_API_MAX_EVENTS_PER_REPORT,
  STATION_API_PROTOCOL,
  StationConfiguration,
  StationEvent,
  StationEventAck,
  StationProjectionBody,
  StationProjectionReference,
  StationSha256,
  coalesceStationEvents,
  compareLogicalSequence,
  decideAckAdvance,
  decideProjectionInstall,
  type AckAdvanceDecision,
  type ConfigureRequest,
  type ConfigureResponse as ConfigureResponseValue,
  type InstallationId as InstallationIdValue,
  type LogicalSequence as LogicalSequenceValue,
  type PairRequest,
  type PairResponse as PairResponseValue,
  type ProjectRequest,
  type ProjectResponse as ProjectResponseValue,
  type StationConfiguration as StationConfigurationValue,
  type StationEvent as StationEventValue,
  type StationEventAck as StationEventAckValue,
  type StationProjectionBody as StationProjectionBodyValue,
  type StationProjectionReference as StationProjectionReferenceValue,
  type StationSha256 as StationSha256Value,
} from "@shared/station-api";
import {
  canonicalStationBrowserJson,
  decodeStationBrowserPinnedTrustRecord,
  type StationBrowserPinnedTrustRecord,
} from "@shared/station-browser";
import {
  StationSettings,
  type StationSettings as StationSettingsValue,
} from "@shared/settings";
import {
  installStationBrowserPinnedRecord,
  StationBrowserTrustError,
} from "../browser/station-trust";
import {
  StateEngine,
  type StateEngineError,
  type StateReader,
  type StateRow,
  type StateWriter,
} from "../state/service";

export class StationPersistenceError extends Schema.TaggedError<StationPersistenceError>()(
  "StationPersistenceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}

export class StationIdentityMismatchError extends Schema.TaggedError<StationIdentityMismatchError>()(
  "StationIdentityMismatchError",
  {
    operation: Schema.String,
    localInstallationId: InstallationId,
    receivedInstallationId: InstallationId,
  },
) {}

export class StationPairingConflictError extends Schema.TaggedError<StationPairingConflictError>()(
  "StationPairingConflictError",
  {
    admittedCommandCenterInstallationId: InstallationId,
    rejectedCommandCenterInstallationId: InstallationId,
  },
) {}

export class StationSelfPairingError extends Schema.TaggedError<StationSelfPairingError>()(
  "StationSelfPairingError",
  {
    installationId: InstallationId,
  },
) {}

export class StationConfigurationError extends Schema.TaggedError<StationConfigurationError>()(
  "StationConfigurationError",
  {
    reason: Schema.Literal(
      "pairing-required",
      "command-center-mismatch",
      "settings-topology-invalid",
    ),
    message: Schema.String,
  },
) {}

export class StationProjectionIntegrityError extends Schema.TaggedError<StationProjectionIntegrityError>()(
  "StationProjectionIntegrityError",
  {
    generation: LogicalSequence,
    declaredContentSha256: StationSha256,
    actualContentSha256: StationSha256,
  },
) {}

export class StationEventIntegrityError extends Schema.TaggedError<StationEventIntegrityError>()(
  "StationEventIntegrityError",
  {
    home: InstallationId,
    sequence: LogicalSequence,
    declaredContentSha256: StationSha256,
    actualContentSha256: StationSha256,
  },
) {}

export class StationEventIdentityConflictError extends Schema.TaggedError<StationEventIdentityConflictError>()(
  "StationEventIdentityConflictError",
  {
    home: InstallationId,
    sequence: LogicalSequence,
    admittedContentSha256: StationSha256,
    rejectedContentSha256: StationSha256,
  },
) {}

export class StationCursorError extends Schema.TaggedError<StationCursorError>()(
  "StationCursorError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export class StationMetadataError extends Schema.TaggedError<StationMetadataError>()(
  "StationMetadataError",
  {
    operation: Schema.String,
    field: Schema.String,
    message: Schema.String,
  },
) {}

export type StationRepositoryError =
  | StationPersistenceError
  | StationIdentityMismatchError
  | StationPairingConflictError
  | StationSelfPairingError
  | StationConfigurationError
  | StationProjectionIntegrityError
  | StationEventIntegrityError
  | StationEventIdentityConflictError
  | StationCursorError
  | StationMetadataError
  | StationBrowserTrustError;

export type StationPairing = {
  readonly commandCenterInstallationId: InstallationIdValue;
  readonly stationLabel: string;
  readonly appVersion: string;
  readonly pairedAt: string;
};

export type StationProjection = StationProjectionBodyValue & {
  readonly receivedAt: string;
};

export type StationConfigurationRecord = {
  readonly configuration: StationConfigurationValue;
  readonly configuredAt: string;
};

export type StationPeerAcknowledgement = {
  readonly peerInstallationId: InstallationIdValue;
  readonly acknowledgement: StationEventAckValue;
};

export type StationStatusFacts = {
  readonly installationId: InstallationIdValue;
  readonly pairing?: StationPairing;
  readonly configuration?: StationConfigurationValue;
  readonly configuredAt?: string;
  readonly projection?: StationProjectionReferenceValue;
  readonly receivedThrough: ReadonlyArray<StationEventAckValue>;
  readonly peerAcknowledgedThrough: ReadonlyArray<StationPeerAcknowledgement>;
};

export type AppendStationEvent = Pick<
  StationEventValue,
  "kind" | "body" | "originAt"
> & {
  readonly receivedAt?: string;
};

export type AcceptInboundResult = {
  readonly accepted: number;
  readonly idempotent: number;
  readonly acknowledge: ReadonlyArray<StationEventAckValue>;
};

export class StationRepository extends Context.Tag("@vellum/StationRepository")<
  StationRepository,
  {
    readonly installationId: Effect.Effect<
      InstallationIdValue,
      StationRepositoryError
    >;
    readonly pairing: Effect.Effect<
      StationPairing | undefined,
      StationRepositoryError
    >;
    readonly configuration: Effect.Effect<
      StationConfigurationRecord | undefined,
      StationRepositoryError
    >;
    readonly projection: Effect.Effect<
      StationProjection | undefined,
      StationRepositoryError
    >;
    readonly pair: (
      request: PairRequest,
      pairedAt?: string,
    ) => Effect.Effect<PairResponseValue, StationRepositoryError>;
    readonly configure: (
      request: ConfigureRequest,
      configuredAt?: string,
    ) => Effect.Effect<ConfigureResponseValue, StationRepositoryError>;
    readonly installProjection: (
      request: ProjectRequest,
      receivedAt?: string,
    ) => Effect.Effect<ProjectResponseValue, StationRepositoryError>;
    readonly appendOutbound: (
      input: AppendStationEvent,
    ) => Effect.Effect<StationEventValue, StationRepositoryError>;
    readonly eventsAfter: (
      home: InstallationIdValue,
      through: LogicalSequenceValue,
      limit?: number,
    ) => Effect.Effect<
      ReadonlyArray<StationEventValue>,
      StationRepositoryError
    >;
    readonly acceptInbound: (
      events: ReadonlyArray<StationEventValue>,
      receivedAt?: string,
    ) => Effect.Effect<AcceptInboundResult, StationRepositoryError>;
    readonly advancePeerAcks: (
      peerInstallationId: InstallationIdValue,
      acknowledgements: ReadonlyArray<StationEventAckValue>,
      acknowledgedAt?: string,
    ) => Effect.Effect<
      ReadonlyArray<AckAdvanceDecision>,
      StationRepositoryError
    >;
    readonly statusFacts: Effect.Effect<
      StationStatusFacts,
      StationRepositoryError
    >;
  }
>() {}

type InstallationRow = StateRow & {
  readonly installation_id: string;
  readonly created_at: string;
};

type PairingRow = StateRow & {
  readonly command_center_installation_id: string;
  readonly station_label: string;
  readonly app_version: string;
  readonly paired_at: string;
};

type ConfigurationRow = StateRow & {
  readonly role: string;
  readonly host_id: string;
  readonly agent_host_id: string | null;
  readonly command_center_installation_id: string | null;
  readonly command_center_ref: string | null;
  readonly supervised_preferred: number;
  readonly configured_at: string;
};

type ProjectionRow = StateRow & {
  readonly generation: string;
  readonly body: string;
  readonly content_sha256: string;
  readonly created_at: string;
  readonly received_at: string;
};

type EventRow = StateRow & {
  readonly home: string;
  readonly sequence: string;
  readonly direction: string;
  readonly kind: string;
  readonly body: string;
  readonly content_sha256: string;
  readonly origin_at: string;
  readonly received_at: string;
};

type CursorRow = StateRow & {
  readonly home: string;
  readonly through_sequence: string;
};

type PeerAckRow = CursorRow & {
  readonly peer_installation_id: string;
};

type PinnedTrustRow = StateRow & {
  readonly generation: number;
  readonly key_id: string;
  readonly origin_station_id: string;
  readonly status: string;
  readonly public_key_spki: Uint8Array | null;
  readonly replaces_key_id: string | null;
  readonly updated_at: number;
};

const decodeInstallationId = Schema.decodeUnknownSync(InstallationId);
const decodeSequence = Schema.decodeUnknownSync(LogicalSequence);
const decodeHash = Schema.decodeUnknownSync(StationSha256);
const decodeTimestampEither = Schema.decodeUnknownEither(DisplayTimestamp);
const decodeConfiguration = Schema.decodeUnknownSync(StationConfiguration);
const decodeProjectionBody = Schema.decodeUnknownSync(StationProjectionBody);
const decodeProjectionReference = Schema.decodeUnknownSync(
  StationProjectionReference,
);
const decodeEvent = Schema.decodeUnknownSync(StationEvent);
const decodeAck = Schema.decodeUnknownSync(StationEventAck);
const decodeSettingsTopology = Schema.decodeUnknownEither(StationSettings);

const sha256 = (value: string): StationSha256Value =>
  decodeHash(createHash("sha256").update(value, "utf8").digest("hex"));

/** Hash of the exact complete projection body. */
export const stationProjectionContentSha256 = (
  body: string,
): StationSha256Value => sha256(body);

/**
 * Versioned canonical semantic event hash. Identity and timestamps are
 * deliberately excluded: retries may carry different receipt metadata.
 */
export const stationEventContentSha256 = (
  kind: string,
  body: string,
): StationSha256Value =>
  sha256(JSON.stringify(["vellum/station-event/v1", kind, body]));

const nowIso = (): string => new Date().toISOString();

const admitTimestamp = (
  operation: string,
  field: string,
  value: string,
): Effect.Effect<string, StationMetadataError> => {
  const decoded = decodeTimestampEither(value);
  return Either.isRight(decoded)
    ? Effect.succeed(decoded.right)
    : StationMetadataError.make({
        operation,
        field,
        message: `${field} must contain between 1 and 64 characters`,
      });
};

const persistenceError = (
  operation: string,
  error: StateEngineError,
): StationPersistenceError =>
  StationPersistenceError.make({
    operation,
    message: error.message,
    cause: error,
  });

const configureStateError = (
  error: StateEngineError,
): StationPersistenceError | StationBrowserTrustError =>
  error.cause instanceof StationBrowserTrustError
    ? error.cause
    : persistenceError("configure", error);

const selectInstallation = (
  reader: StateReader,
): InstallationRow | undefined =>
  reader.get<InstallationRow>(
    `SELECT installation_id, created_at
       FROM station_installation
      WHERE singleton = 1`,
  );

const selectPairing = (reader: StateReader): PairingRow | undefined =>
  reader.get<PairingRow>(
    `SELECT
       command_center_installation_id,
       station_label,
       app_version,
       paired_at
     FROM station_pairing
     WHERE singleton = 1`,
  );

const selectConfiguration = (
  reader: StateReader,
): ConfigurationRow | undefined =>
  reader.get<ConfigurationRow>(
    `SELECT
       role,
       host_id,
       agent_host_id,
       command_center_installation_id,
       command_center_ref,
       supervised_preferred,
       configured_at
     FROM station_configuration
     WHERE singleton = 1`,
  );

const selectProjection = (
  reader: StateReader,
): ProjectionRow | undefined =>
  reader.get<ProjectionRow>(
    `SELECT
       generation,
       body,
       content_sha256,
       created_at,
       received_at
     FROM station_projection
     WHERE singleton = 1`,
  );

const selectLatestPinnedTrust = (
  reader: StateReader,
): StationBrowserPinnedTrustRecord | undefined => {
  const row = reader.get<PinnedTrustRow>(
    `SELECT
       generation,
       key_id,
       origin_station_id,
       status,
       public_key_spki,
       replaces_key_id,
       updated_at
     FROM browser_pinned_origin_trust
     ORDER BY generation DESC
     LIMIT 1`,
  );
  if (row === undefined) return undefined;
  return decodeStationBrowserPinnedTrustRecord({
    version: 1,
    generation: row.generation,
    keyId: row.key_id,
    originStationId: row.origin_station_id,
    status: row.status,
    publicKeySpki:
      row.public_key_spki === null
        ? null
        : Buffer.from(row.public_key_spki).toString("base64"),
    replacesKeyId: row.replaces_key_id,
    updatedAt: row.updated_at,
  });
};

const pairingFromRow = (row: PairingRow): StationPairing => ({
  commandCenterInstallationId: decodeInstallationId(
    row.command_center_installation_id,
  ),
  stationLabel: row.station_label,
  appVersion: row.app_version,
  pairedAt: row.paired_at,
});

const configurationFromRow = (
  row: ConfigurationRow,
  browserTrust?: StationBrowserPinnedTrustRecord,
): StationConfigurationRecord => ({
  configuration:
    row.role === "command-center"
      ? decodeConfiguration({
          role: "command-center",
          hostId: row.host_id,
          supervisedPreferred: row.supervised_preferred === 1,
        })
      : decodeConfiguration({
          role: "remote",
          hostId: row.host_id,
          agentHostId: row.agent_host_id,
          commandCenterInstallationId:
            row.command_center_installation_id,
          commandCenterRef: row.command_center_ref,
          supervisedPreferred: row.supervised_preferred === 1,
          ...(browserTrust === undefined ? {} : { browserTrust }),
        }),
  configuredAt: row.configured_at,
});

const projectionFromRow = (row: ProjectionRow): StationProjection =>
  ({
    ...decodeProjectionBody({
      scope: "full",
      generation: row.generation,
      body: row.body,
      contentSha256: row.content_sha256,
      createdAt: row.created_at,
    }),
    receivedAt: row.received_at,
  });

const projectionReferenceFromRow = (
  row: ProjectionRow,
): StationProjectionReferenceValue =>
  decodeProjectionReference({
    generation: row.generation,
    contentSha256: row.content_sha256,
    receivedAt: row.received_at,
  });

const eventFromRow = (row: EventRow): StationEventValue =>
  decodeEvent({
    identity: {
      home: row.home,
      sequence: row.sequence,
    },
    kind: row.kind,
    body: row.body,
    contentSha256: row.content_sha256,
    originAt: row.origin_at,
    receivedAt: row.received_at,
  });

const ackFromRow = (row: CursorRow): StationEventAckValue =>
  decodeAck({
    home: row.home,
    through: row.through_sequence,
  });

const sameBrowserTrust = (
  left: StationBrowserPinnedTrustRecord | undefined,
  right: StationBrowserPinnedTrustRecord | undefined,
): boolean =>
  left === undefined
    ? right === undefined
    : right !== undefined &&
      canonicalStationBrowserJson(left) ===
        canonicalStationBrowserJson(right);

const sameConfiguration = (
  left: StationConfigurationValue,
  right: StationConfigurationValue,
): boolean => {
  if (left.role !== right.role) return false;
  if (left.role === "command-center" && right.role === "command-center") {
    return (
      left.hostId === right.hostId &&
      left.supervisedPreferred === right.supervisedPreferred
    );
  }
  if (left.role === "remote" && right.role === "remote") {
    return (
      left.hostId === right.hostId &&
      left.agentHostId === right.agentHostId &&
      left.commandCenterInstallationId ===
        right.commandCenterInstallationId &&
      left.commandCenterRef === right.commandCenterRef &&
      left.supervisedPreferred === right.supervisedPreferred &&
      sameBrowserTrust(left.browserTrust, right.browserTrust)
    );
  }
  return false;
};

const withCurrentBrowserTrust = (
  configuration: StationConfigurationValue,
  browserTrust: StationBrowserPinnedTrustRecord | undefined,
): StationConfigurationValue =>
  configuration.role === "remote"
    ? decodeConfiguration({
        ...configuration,
        ...(browserTrust === undefined ? {} : { browserTrust }),
      })
    : configuration;

const settingsTopologyForConfiguration = (
  configuration: StationConfigurationValue,
): Either.Either<StationSettingsValue, StationConfigurationError> => {
  const decoded = decodeSettingsTopology(
    configuration.role === "remote"
      ? {
          role: "remote",
          hostId: configuration.hostId,
          agentHostId: configuration.agentHostId,
          commandCenterRef: configuration.commandCenterRef,
          supervisedPreferred: configuration.supervisedPreferred,
        }
      : {
          role: "command-center",
          hostId: configuration.hostId,
          commandCenterRef: "",
          supervisedPreferred: configuration.supervisedPreferred,
        },
  );
  return Either.isRight(decoded)
    ? Either.right(decoded.right)
    : Either.left(
        StationConfigurationError.make({
          reason: "settings-topology-invalid",
          message:
            "station configuration cannot be represented by protected settings topology",
        }),
      );
};

const writeSettingsTopology = (
  writer: StateWriter,
  topology: StationSettingsValue,
  updatedAt: string,
): void => {
  const body = JSON.stringify(topology);
  const current = writer.get<StateRow & { readonly body: string }>(
    `SELECT body
       FROM settings_station_topology
      WHERE singleton = 1`,
  );
  if (current?.body === body) return;
  writer.run(
    `INSERT INTO settings_station_topology(singleton, body, updated_at)
     VALUES (1, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET
       body = excluded.body,
       updated_at = excluded.updated_at`,
    [body, updatedAt],
  );
};

const writeConfiguration = (
  writer: StateWriter,
  configuration: StationConfigurationValue,
  configuredAt: string,
): void => {
  const remote =
    configuration.role === "remote" ? configuration : undefined;
  writer.run(
    `INSERT INTO station_configuration(
       singleton,
       role,
       host_id,
       agent_host_id,
       command_center_installation_id,
       command_center_ref,
       supervised_preferred,
       configured_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET
       role = excluded.role,
       host_id = excluded.host_id,
       agent_host_id = excluded.agent_host_id,
       command_center_installation_id =
         excluded.command_center_installation_id,
       command_center_ref = excluded.command_center_ref,
       supervised_preferred = excluded.supervised_preferred,
       configured_at = excluded.configured_at`,
    [
      configuration.role,
      configuration.hostId,
      remote?.agentHostId ?? null,
      remote?.commandCenterInstallationId ?? null,
      remote?.commandCenterRef ?? null,
      configuration.supervisedPreferred ? 1 : 0,
      configuredAt,
    ],
  );
};

const ensureLocalIdentity = (
  operation: string,
  local: InstallationIdValue,
  received: InstallationIdValue,
): Effect.Effect<void, StationIdentityMismatchError> =>
  local === received
    ? Effect.void
    : StationIdentityMismatchError.make({
        operation,
        localInstallationId: local,
        receivedInstallationId: received,
      });

const verifyStoredProjection = (
  row: ProjectionRow,
): Effect.Effect<void, StationProjectionIntegrityError> => {
  const declared = decodeHash(row.content_sha256);
  const actual = stationProjectionContentSha256(row.body);
  return declared === actual
    ? Effect.void
    : StationProjectionIntegrityError.make({
        generation: decodeSequence(row.generation),
        declaredContentSha256: declared,
        actualContentSha256: actual,
      });
};

const validateEventHash = (
  event: StationEventValue,
): Effect.Effect<void, StationEventIntegrityError> => {
  const actual = stationEventContentSha256(event.kind, event.body);
  return actual === event.contentSha256
    ? Effect.void
    : StationEventIntegrityError.make({
        home: event.identity.home,
        sequence: event.identity.sequence,
        declaredContentSha256: event.contentSha256,
        actualContentSha256: actual,
      });
};

const receivedCursorRows = (
  reader: StateReader,
): ReadonlyArray<CursorRow> =>
  reader.all<CursorRow>(
    `SELECT home, through_sequence
       FROM station_received_cursors
      ORDER BY home`,
  );

const peerAckRows = (
  reader: StateReader,
): ReadonlyArray<PeerAckRow> =>
  reader.all<PeerAckRow>(
    `SELECT peer_installation_id, home, through_sequence
       FROM station_peer_ack_cursors
      ORDER BY peer_installation_id, home`,
  );

export type StationRepositoryOptions = {
  readonly makeInstallationId?: () => InstallationIdValue;
  readonly now?: () => string;
};

export const makeStationRepositoryLive = (
  options: StationRepositoryOptions = {},
): Layer.Layer<
  StationRepository,
  StationPersistenceError | StationMetadataError,
  StateEngine
> =>
  Layer.effect(
    StationRepository,
    Effect.gen(function* () {
      const engine = yield* StateEngine;
      const clock = options.now ?? nowIso;
      const makeInstallationId =
        options.makeInstallationId ??
        (() => decodeInstallationId(randomUUID()));
      const installationCreatedAt = yield* admitTimestamp(
        "ensure-installation",
        "createdAt",
        clock(),
      );

      const installationId = yield* engine
        .transaction("station.ensure-installation", (writer) => {
          const existing = selectInstallation(writer);
          if (existing !== undefined) {
            return decodeInstallationId(existing.installation_id);
          }
          const created = makeInstallationId();
          writer.run(
            `INSERT INTO station_installation(
               singleton,
               installation_id,
               created_at
             ) VALUES (1, ?, ?)`,
            [created, installationCreatedAt],
          );
          return created;
        })
        .pipe(
          Effect.mapError((error) =>
            persistenceError("ensure-installation", error),
          ),
        );

      const readPairing = engine
        .read("station.pairing", (reader) => {
          const row = selectPairing(reader);
          return row === undefined ? undefined : pairingFromRow(row);
        })
        .pipe(
          Effect.mapError((error) => persistenceError("pairing", error)),
          Effect.withSpan("station-repository.pairing"),
        );

      const readConfiguration = engine
        .read("station.configuration", (reader) => {
          const row = selectConfiguration(reader);
          return row === undefined
            ? undefined
            : configurationFromRow(
                row,
                selectLatestPinnedTrust(reader),
              );
        })
        .pipe(
          Effect.mapError((error) =>
            persistenceError("configuration", error),
          ),
          Effect.withSpan("station-repository.configuration"),
        );

      const readProjection = engine
        .read("station.projection", selectProjection)
        .pipe(
          Effect.mapError((error) =>
            persistenceError("projection", error),
          ),
          Effect.flatMap((row) =>
            row === undefined
              ? Effect.succeed(undefined)
              : verifyStoredProjection(row).pipe(
                  Effect.as(projectionFromRow(row)),
                )
          ),
          Effect.withSpan("station-repository.projection"),
        );

      const pair = Effect.fn("StationRepository.pair")(
        function* (request: PairRequest, pairedAt = clock()) {
          const admittedPairedAt = yield* admitTimestamp(
            "pair",
            "pairedAt",
            pairedAt,
          );
          yield* ensureLocalIdentity(
            "pair",
            installationId,
            request.stationInstallationId,
          );
          if (
            request.commandCenterInstallationId === installationId
          ) {
            return yield* StationSelfPairingError.make({
              installationId,
            });
          }
          const decision = yield* engine
            .transaction("station.pair", (writer) => {
              const current = selectPairing(writer);
              if (current === undefined) {
                writer.run(
                  `INSERT INTO station_pairing(
                     singleton,
                     command_center_installation_id,
                     station_label,
                     app_version,
                     paired_at
                   ) VALUES (1, ?, ?, ?, ?)`,
                  [
                    request.commandCenterInstallationId,
                    request.stationLabel,
                    request.appVersion,
                    admittedPairedAt,
                  ],
                );
                return {
                  _tag: "paired" as const,
                  pairedAt: admittedPairedAt,
                };
              }
              if (
                current.command_center_installation_id !==
                request.commandCenterInstallationId
              ) {
                return {
                  _tag: "conflict" as const,
                  current: decodeInstallationId(
                    current.command_center_installation_id,
                  ),
                };
              }
              return {
                _tag: "paired" as const,
                pairedAt: current.paired_at,
              };
            })
            .pipe(
              Effect.mapError((error) =>
                persistenceError("pair", error),
              ),
            );

          if (decision._tag === "conflict") {
            return yield* StationPairingConflictError.make({
              admittedCommandCenterInstallationId: decision.current,
              rejectedCommandCenterInstallationId:
                request.commandCenterInstallationId,
            });
          }
          return PairResponse.make({
            protocol: STATION_API_PROTOCOL,
            op: "pair",
            commandCenterInstallationId:
              request.commandCenterInstallationId,
            stationInstallationId: installationId,
            pairedAt: decision.pairedAt,
          });
        },
      );

      const configure = Effect.fn("StationRepository.configure")(
        function* (request: ConfigureRequest, configuredAt = clock()) {
          const admittedConfiguredAt = yield* admitTimestamp(
            "configure",
            "configuredAt",
            configuredAt,
          );
          yield* ensureLocalIdentity(
            "configure",
            installationId,
            request.installationId,
          );
          const topology = settingsTopologyForConfiguration(
            request.configuration,
          );
          if (Either.isLeft(topology)) return yield* topology.left;
          const decision = yield* engine
            .transaction("station.configure", (writer) => {
              if (request.configuration.role === "remote") {
                const pairing = selectPairing(writer);
                if (pairing === undefined) {
                  return { _tag: "pairing-required" as const };
                }
                if (
                  pairing.command_center_installation_id !==
                  request.configuration.commandCenterInstallationId
                ) {
                  return {
                    _tag: "command-center-mismatch" as const,
                    admitted: pairing.command_center_installation_id,
                  };
                }
                if (request.configuration.browserTrust !== undefined) {
                  installStationBrowserPinnedRecord(
                    writer,
                    request.configuration.browserTrust,
                  );
                }
              }

              const effectiveConfiguration = withCurrentBrowserTrust(
                request.configuration,
                selectLatestPinnedTrust(writer),
              );
              // Station configure is the topology authority. Repair the
              // protected Settings projection even on an otherwise
              // idempotent configure retry.
              writeSettingsTopology(
                writer,
                topology.right,
                admittedConfiguredAt,
              );
              const currentRow = selectConfiguration(writer);
              if (currentRow !== undefined) {
                const current = configurationFromRow(
                  currentRow,
                  selectLatestPinnedTrust(writer),
                );
                if (
                  sameConfiguration(
                    current.configuration,
                    effectiveConfiguration,
                  )
                ) {
                  return {
                    _tag: "configured" as const,
                    configuredAt: current.configuredAt,
                    configuration: effectiveConfiguration,
                  };
                }
              }
              writeConfiguration(
                writer,
                effectiveConfiguration,
                admittedConfiguredAt,
              );
              return {
                _tag: "configured" as const,
                configuredAt: admittedConfiguredAt,
                configuration: effectiveConfiguration,
              };
            })
            .pipe(
              Effect.mapError(configureStateError),
            );

          if (decision._tag === "pairing-required") {
            return yield* StationConfigurationError.make({
              reason: "pairing-required",
              message:
                "a Remote configuration requires an admitted Command Center pairing",
            });
          }
          if (decision._tag === "command-center-mismatch") {
            return yield* StationConfigurationError.make({
              reason: "command-center-mismatch",
              message:
                `Remote configuration names ${request.configuration.role === "remote" ? request.configuration.commandCenterInstallationId : ""}, ` +
                `but pairing admits ${decision.admitted}`,
            });
          }
          return ConfigureResponse.make({
            protocol: STATION_API_PROTOCOL,
            op: "configure",
            installationId,
            configuration: decision.configuration,
            configuredAt: decision.configuredAt,
          });
        },
      );

      const installProjection = Effect.fn(
        "StationRepository.installProjection",
      )(function* (request: ProjectRequest, receivedAt = clock()) {
        const admittedCreatedAt = yield* admitTimestamp(
          "install-projection",
          "createdAt",
          request.projection.createdAt,
        );
        const admittedReceivedAt = yield* admitTimestamp(
          "install-projection",
          "receivedAt",
          receivedAt,
        );
        yield* ensureLocalIdentity(
          "project",
          installationId,
          request.stationInstallationId,
        );
        const actual = stationProjectionContentSha256(
          request.projection.body,
        );
        if (actual !== request.projection.contentSha256) {
          return yield* StationProjectionIntegrityError.make({
            generation: request.projection.generation,
            declaredContentSha256: request.projection.contentSha256,
            actualContentSha256: actual,
          });
        }

        const outcome = yield* engine
          .transaction("station.install-projection", (writer) => {
            const current = selectProjection(writer);
            if (current !== undefined) {
              const currentActual = stationProjectionContentSha256(
                current.body,
              );
              const currentDeclared = decodeHash(current.content_sha256);
              if (currentActual !== currentDeclared) {
                return {
                  _tag: "corrupt" as const,
                  row: current,
                  actual: currentActual,
                  declared: currentDeclared,
                };
              }
            }
            const decision = decideProjectionInstall(
              current === undefined
                ? undefined
                : projectionReferenceFromRow(current),
              request.projection,
            );
            if (decision === "install") {
              writer.run(
                `INSERT INTO station_projection(
                   singleton,
                   generation,
                   body,
                   content_sha256,
                   created_at,
                   received_at
                 ) VALUES (1, ?, ?, ?, ?, ?)
                 ON CONFLICT(singleton) DO UPDATE SET
                   generation = excluded.generation,
                   body = excluded.body,
                   content_sha256 = excluded.content_sha256,
                   created_at = excluded.created_at,
                   received_at = excluded.received_at`,
                [
                  request.projection.generation,
                  request.projection.body,
                  request.projection.contentSha256,
                  admittedCreatedAt,
                  admittedReceivedAt,
                ],
              );
              return {
                _tag: "decision" as const,
                decision,
                active: decodeProjectionReference({
                  generation: request.projection.generation,
                  contentSha256: request.projection.contentSha256,
                  receivedAt: admittedReceivedAt,
                }),
              };
            }
            return {
              _tag: "decision" as const,
              decision,
              active: projectionReferenceFromRow(current!),
            };
          })
          .pipe(
            Effect.mapError((error) =>
              persistenceError("install-projection", error),
            ),
          );

        if (outcome._tag === "corrupt") {
          return yield* StationProjectionIntegrityError.make({
            generation: decodeSequence(outcome.row.generation),
            declaredContentSha256: outcome.declared,
            actualContentSha256: outcome.actual,
          });
        }
        return ProjectResponse.make({
          protocol: STATION_API_PROTOCOL,
          op: "project",
          stationInstallationId: installationId,
          decision: outcome.decision,
          active: outcome.active,
        });
      });

      const appendOutbound = Effect.fn("StationRepository.appendOutbound")(
        function* (input: AppendStationEvent) {
          const originAt = yield* admitTimestamp(
            "append-outbound",
            "originAt",
            input.originAt,
          );
          const receivedAt = yield* admitTimestamp(
            "append-outbound",
            "receivedAt",
            input.receivedAt ?? clock(),
          );
          const contentSha256 = stationEventContentSha256(
            input.kind,
            input.body,
          );
          // Parse before entering the transaction so malformed internal calls
          // can never commit a row the wire contract cannot represent.
          decodeEvent({
            identity: { home: installationId, sequence: "0" },
            kind: input.kind,
            body: input.body,
            contentSha256,
            originAt,
            receivedAt,
          });

          const outcome = yield* engine
            .transaction("station.append-outbound", (writer) => {
              const row = writer.get<
                StateRow & { readonly last_sequence: string }
              >(
                `SELECT last_sequence
                   FROM station_outbound_sequences
                  WHERE home = ?`,
                [installationId],
              );
              const next = (BigInt(row?.last_sequence ?? "0") + 1n)
                .toString();
              if (next.length > 32) {
                return { _tag: "overflow" as const };
              }
              writer.run(
                `INSERT INTO station_outbound_sequences(home, last_sequence)
                 VALUES (?, ?)
                 ON CONFLICT(home) DO UPDATE SET
                   last_sequence = excluded.last_sequence`,
                [installationId, next],
              );
              writer.run(
                `INSERT INTO station_events(
                   home,
                   sequence,
                   direction,
                   kind,
                   body,
                   content_sha256,
                   origin_at,
                   received_at
                 ) VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?)`,
                [
                  installationId,
                  next,
                  input.kind,
                  input.body,
                  contentSha256,
                  originAt,
                  receivedAt,
                ],
              );
              return {
                _tag: "appended" as const,
                event: decodeEvent({
                  identity: {
                    home: installationId,
                    sequence: next,
                  },
                  kind: input.kind,
                  body: input.body,
                  contentSha256,
                  originAt,
                  receivedAt,
                }),
              };
            })
            .pipe(
              Effect.mapError((error) =>
                persistenceError("append-outbound", error),
              ),
            );
          if (outcome._tag === "overflow") {
            return yield* StationCursorError.make({
              operation: "append-outbound",
              message: "logical sequence exceeded the 32-digit contract",
            });
          }
          return outcome.event;
        },
      );

      const eventsAfter = Effect.fn("StationRepository.eventsAfter")(
        function* (
          home: InstallationIdValue,
          through: LogicalSequenceValue,
          limit = STATION_API_MAX_EVENTS_PER_REPORT,
        ) {
          if (
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > STATION_API_MAX_EVENTS_PER_REPORT
          ) {
            return yield* StationCursorError.make({
              operation: "events-after",
              message:
                `limit must be an integer between 1 and ${STATION_API_MAX_EVENTS_PER_REPORT}`,
            });
          }
          return yield* engine
            .read("station.events-after", (reader) =>
              reader
                .all<EventRow>(
                  `SELECT
                     home,
                     sequence,
                     direction,
                     kind,
                     body,
                     content_sha256,
                     origin_at,
                     received_at
                   FROM station_events
                   WHERE home = ?
                     AND (
                       length(sequence) > length(?)
                       OR (
                         length(sequence) = length(?)
                         AND sequence > ?
                       )
                     )
                   ORDER BY length(sequence), sequence
                   LIMIT ?`,
                  [home, through, through, through, limit],
                )
                .map(eventFromRow)
            )
            .pipe(
              Effect.mapError((error) =>
                persistenceError("events-after", error),
              ),
            );
        },
      );

      const acceptInbound = Effect.fn("StationRepository.acceptInbound")(
        function* (
          events: ReadonlyArray<StationEventValue>,
          receivedAt = clock(),
        ) {
          const admittedReceivedAt = yield* admitTimestamp(
            "accept-inbound",
            "receivedAt",
            receivedAt,
          );
          if (events.length > STATION_API_MAX_EVENTS_PER_REPORT) {
            return yield* StationCursorError.make({
              operation: "accept-inbound",
              message:
                `event batch exceeds ${STATION_API_MAX_EVENTS_PER_REPORT}`,
            });
          }
          for (const event of events) {
            yield* admitTimestamp(
              "accept-inbound",
              "originAt",
              event.originAt,
            );
            yield* validateEventHash(event);
            if (event.identity.home === installationId) {
              return yield* StationCursorError.make({
                operation: "accept-inbound",
                message:
                  "an installation cannot accept its own outbound identity as inbound",
              });
            }
          }
          const coalesced = coalesceStationEvents(events);
          if (coalesced._tag === "identity-conflict") {
            return yield* StationEventIdentityConflictError.make({
              home: coalesced.identity.home,
              sequence: coalesced.identity.sequence,
              admittedContentSha256:
                coalesced.admittedContentSha256,
              rejectedContentSha256:
                coalesced.rejectedContentSha256,
            });
          }

          const outcome = yield* engine
            .transaction("station.accept-inbound", (writer) => {
              let idempotent = 0;
              for (const event of coalesced.events) {
                const existing = writer.get<EventRow>(
                  `SELECT
                     home,
                     sequence,
                     direction,
                     kind,
                     body,
                     content_sha256,
                     origin_at,
                     received_at
                   FROM station_events
                   WHERE home = ? AND sequence = ?`,
                  [event.identity.home, event.identity.sequence],
                );
                if (existing === undefined) continue;
                if (
                  existing.direction !== "inbound" ||
                  existing.content_sha256 !== event.contentSha256 ||
                  existing.kind !== event.kind ||
                  existing.body !== event.body
                ) {
                  return {
                    _tag: "conflict" as const,
                    event,
                    admittedHash: decodeHash(
                      existing.content_sha256,
                    ),
                  };
                }
                idempotent += 1;
              }

              for (const event of coalesced.events) {
                const exists = writer.get<StateRow>(
                  `SELECT home
                     FROM station_events
                    WHERE home = ? AND sequence = ?`,
                  [event.identity.home, event.identity.sequence],
                );
                if (exists !== undefined) continue;
                writer.run(
                  `INSERT INTO station_events(
                     home,
                     sequence,
                     direction,
                     kind,
                     body,
                     content_sha256,
                     origin_at,
                     received_at
                   ) VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?)`,
                  [
                    event.identity.home,
                    event.identity.sequence,
                    event.kind,
                    event.body,
                    event.contentSha256,
                    event.originAt,
                    admittedReceivedAt,
                  ],
                );
              }

              const homes = [
                ...new Set(
                  coalesced.events.map((event) => event.identity.home),
                ),
              ].sort();
              const acknowledge: StationEventAckValue[] = [];
              for (const home of homes) {
                const cursor = writer.get<CursorRow>(
                  `SELECT home, through_sequence
                     FROM station_received_cursors
                    WHERE home = ?`,
                  [home],
                );
                const current = cursor?.through_sequence ?? "0";
                let next = BigInt(current) + 1n;
                let through = current;
                // Bound one synchronous transaction to one protocol batch.
                // If closing a gap releases a larger backlog, the sender's
                // retry advances the next window without blocking reads.
                for (
                  let step = 0;
                  step < STATION_API_MAX_EVENTS_PER_REPORT;
                  step += 1
                ) {
                  const admitted = writer.get<
                    StateRow & { readonly sequence: string }
                  >(
                    `SELECT sequence
                       FROM station_events
                      WHERE direction = 'inbound'
                        AND home = ?
                        AND sequence = ?`,
                    [home, next.toString()],
                  );
                  if (admitted === undefined) break;
                  through = admitted.sequence;
                  next += 1n;
                }
                writer.run(
                  `INSERT INTO station_received_cursors(
                     home,
                     through_sequence,
                     updated_at
                   ) VALUES (?, ?, ?)
                   ON CONFLICT(home) DO UPDATE SET
                     through_sequence = excluded.through_sequence,
                     updated_at = excluded.updated_at`,
                  [home, through, admittedReceivedAt],
                );
                acknowledge.push(decodeAck({ home, through }));
              }
              return {
                _tag: "accepted" as const,
                accepted: coalesced.events.length - idempotent,
                idempotent,
                acknowledge,
              };
            })
            .pipe(
              Effect.mapError((error) =>
                persistenceError("accept-inbound", error),
              ),
            );

          if (outcome._tag === "conflict") {
            return yield* StationEventIdentityConflictError.make({
              home: outcome.event.identity.home,
              sequence: outcome.event.identity.sequence,
              admittedContentSha256: outcome.admittedHash,
              rejectedContentSha256:
                outcome.event.contentSha256,
            });
          }
          return outcome;
        },
      );

      const advancePeerAcks = Effect.fn(
        "StationRepository.advancePeerAcks",
      )(function* (
        peerInstallationId: InstallationIdValue,
        acknowledgements: ReadonlyArray<StationEventAckValue>,
        acknowledgedAt = clock(),
      ) {
        const admittedAcknowledgedAt = yield* admitTimestamp(
          "advance-peer-acks",
          "acknowledgedAt",
          acknowledgedAt,
        );
        if (peerInstallationId === installationId) {
          return yield* StationCursorError.make({
            operation: "advance-peer-acks",
            message:
              "an installation cannot acknowledge events as its own peer",
          });
        }
        if (acknowledgements.length > STATION_API_MAX_ACKS_PER_REPORT) {
          return yield* StationCursorError.make({
            operation: "advance-peer-acks",
            message:
              `acknowledgement batch exceeds ${STATION_API_MAX_ACKS_PER_REPORT}`,
          });
        }
        for (const acknowledgement of acknowledgements) {
          yield* ensureLocalIdentity(
            "advance-peer-acks",
            installationId,
            acknowledgement.home,
          );
        }
        const outcome = yield* engine
          .transaction("station.advance-peer-acks", (writer) => {
            const emitted = writer.get<
              StateRow & { readonly last_sequence: string }
            >(
              `SELECT last_sequence
                 FROM station_outbound_sequences
                WHERE home = ?`,
              [installationId],
            )?.last_sequence ?? "0";
            const emittedSequence = decodeSequence(emitted);
            for (const proposed of acknowledgements) {
              if (
                compareLogicalSequence(
                  proposed.through,
                  emittedSequence,
                ) > 0
              ) {
                return {
                  _tag: "beyond-emitted" as const,
                  through: proposed.through,
                  emitted: emittedSequence,
                };
              }
            }
            const decisions: AckAdvanceDecision[] = [];
            for (const proposed of acknowledgements) {
              const row = writer.get<CursorRow>(
                `SELECT home, through_sequence
                   FROM station_peer_ack_cursors
                  WHERE peer_installation_id = ?
                    AND home = ?`,
                [peerInstallationId, proposed.home],
              );
              const current =
                row === undefined ? undefined : ackFromRow(row);
              const decision = decideAckAdvance(current, proposed);
              decisions.push(decision);
              if (decision._tag === "advanced") {
                writer.run(
                  `INSERT INTO station_peer_ack_cursors(
                     peer_installation_id,
                     home,
                     through_sequence,
                     acknowledged_at
                   ) VALUES (?, ?, ?, ?)
                   ON CONFLICT(peer_installation_id, home) DO UPDATE SET
                     through_sequence = excluded.through_sequence,
                     acknowledged_at = excluded.acknowledged_at`,
                  [
                    peerInstallationId,
                    decision.cursor.home,
                    decision.cursor.through,
                    admittedAcknowledgedAt,
                  ],
                );
              }
            }
            return {
              _tag: "advanced" as const,
              decisions,
            };
          })
          .pipe(
            Effect.mapError((error) =>
              persistenceError("advance-peer-acks", error),
            ),
          );
        if (outcome._tag === "beyond-emitted") {
          return yield* StationCursorError.make({
            operation: "advance-peer-acks",
            message:
              `peer acknowledged ${outcome.through}, but only ` +
              `${outcome.emitted} has been emitted`,
          });
        }
        return outcome.decisions;
      });

      const statusFacts = engine
        .read("station.status-facts", (reader) => ({
          pairing: selectPairing(reader),
          configuration: selectConfiguration(reader),
          browserTrust: selectLatestPinnedTrust(reader),
          projection: selectProjection(reader),
          received: receivedCursorRows(reader),
          peerAcks: peerAckRows(reader),
        }))
        .pipe(
          Effect.mapError((error) =>
            persistenceError("status-facts", error),
          ),
          Effect.flatMap((rows) =>
            rows.projection === undefined
              ? Effect.succeed(rows)
              : verifyStoredProjection(rows.projection).pipe(
                  Effect.as(rows),
                )
          ),
          Effect.map((rows): StationStatusFacts => {
            const pairing =
              rows.pairing === undefined
                ? undefined
                : pairingFromRow(rows.pairing);
            const configuration =
              rows.configuration === undefined
                ? undefined
                : configurationFromRow(
                    rows.configuration,
                    rows.browserTrust,
                  );
            const projection =
              rows.projection === undefined
                ? undefined
                : projectionReferenceFromRow(rows.projection);
            return {
              installationId,
              ...(pairing === undefined ? {} : { pairing }),
              ...(configuration === undefined
                ? {}
                : {
                    configuration: configuration.configuration,
                    configuredAt: configuration.configuredAt,
                  }),
              ...(projection === undefined ? {} : { projection }),
              receivedThrough: rows.received.map(ackFromRow),
              peerAcknowledgedThrough: rows.peerAcks.map((row) => ({
                peerInstallationId: decodeInstallationId(
                  row.peer_installation_id,
                ),
                acknowledgement: ackFromRow(row),
              })),
            };
          }),
          Effect.withSpan("station-repository.status-facts"),
        );

      return StationRepository.of({
        installationId: Effect.succeed(installationId),
        pairing: readPairing,
        configuration: readConfiguration,
        projection: readProjection,
        pair,
        configure,
        installProjection,
        appendOutbound,
        eventsAfter,
        acceptInbound,
        advancePeerAcks,
        statusFacts,
      });
    }),
  );

export const StationRepositoryLive = makeStationRepositoryLive();
