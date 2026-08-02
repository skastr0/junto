import { createHash, randomUUID } from "node:crypto";
import { Context, Effect, Either, Layer, Schema } from "effect";
import { StationContextTagIds } from "./context-services";
import {
  ConfigureResponse,
  DisplayTimestamp,
  LogicalSequence,
  PairResponse,
  ProjectResponse,
  RemoteHostRegistration,
  STATION_API_PROTOCOL,
  StationProjectionBody,
  StationProjectionReference,
  StationSha256,
  decideProjectionInstall,
  type ConfigureRequest,
  type ConfigureResponse as ConfigureResponseValue,
  type PairRequest,
  type PairResponse as PairResponseValue,
  type ProjectRequest,
  type ProjectResponse as ProjectResponseValue,
  type StationConfiguration as StationConfigurationValue,
  type StationProjectionBody as StationProjectionBodyValue,
  type StationProjectionReference as StationProjectionReferenceValue,
  type StationSha256 as StationSha256Value,
} from "@shared/station-api";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "@shared/installation-id";
import {
  RouteCursor,
  type RouteCursor as RouteCursorValue,
} from "@shared/station-api";
import {
  hermesKeyFor,
  RemoteHostsError,
} from "@shared/remote-hosts";
import {
  ensureHostRegistryState,
  upsertHostState,
} from "../hosts/registry";
import { setHostsSnapshot } from "../hosts/snapshot";
import {
  StateEngine,
  type StateEngineError,
  type StateReader,
  type StateRow,
  type StateWriter,
} from "../state/service";
import {
  selectStationConfigurationRow,
  stationConfigurationFromRow,
  writeStationConfiguration,
  type StationConfigurationRow,
} from "./configuration-state";
import {
  decodeStationPortfolioBody,
  StationPortfolioError,
} from "./portfolio";

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

export class StationPairingTopologyError extends Schema.TaggedError<StationPairingTopologyError>()(
  "StationPairingTopologyError",
  {
    reason: Schema.Literal("command-center-configured"),
    message: Schema.String,
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
      "host-immutable",
      "host-registration-mismatch",
      "role-immutable",
      "remote-only",
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
  | StationPairingTopologyError
  | StationSelfPairingError
  | StationConfigurationError
  | StationProjectionIntegrityError
  | StationMetadataError
  | StationPortfolioError;

export type StationPairing = {
  readonly commandCenterInstallationId: InstallationIdValue;
  readonly stationLabel: string;
  readonly appVersion: string;
  readonly pairedAt: string;
};

export type StationProjection = StationProjectionBodyValue & {
  readonly receivedAt: string;
};

export type StationProjectionDraft = Omit<
  StationProjectionBodyValue,
  "generation" | "contentSha256"
>;

export type StationConfigurationRecord = {
  readonly configuration: StationConfigurationValue;
  readonly configuredAt: string;
};

export type StationPeerAcknowledgement = {
  readonly peerInstallationId: InstallationIdValue;
  readonly acknowledgement: RouteCursorValue;
};

export type StationStatusFacts = {
  readonly installationId: InstallationIdValue;
  readonly pairing?: StationPairing;
  readonly configuration?: StationConfigurationValue;
  readonly configuredAt?: string;
  readonly projection?: StationProjectionReferenceValue;
  readonly receivedThrough: ReadonlyArray<RouteCursorValue>;
  readonly peerAcknowledgedThrough: ReadonlyArray<StationPeerAcknowledgement>;
};

// S4-station: single canonical Context.Tag (effect@3.21). V4 → Context.Service.
export class StationRepository extends Context.Tag(StationContextTagIds.repository)<
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
    readonly projectionByReference: (
      reference: Pick<
        StationProjectionReferenceValue,
        "generation" | "contentSha256"
      >,
    ) => Effect.Effect<
      StationProjection | undefined,
      StationRepositoryError
    >;
    /**
     * Archive the exact compiled Command Center projection and allocate its
     * projection-specific generation before any transport write.
     */
    readonly archiveProjection: (
      projection: StationProjectionDraft,
      archivedAt?: string,
    ) => Effect.Effect<StationProjectionBodyValue, StationRepositoryError>;
    readonly pair: (
      request: PairRequest,
      pairedAt?: string,
    ) => Effect.Effect<PairResponseValue, StationRepositoryError>;
    readonly configureRemote: (
      request: ConfigureRequest,
      configuredAt?: string,
    ) => Effect.Effect<ConfigureResponseValue, StationRepositoryError>;
    readonly installProjection: (
      request: ProjectRequest,
      receivedAt?: string,
    ) => Effect.Effect<ProjectResponseValue, StationRepositoryError>;
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

type ProjectionRow = StateRow & {
  readonly generation: string;
  readonly content_sha256: string;
  readonly source_canvas_generation: string;
  readonly source_intent_sha256: string;
  readonly body: string;
  readonly created_at: string;
  readonly received_at: string;
};

type CursorRow = StateRow & {
  readonly event_home: string;
  readonly entity_home: string;
  readonly through_sequence: string;
};

type PeerAckRow = CursorRow & {
  readonly peer_installation_id: string;
};

const decodeInstallationId = Schema.decodeUnknownSync(InstallationId);
const decodeSequence = Schema.decodeUnknownSync(LogicalSequence);
const decodeHash = Schema.decodeUnknownSync(StationSha256);
const decodeTimestampEither = Schema.decodeUnknownEither(DisplayTimestamp);
const decodeRemoteHostRegistration = Schema.decodeUnknownSync(
  RemoteHostRegistration,
);
const decodeProjectionBody = Schema.decodeUnknownSync(StationProjectionBody);
const decodeProjectionReference = Schema.decodeUnknownSync(
  StationProjectionReference,
);
const decodeCursor = Schema.decodeUnknownSync(RouteCursor);

const sha256 = (value: string): StationSha256Value =>
  decodeHash(createHash("sha256").update(value, "utf8").digest("hex"));

/** Hash of the exact complete projection body. */
export const stationProjectionContentSha256 = (
  body: string,
): StationSha256Value => sha256(body);

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
): StationPersistenceError | StationConfigurationError => {
  if (error.cause instanceof RemoteHostsError) {
    return StationConfigurationError.make({
      reason: "host-registration-mismatch",
      message: error.cause.message,
    });
  }
  return persistenceError("configure", error);
};

const selectInstallation = (
  reader: StateReader,
): InstallationRow | undefined =>
  reader.get<InstallationRow>(
    `SELECT installation_id, created_at
       FROM station_installation
      WHERE singleton = 1`,
  );

const registerKnownInstallation = (
  writer: StateWriter,
  installationId: InstallationIdValue,
  registeredAt: string,
): void => {
  writer.run(
    `INSERT INTO station_known_installations(
       installation_id,
       registered_at
     ) VALUES (?, ?)
     ON CONFLICT(installation_id) DO NOTHING`,
    [installationId, registeredAt],
  );
};

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
): StationConfigurationRow | undefined =>
  selectStationConfigurationRow(reader);

const selectProjection = (
  reader: StateReader,
): ProjectionRow | undefined =>
  reader.get<ProjectionRow>(
    `SELECT
       version.generation AS generation,
       version.content_sha256 AS content_sha256,
       version.source_canvas_generation AS source_canvas_generation,
       version.source_intent_sha256 AS source_intent_sha256,
       version.body AS body,
       version.created_at AS created_at,
       version.received_at AS received_at
     FROM station_projection_head head
     JOIN station_projection_versions version
       ON version.generation = head.generation
      AND version.content_sha256 = head.content_sha256
     WHERE head.singleton = 1`,
  );

const selectProjectionByReference = (
  reader: StateReader,
  reference: Pick<
    StationProjectionReferenceValue,
    "generation" | "contentSha256"
  >,
): ProjectionRow | undefined =>
  reader.get<ProjectionRow>(
    `SELECT
       generation,
       content_sha256,
       source_canvas_generation,
       source_intent_sha256,
       body,
       created_at,
       received_at
     FROM station_projection_versions
     WHERE generation = ?
       AND content_sha256 = ?`,
    [reference.generation, reference.contentSha256],
  );

const pairingFromRow = (row: PairingRow): StationPairing => ({
  commandCenterInstallationId: decodeInstallationId(
    row.command_center_installation_id,
  ),
  stationLabel: row.station_label,
  appVersion: row.app_version,
  pairedAt: row.paired_at,
});

const configurationFromRow = (
  row: StationConfigurationRow,
): StationConfigurationRecord => stationConfigurationFromRow(row);

const projectionFromRow = (row: ProjectionRow): StationProjection =>
  ({
    ...decodeProjectionBody({
      scope: "full",
      generation: row.generation,
      sourceCanvasGeneration: row.source_canvas_generation,
      sourceIntentSha256: row.source_intent_sha256,
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

const cursorFromRow = (row: CursorRow): RouteCursorValue =>
  decodeCursor({
    eventHome: row.event_home,
    entityHome: row.entity_home,
    through: row.through_sequence,
  });

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
      left.supervisedPreferred === right.supervisedPreferred
    );
  }
  return false;
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

const receivedCursorRows = (
  reader: StateReader,
): ReadonlyArray<CursorRow> =>
  reader.all<CursorRow>(
    `SELECT event_home, entity_home, through_sequence
       FROM station_received_cursors
      ORDER BY event_home, entity_home`,
  );

const peerAckRows = (
  reader: StateReader,
): ReadonlyArray<PeerAckRow> =>
  reader.all<PeerAckRow>(
    `SELECT
       peer_installation_id,
       event_home,
       entity_home,
       through_sequence
       FROM station_peer_ack_cursors
      ORDER BY peer_installation_id, event_home, entity_home`,
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
          registerKnownInstallation(
            writer,
            created,
            installationCreatedAt,
          );
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
            : configurationFromRow(row);
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

      const projectionByReference = (
        reference: Pick<
          StationProjectionReferenceValue,
          "generation" | "contentSha256"
        >,
      ): Effect.Effect<
        StationProjection | undefined,
        StationRepositoryError
      > =>
        engine
          .read(
            "station.projection-by-reference",
            (reader) => selectProjectionByReference(reader, reference),
          )
          .pipe(
            Effect.mapError((error) =>
              persistenceError("projection-by-reference", error),
            ),
            Effect.flatMap((row) =>
              row === undefined
                ? Effect.succeed(undefined)
                : verifyStoredProjection(row).pipe(
                    Effect.as(projectionFromRow(row)),
                  )
            ),
            Effect.withSpan(
              "station-repository.projection-by-reference",
            ),
          );

      const archiveProjection = Effect.fn(
        "StationRepository.archiveProjection",
      )(function* (
        projection: StationProjectionDraft,
        archivedAt = clock(),
      ) {
        const admittedCreatedAt = yield* admitTimestamp(
          "archive-projection",
          "createdAt",
          projection.createdAt,
        );
        const admittedArchivedAt = yield* admitTimestamp(
          "archive-projection",
          "archivedAt",
          archivedAt,
        );
        yield* Effect.try({
          try: () => decodeStationPortfolioBody(projection.body),
          catch: (error) =>
            error instanceof StationPortfolioError
              ? error
              : StationPortfolioError.make({
                  operation: "decode",
                  message: "station portfolio could not be decoded",
                }),
        });
        const contentSha256 = stationProjectionContentSha256(
          projection.body,
        );

        const outcome = yield* engine
          .transaction("station.archive-projection", (writer) => {
            const current = selectProjection(writer);
            if (current !== undefined) {
              const currentActual = stationProjectionContentSha256(
                current.body,
              );
              const currentDeclared = decodeHash(
                current.content_sha256,
              );
              if (currentActual !== currentDeclared) {
                return {
                  _tag: "corrupt" as const,
                  row: current,
                  actual: currentActual,
                  declared: currentDeclared,
                };
              }
              if (
                current.body === projection.body &&
                current.content_sha256 === contentSha256 &&
                current.source_canvas_generation ===
                  projection.sourceCanvasGeneration &&
                current.source_intent_sha256 ===
                  projection.sourceIntentSha256
              ) {
                return {
                  _tag: "archived" as const,
                  row: current,
                };
              }
            }

            const generation = decodeSequence(
              current === undefined
                ? "1"
                : (BigInt(current.generation) + 1n).toString(),
            );
            writer.run(
              `INSERT INTO station_projection_versions(
                 generation,
                 content_sha256,
                 source_canvas_generation,
                 source_intent_sha256,
                 body,
                 created_at,
                 received_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [
                generation,
                contentSha256,
                projection.sourceCanvasGeneration,
                projection.sourceIntentSha256,
                projection.body,
                admittedCreatedAt,
                admittedArchivedAt,
              ],
            );
            writer.run(
              `INSERT INTO station_projection_head(
                 singleton,
                 generation,
                 content_sha256
               ) VALUES (1, ?, ?)
               ON CONFLICT(singleton) DO UPDATE SET
                 generation = excluded.generation,
                 content_sha256 = excluded.content_sha256`,
              [generation, contentSha256],
            );
            return {
              _tag: "archived" as const,
              row: {
                generation,
                content_sha256: contentSha256,
                source_canvas_generation:
                  projection.sourceCanvasGeneration,
                source_intent_sha256:
                  projection.sourceIntentSha256,
                body: projection.body,
                created_at: admittedCreatedAt,
                received_at: admittedArchivedAt,
              } satisfies ProjectionRow,
            };
          })
          .pipe(
            Effect.mapError((error) =>
              persistenceError("archive-projection", error),
            ),
          );

        if (outcome._tag === "corrupt") {
          return yield* StationProjectionIntegrityError.make({
            generation: decodeSequence(outcome.row.generation),
            declaredContentSha256: outcome.declared,
            actualContentSha256: outcome.actual,
          });
        }
        const archived = projectionFromRow(outcome.row);
        return decodeProjectionBody({
          scope: archived.scope,
          generation: archived.generation,
          sourceCanvasGeneration: archived.sourceCanvasGeneration,
          sourceIntentSha256: archived.sourceIntentSha256,
          body: archived.body,
          contentSha256: archived.contentSha256,
          createdAt: archived.createdAt,
        });
      });

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
              const configured = selectConfiguration(writer);
              if (configured?.role === "command-center") {
                return {
                  _tag: "command-center-configured" as const,
                };
              }
              const current = selectPairing(writer);
              if (current === undefined) {
                registerKnownInstallation(
                  writer,
                  request.commandCenterInstallationId,
                  admittedPairedAt,
                );
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
          if (decision._tag === "command-center-configured") {
            return yield* StationPairingTopologyError.make({
              reason: "command-center-configured",
              message:
                "a locally selected Command Center cannot be paired as a Remote",
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

      const configureRemote = Effect.fn("StationRepository.configureRemote")(
        function* (request: ConfigureRequest, configuredAt = clock()) {
          if (
            (request as {
              readonly configuration?: { readonly role?: unknown };
            }).configuration?.role !== "remote"
          ) {
            return yield* StationConfigurationError.make({
              reason: "remote-only",
              message:
                "Station API configuration can establish only a Remote role",
            });
          }
          if (
            request.host.id === "local" ||
            request.host.id !== request.configuration.hostId ||
            hermesKeyFor(request.host) !==
              request.configuration.agentHostId
          ) {
            return yield* StationConfigurationError.make({
              reason: "host-registration-mismatch",
              message:
                "Remote configuration identity must match its Command Center host registration",
            });
          }
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
          const decision = yield* engine
            .transaction("station.configure", (writer) => {
              const currentRow = selectConfiguration(writer);
              if (
                currentRow !== undefined &&
                currentRow.role !== request.configuration.role
              ) {
                return {
                  _tag: "role-immutable" as const,
                  admitted: currentRow.role,
                };
              }
              if (
                currentRow !== undefined &&
                currentRow.host_id !== request.configuration.hostId
              ) {
                return {
                  _tag: "host-immutable" as const,
                  admitted: currentRow.host_id,
                };
              }
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

              // Remote is a projection consumer, never a dormant Command
              // Center. Fresh boot seeds an authorial canvas for local use;
              // the first successful Remote configuration removes that
              // history in this same transaction. Repeating configure also
              // repairs any impossible authorial residue.
              writer.run("DELETE FROM canvas_head");
              writer.run("DELETE FROM canvas_generation_documents");
              writer.run("DELETE FROM canvas_generations");

              const effectiveConfiguration = request.configuration;
              ensureHostRegistryState(writer, admittedConfiguredAt);
              const hosts = upsertHostState(writer, request.host);
              const storedHost = hosts.hosts.find(
                (host) => host.id === request.configuration.hostId,
              );
              if (
                storedHost === undefined ||
                storedHost.kind !== "remote"
              ) {
                throw new Error(
                  "configured Remote host registration was not persisted",
                );
              }
              const registeredHost =
                decodeRemoteHostRegistration(storedHost);
              if (currentRow !== undefined) {
                const current = configurationFromRow(currentRow);
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
                    host: registeredHost,
                    hosts: hosts.hosts,
                  };
                }
              }
              writeStationConfiguration(
                writer,
                effectiveConfiguration,
                admittedConfiguredAt,
              );
              return {
                _tag: "configured" as const,
                configuredAt: admittedConfiguredAt,
                configuration: effectiveConfiguration,
                host: registeredHost,
                hosts: hosts.hosts,
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
                `Remote configuration names ${request.configuration.commandCenterInstallationId}, ` +
                `but pairing admits ${decision.admitted}`,
            });
          }
          if (decision._tag === "host-immutable") {
            return yield* StationConfigurationError.make({
              reason: "host-immutable",
              message:
                `installation host "${decision.admitted}" is immutable; ` +
                `cannot reconfigure it as "${request.configuration.hostId}"`,
            });
          }
          if (decision._tag === "role-immutable") {
            return yield* StationConfigurationError.make({
              reason: "role-immutable",
              message:
                `installation role "${decision.admitted}" is immutable; ` +
                `cannot reconfigure it as "${request.configuration.role}"`,
            });
          }
          setHostsSnapshot(decision.hosts);
          return ConfigureResponse.make({
            protocol: STATION_API_PROTOCOL,
            op: "configure",
            installationId,
            configuration: decision.configuration,
            host: decision.host,
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
        yield* Effect.try({
          try: () =>
            decodeStationPortfolioBody(request.projection.body),
          catch: (error) =>
            error instanceof StationPortfolioError
              ? error
              : StationPortfolioError.make({
                  operation: "decode",
                  message: "station portfolio could not be decoded",
                }),
        });

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
                `INSERT INTO station_projection_versions(
                   generation,
                   content_sha256,
                   source_canvas_generation,
                   source_intent_sha256,
                   body,
                   created_at,
                   received_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                  request.projection.generation,
                  request.projection.contentSha256,
                  request.projection.sourceCanvasGeneration,
                  request.projection.sourceIntentSha256,
                  request.projection.body,
                  admittedCreatedAt,
                  admittedReceivedAt,
                ],
              );
              writer.run(
                `INSERT INTO station_projection_head(
                   singleton,
                   generation,
                   content_sha256
                 ) VALUES (1, ?, ?)
                 ON CONFLICT(singleton) DO UPDATE SET
                   generation = excluded.generation,
                   content_sha256 = excluded.content_sha256`,
                [
                  request.projection.generation,
                  request.projection.contentSha256,
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

      const statusFacts = engine
        .read("station.status-facts", (reader) => ({
          pairing: selectPairing(reader),
          configuration: selectConfiguration(reader),
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
                : configurationFromRow(rows.configuration);
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
              receivedThrough: rows.received.map(cursorFromRow),
              peerAcknowledgedThrough: rows.peerAcks.map((row) => ({
                peerInstallationId: decodeInstallationId(
                  row.peer_installation_id,
                ),
                acknowledgement: cursorFromRow(row),
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
        projectionByReference,
        archiveProjection,
        pair,
        configureRemote,
        installProjection,
        statusFacts,
      });
    }),
  );

export const StationRepositoryLive = makeStationRepositoryLive();
