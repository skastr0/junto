import { Context, Effect, Layer } from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import type { InstallationId } from "@shared/installation-id";

/** Registration participates in the transaction that first references an installation. */
export class KnownInstallations extends Context.Service<KnownInstallations, {
  readonly register: (installationId: InstallationId, registeredAt: string) => Effect.Effect<void, SqlError.SqlError>;
}>()("@junto/KnownInstallations") {
  static readonly layer = Layer.effect(this, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const register = Effect.fn("KnownInstallations.register")(function* (
      installationId: InstallationId,
      registeredAt: string,
    ) {
      yield* sql`INSERT INTO station_known_installations(installation_id, registered_at)
        VALUES (${installationId}, ${registeredAt})
        ON CONFLICT(installation_id) DO NOTHING`;
    });
    return { register };
  }));
}
