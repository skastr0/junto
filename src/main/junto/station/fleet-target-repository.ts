import { Context, Effect, Result, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import {
  HostId,
  type HostId as HostIdValue,
} from "@shared/remote-hosts";
import { DisplayTimestamp } from "@shared/station-api";
import { InstallationId } from "@shared/installation-id";
import { StateTransactionOperation } from "../state/service";
import { StationContextTagIds } from "./context-services";
import { KnownInstallations } from "./known-installations";

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

export class StationFleetTargetConflictError extends Schema.TaggedError<StationFleetTargetConflictError>()(
  "StationFleetTargetConflictError",
  {
    admitted: StationFleetTarget,
    rejected: StationFleetTargetIdentity,
  },
) {}

export class StationFleetTargetHostBindingImmutableError extends Schema.TaggedError<StationFleetTargetHostBindingImmutableError>()(
  "StationFleetTargetHostBindingImmutableError",
  {
    hostId: HostId,
    boundStationInstallationId: InstallationId,
    rejectedStationInstallationId: InstallationId,
    message: Schema.String,
  },
) {}

export class StationFleetTargetMetadataError extends Schema.TaggedError<StationFleetTargetMetadataError>()(
  "StationFleetTargetMetadataError",
  {
    operation: Schema.String,
    field: Schema.String,
    message: Schema.String,
  },
) {}

export class StationFleetTargetCorruptRecordError extends Schema.TaggedError<StationFleetTargetCorruptRecordError>()(
  "StationFleetTargetCorruptRecordError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export class StationFleetTargetPersistenceError extends Schema.TaggedError<StationFleetTargetPersistenceError>()(
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

const FleetTargetRow = Schema.Struct({
  host_id: HostId,
  station_installation_id: InstallationId,
  bound_at: DisplayTimestamp,
  retired_at: Schema.NullOr(Schema.String),
});
type FleetTargetRow = typeof FleetTargetRow.Type;

const decodeIdentityEither = Schema.decodeUnknownResult(
  StationFleetTargetIdentity,
  { onExcessProperty: "error" },
);
const decodeTimestampEither = Schema.decodeUnknownResult(DisplayTimestamp);

const nowIso = (): string => new Date().toISOString();

const targetFromRow = (row: FleetTargetRow): StationFleetTarget => ({
  hostId: row.host_id,
  stationInstallationId: row.station_installation_id,
  boundAt: row.bound_at,
});

const persistenceError = (
  operation: string,
  error: unknown,
):
  | StationFleetTargetCorruptRecordError
  | StationFleetTargetPersistenceError =>
  Schema.isSchemaError(error)
    ? StationFleetTargetCorruptRecordError.make({
        operation: "decode",
        message: "stored fleet target does not satisfy the canonical Station fleet contract",
      })
    : StationFleetTargetPersistenceError.make({
        operation,
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });

/** Physical deletion for host removal, distinct from fleet retirement. */
export class StationFleetTargetCleanup extends Context.Service<StationFleetTargetCleanup, {
  readonly deleteForHost: (hostId: string) => Effect.Effect<void, StationFleetTargetPersistenceError>;
}>()("@junto/StationFleetTargetCleanup") {
  static readonly layer = Layer.effect(this, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const deleteForHost = Effect.fn("StationFleetTargetCleanup.deleteForHost")(function* (hostId: string) {
      yield* sql`DELETE FROM station_fleet_targets WHERE host_id = ${hostId}`;
    }, Effect.mapError((cause) => StationFleetTargetPersistenceError.make({
      operation: "delete-for-host", message: cause.message, cause,
    })));
    return { deleteForHost };
  }));
}

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
): Layer.Layer<StationFleetTargetRepository, never, SqlClient.SqlClient> =>
  Layer.effect(
    StationFleetTargetRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const installations = yield* KnownInstallations;
      const clock = options.now ?? nowIso;
      const listeners = new Set<(hostId: HostIdValue) => void>();
      const selectBindingByHostId = SqlSchema.findOneOption({
        Request: Schema.String, Result: FleetTargetRow,
        execute: (hostId) => sql`SELECT host_id, station_installation_id, bound_at, retired_at
          FROM station_fleet_targets WHERE host_id = ${hostId}`,
      });
      const selectByHostId = SqlSchema.findOneOption({
        Request: Schema.String, Result: FleetTargetRow,
        execute: (hostId) => sql`SELECT host_id, station_installation_id, bound_at, retired_at
          FROM station_fleet_targets WHERE host_id = ${hostId} AND retired_at IS NULL`,
      });
      const selectIdentityCollisions = SqlSchema.findAll({
        Request: StationFleetTargetIdentity, Result: FleetTargetRow,
        execute: (identity) => sql`SELECT host_id, station_installation_id, bound_at, retired_at
          FROM station_fleet_targets WHERE host_id = ${identity.hostId}
            OR station_installation_id = ${identity.stationInstallationId} ORDER BY host_id`,
      });
      const selectAll = SqlSchema.findAll({
        Request: Schema.Void, Result: FleetTargetRow,
        execute: () => sql`SELECT host_id, station_installation_id, bound_at, retired_at
          FROM station_fleet_targets WHERE retired_at IS NULL ORDER BY host_id`,
      });

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
          const decision = yield* sql.withTransaction(Effect.gen(function* () {
              const establishedRow = Option.getOrUndefined(yield* selectBindingByHostId(admittedIdentity.hostId));
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

              const collisions = (yield* selectIdentityCollisions(admittedIdentity)).map(targetFromRow);
              const exact = collisions.find((target) =>
                sameIdentity(target, admittedIdentity)
              );
              if (exact !== undefined) {
                if (
                  establishedRow !== undefined &&
                  establishedRow.retired_at !== null
                ) {
                  yield* sql`UPDATE station_fleet_targets
                     SET retired_at = NULL
                     WHERE host_id = ${admittedIdentity.hostId}`;
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
              yield* installations.register(
                target.stationInstallationId,
                target.boundAt,
              );
              yield* sql`INSERT INTO station_fleet_targets(
                   host_id,
                   station_installation_id,
                   bound_at
                 ) VALUES (${target.hostId}, ${target.stationInstallationId}, ${target.boundAt})`;
              return {
                _tag: "bound" as const,
                target,
                changed: true,
              };
            }))
            .pipe(
              Effect.provideService(StateTransactionOperation, "station-fleet-target.bind"),
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

      const get = Effect.fn("StationFleetTargetRepository.get")(function* (hostId: HostIdValue) {
        const row = yield* selectByHostId(hostId);
        return Option.isNone(row) ? undefined : targetFromRow(row.value);
      }, Effect.mapError((error) => persistenceError("get", error)));

      const list = selectAll(undefined)
        .pipe(
          Effect.map((rows) => rows.map(targetFromRow)),
          Effect.mapError((error) => persistenceError("list", error)),
          Effect.withSpan("station-fleet-target-repository.list"),
        );

      const remove = Effect.fn("StationFleetTargetRepository.remove")(
        function* (hostId: HostIdValue) {
          const removed = yield* sql.withTransaction(Effect.gen(function* () {
              const result = yield* sql`UPDATE station_fleet_targets
                 SET retired_at = ${clock()}
                 WHERE host_id = ${hostId}
                   AND retired_at IS NULL`.raw.pipe(Effect.flatMap(
                     Schema.decodeUnknownEffect(Schema.Struct({ changes: Schema.Union([Schema.Number, Schema.BigInt]) })),
                   ));
              return BigInt(result.changes) > 0n;
            }))
            .pipe(
              Effect.provideService(StateTransactionOperation, "station-fleet-target.remove"),
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
  ).pipe(Layer.provide(KnownInstallations.layer));

export const StationFleetTargetRepositoryLive =
  makeStationFleetTargetRepositoryLive();
