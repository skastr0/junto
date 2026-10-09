import { randomUUID } from "node:crypto";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { InstallationId } from "@shared/installation-id";
import { StateTransactionOperation } from "../state/service";
import { withSqlRead } from "../state/sql-read";
import { StationConfigurationRepository, type StoredStationConfiguration } from "./configuration-state";
import { KnownInstallations } from "./known-installations";

export class StationPersistenceError extends Schema.TaggedError<StationPersistenceError>()(
  "StationPersistenceError",
  { operation: Schema.String, message: Schema.String, cause: Schema.Unknown },
) {}

export type StationRepositoryError = StationPersistenceError;

export class StationRepository extends Context.Service<StationRepository, {
  readonly installationId: Effect.Effect<InstallationId, StationRepositoryError>;
  readonly configuration: Effect.Effect<StoredStationConfiguration | undefined, StationRepositoryError>;
}>()("@junto/StationRepository") {}

const InstallationRow = Schema.Struct({
  installation_id: InstallationId,
  created_at: Schema.String,
});

const persistenceError = (operation: string, cause: unknown) =>
  StationPersistenceError.make({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

export type StationRepositoryOptions = {
  readonly makeInstallationId?: () => InstallationId;
  readonly now?: () => string;
};

export const makeStationRepository = (options: StationRepositoryOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const configurations = yield* StationConfigurationRepository;
    const installations = yield* KnownInstallations;
    const findInstallation = SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: InstallationRow,
      execute: () => sql`SELECT installation_id, created_at FROM station_installation WHERE singleton = 1`,
    });
    const installationId = yield* sql.withTransaction(Effect.gen(function* () {
      const existing = yield* findInstallation(undefined);
      if (Option.isSome(existing)) return existing.value.installation_id;
      const generated = yield* Effect.try(() =>
        (options.makeInstallationId ?? (() => Schema.decodeUnknownSync(InstallationId)(randomUUID())))(),
      );
      const created = yield* Schema.decodeUnknownEffect(InstallationId)(generated);
      const createdAt = (options.now ?? (() => new Date().toISOString()))();
      yield* installations.register(created, createdAt);
      yield* sql`INSERT INTO station_installation(singleton, installation_id, created_at)
        VALUES (1, ${created}, ${createdAt})`;
      return created;
    })).pipe(
      Effect.provideService(StateTransactionOperation, "machine.ensure-installation"),
      Effect.mapError((cause) => persistenceError("ensure-installation", cause)),
    );
    return StationRepository.of({
      installationId: Effect.succeed(installationId),
      configuration: withSqlRead(sql, configurations.read).pipe(
        Effect.mapError((cause) => persistenceError("configuration", cause)),
      ),
    });
  });

export const makeStationRepositoryLive = (options: StationRepositoryOptions = {}) =>
  Layer.effect(StationRepository, makeStationRepository(options)).pipe(
    Layer.provide([StationConfigurationRepository.layer, KnownInstallations.layer]),
  );

export const StationRepositoryLive = makeStationRepositoryLive();
