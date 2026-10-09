import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema, type SqlError } from "effect/unstable/sql";
import { MachineName } from "@shared/machine-control";

export const MachineConfiguration = Schema.Struct({
  name: MachineName,
  supervisedPreferred: Schema.Boolean,
});
export type MachineConfiguration = typeof MachineConfiguration.Type;
export type StoredMachineConfiguration = {
  readonly configuration: MachineConfiguration;
  readonly configuredAt: string;
};

const ConfigurationRow = Schema.Struct({
  machine_name: MachineName,
  supervised_preferred: Schema.Literals([0, 1]),
  configured_at: Schema.String,
});

/** Writes participate in the caller's owning transaction. */
export class MachineConfigurationRepository extends Context.Service<MachineConfigurationRepository, {
  readonly read: Effect.Effect<StoredMachineConfiguration | undefined, SqlError.SqlError | Schema.SchemaError>;
  readonly write: (configuration: MachineConfiguration, configuredAt: string) => Effect.Effect<void, SqlError.SqlError | Schema.SchemaError>;
}>()("@junto/MachineConfigurationRepository") {
  static readonly layer = Layer.effect(this, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const select = SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: ConfigurationRow,
      execute: () => sql`SELECT machine_name, supervised_preferred, configured_at
        FROM machine_configuration WHERE singleton = 1`,
    });
    const read = select(undefined).pipe(Effect.map((result) => Option.isNone(result) ? undefined : {
      configuration: { name: result.value.machine_name, supervisedPreferred: result.value.supervised_preferred === 1 },
      configuredAt: result.value.configured_at,
    }));
    const write = Effect.fn("MachineConfigurationRepository.write")(function* (
      input: MachineConfiguration,
      configuredAt: string,
    ) {
      const configuration = yield* Schema.decodeUnknownEffect(MachineConfiguration)(input, { onExcessProperty: "error" });
      yield* sql`INSERT INTO machine_configuration(singleton, machine_name, supervised_preferred, configured_at)
        VALUES (1, ${configuration.name}, ${configuration.supervisedPreferred ? 1 : 0}, ${configuredAt})
        ON CONFLICT(singleton) DO UPDATE SET machine_name = excluded.machine_name,
          supervised_preferred = excluded.supervised_preferred, configured_at = excluded.configured_at`;
    });
    return { read, write };
  }));
}
