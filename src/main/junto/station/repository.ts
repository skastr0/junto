import { createHash, randomUUID } from "node:crypto";
import { Context, Effect, Result, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
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
import { HostRegistryRows } from "../hosts/registry";
import { setHostsSnapshot } from "../hosts/snapshot";
import { CanvasRecords, CanvasRecordsLive } from "../canvas/records";
import { StateTransactionOperation } from "../state/service";
import { withSqlRead } from "../state/sql-read";
import { StationConfigurationRepository } from "./configuration-state";
import { KnownInstallations } from "./known-installations";
import {
  decodeStationPortfolioBody,
  StationPortfolioError,
} from "./portfolio";

export class StationPersistenceError extends Schema.TaggedError<StationPersistenceError>()(
  "StationPersistenceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
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
    reason: Schema.Literals(["pairing-required", "command-center-mismatch",
    "host-immutable",
    "host-registration-mismatch",
    "role-immutable",
    "remote-only",]),
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

// Station plane: canonical Context.Service (effect v4).
export class StationRepository extends Context.Service<StationRepository,
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
  }>()(StationContextTagIds.repository) {}

const InstallationRow = Schema.Struct({
  installation_id: InstallationId,
  created_at: Schema.String,
});
const PairingRow = Schema.Struct({
  command_center_installation_id: InstallationId,
  station_label: Schema.String,
  app_version: Schema.String,
  paired_at: Schema.String,
});
type PairingRow = typeof PairingRow.Type;
const ProjectionRow = Schema.Struct({
  generation: LogicalSequence,
  content_sha256: StationSha256,
  source_canvas_generation: LogicalSequence,
  source_intent_sha256: StationSha256,
  body: StationProjectionBody.fields.body,
  created_at: DisplayTimestamp,
  received_at: DisplayTimestamp,
});
type ProjectionRow = typeof ProjectionRow.Type;
const CursorRow = Schema.Struct({
  event_home: RouteCursor.fields.eventHome,
  entity_home: RouteCursor.fields.entityHome,
  through_sequence: RouteCursor.fields.through,
});
type CursorRow = typeof CursorRow.Type;
const PeerAckRow = Schema.Struct({
  ...CursorRow.fields,
  peer_installation_id: InstallationId,
});

const decodeInstallationId = Schema.decodeUnknownSync(InstallationId);
const decodeSequence = Schema.decodeUnknownEffect(LogicalSequence);
const decodeHash = Schema.decodeUnknownSync(StationSha256);
const decodeTimestampEither = Schema.decodeUnknownResult(DisplayTimestamp);
const decodeRemoteHostRegistration = Schema.decodeUnknownEffect(
  RemoteHostRegistration,
);
const decodeProjectionBody = Schema.decodeUnknownSync(StationProjectionBody);

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
  if (Result.isSuccess(decoded)) {
    return Effect.succeed(decoded.success);
  }
  return Effect.fail(
    StationMetadataError.make({
      operation,
      field,
      message: `${field} must contain between 1 and 64 characters`,
    }),
  );
};

const persistenceError = (
  operation: string,
  error: unknown,
): StationPersistenceError =>
  StationPersistenceError.make({
    operation,
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });

const configureStateError = (
  error: unknown,
): StationPersistenceError | StationConfigurationError => {
  if (error instanceof RemoteHostsError) {
    return StationConfigurationError.make({
      reason: "host-registration-mismatch",
      message: error.message,
    });
  }
  return persistenceError("configure", error);
};

const pairingFromRow = (row: PairingRow): StationPairing => ({
  commandCenterInstallationId: row.command_center_installation_id,
  stationLabel: row.station_label,
  appVersion: row.app_version,
  pairedAt: row.paired_at,
});

const projectionFromRow = (row: ProjectionRow): StationProjection =>
  ({
      scope: "full",
      generation: row.generation,
      sourceCanvasGeneration: row.source_canvas_generation,
      sourceIntentSha256: row.source_intent_sha256,
      body: row.body,
      contentSha256: row.content_sha256,
      createdAt: row.created_at,
    receivedAt: row.received_at,
  });

const projectionReferenceFromRow = (
  row: ProjectionRow,
): StationProjectionReferenceValue =>
  ({
    generation: row.generation,
    contentSha256: row.content_sha256,
    receivedAt: row.received_at,
  });

const cursorFromRow = (row: CursorRow): RouteCursorValue =>
  ({
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
  const declared = row.content_sha256;
  const actual = stationProjectionContentSha256(row.body);
  return declared === actual
    ? Effect.void
    : StationProjectionIntegrityError.make({
        generation: row.generation,
        declaredContentSha256: declared,
        actualContentSha256: actual,
      });
};

export type StationRepositoryOptions = {
  readonly makeInstallationId?: () => InstallationIdValue;
  readonly now?: () => string;
};

export const makeStationRepository = (
  options: StationRepositoryOptions = {},
) => Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const configurations = yield* StationConfigurationRepository;
      const installations = yield* KnownInstallations;
      const hostRows = yield* HostRegistryRows;
      const canvas = yield* CanvasRecords;
      const clock = options.now ?? nowIso;
      const findInstallation = SqlSchema.findOneOption({
        Request: Schema.Void, Result: InstallationRow,
        execute: () => sql`SELECT installation_id, created_at FROM station_installation WHERE singleton = 1`,
      });
      const findPairing = SqlSchema.findOneOption({
        Request: Schema.Void, Result: PairingRow,
        execute: () => sql`SELECT command_center_installation_id, station_label, app_version, paired_at
          FROM station_pairing WHERE singleton = 1`,
      });
      const selectPairing = findPairing(undefined).pipe(Effect.map(Option.getOrUndefined));
      const findProjection = SqlSchema.findOneOption({
        Request: Schema.Void, Result: ProjectionRow,
        execute: () => sql`SELECT version.generation AS generation, version.content_sha256 AS content_sha256,
          version.source_canvas_generation AS source_canvas_generation,
          version.source_intent_sha256 AS source_intent_sha256, version.body AS body,
          version.created_at AS created_at, version.received_at AS received_at
          FROM station_projection_head head JOIN station_projection_versions version
            ON version.generation = head.generation AND version.content_sha256 = head.content_sha256
          WHERE head.singleton = 1`,
      });
      const selectProjection = findProjection(undefined).pipe(Effect.map(Option.getOrUndefined));
      const selectProjectionByReference = SqlSchema.findOneOption({
        Request: Schema.Struct({ generation: LogicalSequence, contentSha256: StationSha256 }),
        Result: ProjectionRow,
        execute: (reference) => sql`SELECT generation, content_sha256, source_canvas_generation,
          source_intent_sha256, body, created_at, received_at FROM station_projection_versions
          WHERE generation = ${reference.generation} AND content_sha256 = ${reference.contentSha256}`,
      });
      const receivedCursorRows = SqlSchema.findAll({
        Request: Schema.Void, Result: CursorRow,
        execute: () => sql`SELECT event_home, entity_home, through_sequence
          FROM station_received_cursors ORDER BY event_home, entity_home`,
      });
      const peerAckRows = SqlSchema.findAll({
        Request: Schema.Void, Result: PeerAckRow,
        execute: () => sql`SELECT peer_installation_id, event_home, entity_home, through_sequence
          FROM station_peer_ack_cursors ORDER BY peer_installation_id, event_home, entity_home`,
      });
      const makeInstallationId =
        options.makeInstallationId ??
        (() => decodeInstallationId(randomUUID()));
      const installationCreatedAt = yield* admitTimestamp(
        "ensure-installation",
        "createdAt",
        clock(),
      );

      const installationId = yield* sql.withTransaction(Effect.gen(function* () {
          const existing = yield* findInstallation(undefined);
          if (Option.isSome(existing)) {
            return existing.value.installation_id;
          }
          const created = yield* Effect.try({ try: makeInstallationId, catch: (cause) => cause });
          yield* installations.register(
            created,
            installationCreatedAt,
          );
          yield* sql`INSERT INTO station_installation(
               singleton,
               installation_id,
               created_at
             ) VALUES (1, ${created}, ${installationCreatedAt})`;
          return created;
        }))
        .pipe(
          Effect.provideService(StateTransactionOperation, "station.ensure-installation"),
          Effect.mapError((error) =>
            persistenceError("ensure-installation", error),
          ),
        );

      const readPairing = selectPairing
        .pipe(
          Effect.map((row) => row === undefined ? undefined : pairingFromRow(row)),
          Effect.mapError((error) => persistenceError("pairing", error)),
          Effect.withSpan("station-repository.pairing"),
        );

      const readConfiguration = configurations.read
        .pipe(
          Effect.mapError((error) =>
            persistenceError("configuration", error),
          ),
          Effect.withSpan("station-repository.configuration"),
        );

      const readProjection = selectProjection
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

      const projectionByReference = Effect.fn("StationRepository.projectionByReference")(
        function* (
        reference: Pick<
          StationProjectionReferenceValue,
          "generation" | "contentSha256"
        >,
      ) {
        const row = yield* selectProjectionByReference(reference).pipe(
          Effect.mapError((error) => persistenceError("projection-by-reference", error)),
        );
        if (Option.isNone(row)) return undefined;
        yield* verifyStoredProjection(row.value);
        return projectionFromRow(row.value);
      });

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

        const outcome = yield* sql.withTransaction(Effect.gen(function* () {
            const current = yield* selectProjection;
            if (current !== undefined) {
              const currentActual = stationProjectionContentSha256(
                current.body,
              );
              const currentDeclared = current.content_sha256;
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

            const generation = yield* decodeSequence(
              current === undefined
                ? "1"
                : (BigInt(current.generation) + 1n).toString(),
            );
            yield* sql`INSERT INTO station_projection_versions(
                 generation,
                 content_sha256,
                 source_canvas_generation,
                 source_intent_sha256,
                 body,
                 created_at,
                 received_at
               ) VALUES (${generation}, ${contentSha256}, ${projection.sourceCanvasGeneration},
                 ${projection.sourceIntentSha256}, ${projection.body}, ${admittedCreatedAt}, ${admittedArchivedAt})`;
            yield* sql`INSERT INTO station_projection_head(
                 singleton,
                 generation,
                 content_sha256
               ) VALUES (1, ${generation}, ${contentSha256})
               ON CONFLICT(singleton) DO UPDATE SET
                 generation = excluded.generation,
                 content_sha256 = excluded.content_sha256`;
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
          }))
          .pipe(
            Effect.provideService(StateTransactionOperation, "station.archive-projection"),
            Effect.mapError((error) =>
              persistenceError("archive-projection", error),
            ),
          );

        if (outcome._tag === "corrupt") {
          return yield* StationProjectionIntegrityError.make({
            generation: outcome.row.generation,
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
          const decision = yield* sql.withTransaction(Effect.gen(function* () {
              const configured = yield* configurations.read;
              if (configured?.configuration.role === "command-center") {
                return {
                  _tag: "command-center-configured" as const,
                };
              }
              const current = yield* selectPairing;
              if (current === undefined) {
                yield* installations.register(
                  request.commandCenterInstallationId,
                  admittedPairedAt,
                );
                yield* sql`INSERT INTO station_pairing(
                     singleton,
                     command_center_installation_id,
                     station_label,
                     app_version,
                     paired_at
                   ) VALUES (1, ${request.commandCenterInstallationId}, ${request.stationLabel},
                     ${request.appVersion}, ${admittedPairedAt})`;
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
                  current: current.command_center_installation_id,
                };
              }
              return {
                _tag: "paired" as const,
                pairedAt: current.paired_at,
              };
            }))
            .pipe(
              Effect.provideService(StateTransactionOperation, "station.pair"),
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
          const decision = yield* sql.withTransaction(Effect.gen(function* () {
              const current = yield* configurations.read;
              if (
                current !== undefined &&
                current.configuration.role !== request.configuration.role
              ) {
                return {
                  _tag: "role-immutable" as const,
                  admitted: current.configuration.role,
                };
              }
              if (
                current !== undefined &&
                current.configuration.hostId !== request.configuration.hostId
              ) {
                return {
                  _tag: "host-immutable" as const,
                  admitted: current.configuration.hostId,
                };
              }
              const pairing = yield* selectPairing;
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
              yield* canvas.wipeCanvasAuthority();

              const effectiveConfiguration = request.configuration;
              yield* hostRows.ensure(admittedConfiguredAt);
              const hosts = yield* hostRows.upsert(request.host);
              const storedHost = hosts.hosts.find(
                (host) => host.id === request.configuration.hostId,
              );
              if (
                storedHost === undefined ||
                storedHost.kind !== "remote"
              ) {
                return yield* Effect.fail(new Error(
                  "configured Remote host registration was not persisted",
                ));
              }
              const registeredHost =
                yield* decodeRemoteHostRegistration(storedHost);
              if (current !== undefined) {
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
              yield* configurations.write(
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
            }))
            .pipe(
              Effect.provideService(StateTransactionOperation, "station.configure"),
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

        const outcome = yield* sql.withTransaction(Effect.gen(function* () {
            const current = yield* selectProjection;
            if (current !== undefined) {
              const currentActual = stationProjectionContentSha256(
                current.body,
              );
              const currentDeclared = current.content_sha256;
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
              yield* sql`INSERT INTO station_projection_versions(
                   generation,
                   content_sha256,
                   source_canvas_generation,
                   source_intent_sha256,
                   body,
                   created_at,
                   received_at
                 ) VALUES (${request.projection.generation}, ${request.projection.contentSha256},
                   ${request.projection.sourceCanvasGeneration}, ${request.projection.sourceIntentSha256},
                   ${request.projection.body}, ${admittedCreatedAt}, ${admittedReceivedAt})`;
              yield* sql`INSERT INTO station_projection_head(
                   singleton,
                   generation,
                   content_sha256
                 ) VALUES (1, ${request.projection.generation}, ${request.projection.contentSha256})
                 ON CONFLICT(singleton) DO UPDATE SET
                   generation = excluded.generation,
                   content_sha256 = excluded.content_sha256`;
              return {
                _tag: "decision" as const,
                decision,
                active: {
                  generation: request.projection.generation,
                  contentSha256: request.projection.contentSha256,
                  receivedAt: admittedReceivedAt,
                },
              };
            }
            return {
              _tag: "decision" as const,
              decision,
              active: projectionReferenceFromRow(current!),
            };
          }))
          .pipe(
            Effect.provideService(StateTransactionOperation, "station.install-projection"),
            Effect.mapError((error) =>
              persistenceError("install-projection", error),
            ),
          );

        if (outcome._tag === "corrupt") {
          return yield* StationProjectionIntegrityError.make({
            generation: outcome.row.generation,
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

      const statusFacts = withSqlRead(sql, Effect.gen(function* () {
          const pairing = yield* selectPairing;
          const configuration = yield* configurations.read;
          const projection = yield* selectProjection;
          const received = yield* receivedCursorRows(undefined);
          const peerAcks = yield* peerAckRows(undefined);
          return { pairing, configuration, projection, received, peerAcks };
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
            const configuration = rows.configuration;
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
                peerInstallationId: row.peer_installation_id,
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
    });

export const makeStationRepositoryLive = (
  options: StationRepositoryOptions = {},
): Layer.Layer<StationRepository, StationPersistenceError | StationMetadataError, SqlClient.SqlClient> =>
  Layer.effect(StationRepository, makeStationRepository(options)).pipe(Layer.provide([
    StationConfigurationRepository.layer,
    KnownInstallations.layer,
    HostRegistryRows.layer,
    CanvasRecordsLive,
  ]));

export const StationRepositoryLive = makeStationRepositoryLive();
