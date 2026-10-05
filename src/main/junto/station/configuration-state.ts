import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema, type SqlError } from "effect/unstable/sql";
import {
  StationConfiguration,
  type StationConfiguration as StationConfigurationValue,
} from "@shared/station-api";
import {
  defaultStation,
  type StationSettings,
} from "@shared/settings";

/**
 * The one durable station-topology representation.
 *
 * Absence is the explicit pre-configuration state. A present row is always a
 * complete StationConfiguration; Remote identity is never reconstructed from
 * the smaller renderer-facing Settings aggregate.
 */
export type StoredStationConfiguration = {
  readonly configuration: StationConfigurationValue;
  readonly configuredAt: string;
};

const ConfigurationRow = Schema.Struct({
  role: Schema.String,
  host_id: Schema.String,
  agent_host_id: Schema.NullOr(Schema.String),
  command_center_installation_id: Schema.NullOr(Schema.String),
  supervised_preferred: Schema.Number,
  configured_at: Schema.String,
});

/** Leaf participant: writes join the caller's SQL transaction. */
export class StationConfigurationRepository extends Context.Service<StationConfigurationRepository, {
  readonly read: Effect.Effect<StoredStationConfiguration | undefined, SqlError.SqlError | Schema.SchemaError>;
  readonly write: (configuration: StationConfigurationValue, configuredAt: string) => Effect.Effect<void, SqlError.SqlError>;
}>()("@junto/StationConfigurationRepository") {
  static readonly layer = Layer.effect(this, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const select = SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: ConfigurationRow,
      execute: () => sql`SELECT role, host_id, agent_host_id,
        command_center_installation_id, supervised_preferred, configured_at
        FROM station_configuration WHERE singleton = 1`,
    });
    const read = Effect.gen(function* () {
      const result = yield* select(undefined);
      if (Option.isNone(result)) return undefined;
      const row = result.value;
      const configuration = yield* Schema.decodeUnknownEffect(StationConfiguration)(
        row.role === "command-center"
          ? { role: row.role, hostId: row.host_id, supervisedPreferred: row.supervised_preferred === 1 }
          : {
              role: row.role, hostId: row.host_id, agentHostId: row.agent_host_id,
              commandCenterInstallationId: row.command_center_installation_id,
              supervisedPreferred: row.supervised_preferred === 1,
            },
      );
      return { configuration, configuredAt: row.configured_at };
    }).pipe(Effect.withSpan("StationConfigurationRepository.read"));
    const write = Effect.fn("StationConfigurationRepository.write")(function* (
      configuration: StationConfigurationValue,
      configuredAt: string,
    ) {
      const remote = configuration.role === "remote" ? configuration : undefined;
      yield* sql`INSERT INTO station_configuration(
        singleton, role, host_id, agent_host_id, command_center_installation_id,
        supervised_preferred, configured_at
      ) VALUES (1, ${configuration.role}, ${configuration.hostId}, ${remote?.agentHostId ?? null},
        ${remote?.commandCenterInstallationId ?? null}, ${configuration.supervisedPreferred ? 1 : 0}, ${configuredAt})
      ON CONFLICT(singleton) DO UPDATE SET
        role = excluded.role, host_id = excluded.host_id, agent_host_id = excluded.agent_host_id,
        command_center_installation_id = excluded.command_center_installation_id,
        supervised_preferred = excluded.supervised_preferred, configured_at = excluded.configured_at`;
    });
    return { read, write };
  }));
}

/** Public Settings aggregate derived from canonical normalized state. */
export const stationSettingsFromConfiguration = (
  stored: StoredStationConfiguration | undefined,
): StationSettings => {
  if (stored === undefined) return defaultStation();
  const configuration = stored.configuration;
  return configuration.role === "command-center"
    ? {
        role: "command-center",
        hostId: configuration.hostId,
        supervisedPreferred: configuration.supervisedPreferred,
      }
    : {
        role: "remote",
        hostId: configuration.hostId,
        agentHostId: configuration.agentHostId,
        supervisedPreferred: configuration.supervisedPreferred,
      };
};
