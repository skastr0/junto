import { Context, Effect, Result, Layer, Schema } from "effect";
import {
  HostId,
  type HostId as HostIdValue,
} from "@shared/remote-hosts";
import { DisplayTimestamp } from "@shared/station-api";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "@shared/installation-id";
import {
  StateEngine,
  type StateEngineError,
  type StateReader,
  type StateRow,
  type StateWriter,
} from "../state/service";
import { StationContextTagIds } from "./context-services";

/** Fleet identity is host + station installation only. SSH routes live on the host registry. */
export const StationFleetTargetIdentity = Schema.Struct({
  hostId: HostId,
  stationInstallationId: InstallationId,
});
export type StationFleetTargetIdentity =
  typeof StationFleetTargetIdentity.Type;

export const StationFleetTarget = Schema.Struct({
  ...StationFleetTargetIdentity.fields,
  boundAt: DisplayTimestamp,
});
export type StationFleetTarget = typeof StationFleetTarget.Type;

export class StationFleetTargetConflictError extends Schema.TaggedErrorClass<StationFleetTargetConflictError>()(
  "StationFleetTargetConflictError",
  {
    admitted: StationFleetTarget,
    rejected: StationFleetTargetIdentity,
  },
) {}

export class StationFleetTargetHostBindingImmutableError extends Schema.TaggedErrorClass<StationFleetTargetHostBindingImmutableError>()(
  "StationFleetTargetHostBindingImmutableError",
  {
    hostId: HostId,
    boundStationInstallationId: InstallationId,
    rejectedStationInstallationId: InstallationId,
    message: Schema.String,
  },
) {}

export class StationFleetTargetMetadataError extends Schema.TaggedErrorClass<StationFleetTargetMetadataError>()(
  "StationFleetTargetMetadataError",
  {
    operation: Schema.String,
    field: Schema.String,
    message: Schema.String,
  },
) {}

export class StationFleetTargetCorruptRecordError extends Schema.TaggedErrorClass<StationFleetTargetCorruptRecordError>()(
  "StationFleetTargetCorruptRecordError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export class StationFleetTargetPersistenceError extends Schema.TaggedErrorClass<StationFleetTargetPersistenceError>()(
  "StationFleetTargetPersistenceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export type StationFleetTargetRepositoryError =
  | StationFleetTargetConflictError
  | StationFleetTargetHostBindingImmutableError
  | StationFleetTargetMetadataError
  | StationFleetTargetCorruptRecordError
  | StationFleetTargetPersistenceError;

// Station plane: canonical Context.Service (effect v4).
export class StationFleetTargetRepository extends Context.Service<StationFleetTargetRepository,
  {
    readonly bind: (
      identity: StationFleetTargetIdentity,
      boundAt?: string,
    ) => Effect.Effect<
      StationFleetTarget,
      StationFleetTargetRepositoryError
    >;
    readonly get: (
      hostId: HostIdValue,
    ) => Effect.Effect<
      StationFleetTarget | undefined,
      | StationFleetTargetCorruptRecordError
      | StationFleetTargetPersistenceError
    >;
    readonly list: Effect.Effect<
      ReadonlyArray<StationFleetTarget>,
      | StationFleetTargetCorruptRecordError
      | StationFleetTargetPersistenceError
    >;
    readonly remove: (
      hostId: HostIdValue,
    ) => Effect.Effect<boolean, StationFleetTargetPersistenceError>;
    readonly subscribeChanges: (
      listener: (hostId: HostIdValue) => void,
    ) => () => void;
  }>()(StationContextTagIds.fleetTargetRepository) {}

type FleetTargetRow = StateRow & {
  readonly host_id: string;
  readonly station_installation_id: string;
  readonly bound_at: string;
  readonly retired_at: string | null;
};

const decodeTarget = Schema.decodeUnknownSync(StationFleetTarget);
const decodeIdentityEither = Schema.decodeUnknownResult(
  StationFleetTargetIdentity,
  { onExcessProperty: "error" },
);
const decodeTimestampEither = Schema.decodeUnknownResult(DisplayTimestamp);

const nowIso = (): string => new Date().toISOString();

const targetFromRow = (row: FleetTargetRow): StationFleetTarget => {
  try {
    return decodeTarget({
      hostId: row.host_id,
      stationInstallationId: row.station_installation_id,
      boundAt: row.bound_at,
    });
  } catch {
    throw StationFleetTargetCorruptRecordError.make({
      operation: "decode",
      message:
        `stored fleet target ${JSON.stringify(row.host_id)} ` +
        "does not satisfy the canonical Station fleet contract",
    });
  }
};

const selectByHostId = (
  reader: StateReader,
  hostId: HostIdValue,
): FleetTargetRow | undefined =>
  reader.get<FleetTargetRow>(
    `SELECT
       host_id,
       station_installation_id,
       bound_at,
       retired_at
     FROM station_fleet_targets
     WHERE host_id = ?
       AND retired_at IS NULL`,
    [hostId],
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

const selectBindingByHostId = (
  reader: StateReader,
  hostId: HostIdValue,
): FleetTargetRow | undefined =>
  reader.get<FleetTargetRow>(
    `SELECT
       host_id,
       station_installation_id,
       bound_at,
       retired_at
     FROM station_fleet_targets
     WHERE host_id = ?`,
    [hostId],
  );

const selectIdentityCollisions = (
  reader: StateReader,
  identity: StationFleetTargetIdentity,
): ReadonlyArray<FleetTargetRow> =>
  reader.all<FleetTargetRow>(
    `SELECT
       host_id,
       station_installation_id,
       bound_at,
       retired_at
     FROM station_fleet_targets
     WHERE host_id = ?
        OR station_installation_id = ?
     ORDER BY host_id`,
    [
      identity.hostId,
      identity.stationInstallationId,
    ],
  );

const persistenceError = (
  operation: string,
  error: StateEngineError,
):
  | StationFleetTargetCorruptRecordError
  | StationFleetTargetPersistenceError =>
  error.cause instanceof StationFleetTargetCorruptRecordError
    ? error.cause
    : StationFleetTargetPersistenceError.make({
        operation,
        message: error.message,
        cause: error,
      });

const admitTimestamp = (
  value: string,
): Effect.Effect<string, StationFleetTargetMetadataError> => {
  const decoded = decodeTimestampEither(value);
  return Result.isSuccess(decoded)
    ? Effect.succeed(decoded.success)
    : StationFleetTargetMetadataError.make({
        operation: "bind",
        field: "boundAt",
        message: "boundAt must contain between 1 and 64 characters",
      });
};

const admitIdentity = (
  value: StationFleetTargetIdentity,
): Effect.Effect<
  StationFleetTargetIdentity,
  StationFleetTargetMetadataError
> => {
  const decoded = decodeIdentityEither(value);
  return Result.isSuccess(decoded)
    ? Effect.succeed(decoded.success)
    : StationFleetTargetMetadataError.make({
        operation: "bind",
        field: "identity",
        message:
          "fleet target identity must contain a valid host and Station installation id",
      });
};

const sameIdentity = (
  target: StationFleetTarget,
  identity: StationFleetTargetIdentity,
): boolean =>
  target.hostId === identity.hostId &&
  target.stationInstallationId === identity.stationInstallationId;

export type StationFleetTargetRepositoryOptions = {
  readonly now?: () => string;
};

export const makeStationFleetTargetRepositoryLive = (
  options: StationFleetTargetRepositoryOptions = {},
): Layer.Layer<StationFleetTargetRepository, never, StateEngine> =>
  Layer.effect(
    StationFleetTargetRepository,
    Effect.gen(function* () {
      const engine = yield* StateEngine;
      const clock = options.now ?? nowIso;
      const listeners = new Set<(hostId: HostIdValue) => void>();

      const notify = (hostId: HostIdValue): void => {
        for (const listener of listeners) {
          try {
            listener(hostId);
          } catch (error) {
            // The SQLite transaction is already committed. A subscriber
            // cannot retroactively fail it and invite a duplicate retry.
            console.error(
              `[station-fleet-targets] change listener failed for ${JSON.stringify(hostId)}:`,
              error,
            );
          }
        }
      };

      const bind = Effect.fn("StationFleetTargetRepository.bind")(
        function* (
          identity: StationFleetTargetIdentity,
          boundAt = clock(),
        ) {
          const admittedIdentity = yield* admitIdentity(identity);
          const admittedBoundAt = yield* admitTimestamp(boundAt);
          const decision = yield* engine
            .transaction("station-fleet-target.bind", (writer) => {
              const establishedRow = selectBindingByHostId(
                writer,
                admittedIdentity.hostId,
              );
              const established = establishedRow === undefined
                ? undefined
                : targetFromRow(establishedRow);
              if (
                established !== undefined &&
                established.stationInstallationId !==
                  admittedIdentity.stationInstallationId
              ) {
                return {
                  _tag: "host-binding-immutable" as const,
                  established,
                };
              }

              const collisions = selectIdentityCollisions(
                writer,
                admittedIdentity,
              ).map(targetFromRow);
              const exact = collisions.find((target) =>
                sameIdentity(target, admittedIdentity)
              );
              if (exact !== undefined) {
                if (
                  establishedRow !== undefined &&
                  establishedRow.retired_at !== null
                ) {
                  writer.run(
                    `UPDATE station_fleet_targets
                     SET retired_at = NULL
                     WHERE host_id = ?`,
                    [admittedIdentity.hostId],
                  );
                }
                return {
                  _tag: "bound" as const,
                  target: exact,
                  changed:
                    establishedRow !== undefined &&
                    establishedRow.retired_at !== null,
                };
              }
              const conflict = collisions[0];
              if (conflict !== undefined) {
                return {
                  _tag: "conflict" as const,
                  admitted: conflict,
                };
              }
              const target: StationFleetTarget = {
                ...admittedIdentity,
                boundAt: admittedBoundAt,
              };
              registerKnownInstallation(
                writer,
                target.stationInstallationId,
                target.boundAt,
              );
              writer.run(
                `INSERT INTO station_fleet_targets(
                   host_id,
                   station_installation_id,
                   bound_at
                 ) VALUES (?, ?, ?)`,
                [
                  target.hostId,
                  target.stationInstallationId,
                  target.boundAt,
                ],
              );
              return {
                _tag: "bound" as const,
                target,
                changed: true,
              };
            })
            .pipe(
              Effect.mapError((error) => persistenceError("bind", error)),
            );

          if (decision._tag === "conflict") {
            return yield* StationFleetTargetConflictError.make({
              admitted: decision.admitted,
              rejected: admittedIdentity,
            });
          }
          if (decision._tag === "host-binding-immutable") {
            return yield* StationFleetTargetHostBindingImmutableError.make({
              hostId: admittedIdentity.hostId,
              boundStationInstallationId:
                decision.established.stationInstallationId,
              rejectedStationInstallationId:
                admittedIdentity.stationInstallationId,
              message:
                `host ${JSON.stringify(admittedIdentity.hostId)} is permanently bound to installation ` +
                `${JSON.stringify(decision.established.stationInstallationId)}; use a new host identity`,
            });
          }
          if (decision.changed) {
            yield* Effect.sync(() => notify(decision.target.hostId));
          }
          return decision.target;
        },
      );

      const get = (hostId: HostIdValue) =>
        engine
          .read("station-fleet-target.get", (reader) => {
            const row = selectByHostId(reader, hostId);
            return row === undefined ? undefined : targetFromRow(row);
          })
          .pipe(
            Effect.mapError((error) => persistenceError("get", error)),
            Effect.withSpan("station-fleet-target-repository.get", {
              attributes: { hostId },
            }),
          );

      const list = engine
        .read("station-fleet-target.list", (reader) =>
          reader
            .all<FleetTargetRow>(
              `SELECT
                 host_id,
                 station_installation_id,
                 bound_at,
                 retired_at
               FROM station_fleet_targets
               WHERE retired_at IS NULL
               ORDER BY host_id`,
            )
            .map(targetFromRow)
        )
        .pipe(
          Effect.mapError((error) => persistenceError("list", error)),
          Effect.withSpan("station-fleet-target-repository.list"),
        );

      const remove = Effect.fn("StationFleetTargetRepository.remove")(
        function* (hostId: HostIdValue) {
          const removed = yield* engine
            .transaction("station-fleet-target.remove", (writer) => {
              const result = writer.run(
                `UPDATE station_fleet_targets
                 SET retired_at = ?
                 WHERE host_id = ?
                   AND retired_at IS NULL`,
                [clock(), hostId],
              );
              return BigInt(result.changes) > 0n;
            })
            .pipe(
              Effect.mapError((error) =>
                StationFleetTargetPersistenceError.make({
                  operation: "remove",
                  message: error.message,
                  cause: error,
                })
              ),
            );
          if (removed) {
            yield* Effect.sync(() => notify(hostId));
          }
          return removed;
        },
      );

      const subscribeChanges = (
        listener: (hostId: HostIdValue) => void,
      ): (() => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      };

      return StationFleetTargetRepository.of({
        bind,
        get,
        list,
        remove,
        subscribeChanges,
      });
    }),
  );

export const StationFleetTargetRepositoryLive =
  makeStationFleetTargetRepositoryLive();
