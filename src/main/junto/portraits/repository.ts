import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlError, SqlSchema } from "effect/unstable/sql";
import {
  normalizePortraitOverride,
  type PortraitOverride,
  type PortraitOverrides,
} from "@shared/portrait-overrides";
import { StateTransactionOperation } from "../state/service";

export class PortraitOverridePersistenceError extends Schema.TaggedError<PortraitOverridePersistenceError>()(
  "PortraitOverridePersistenceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

/**
 * Per-seat portrait overrides (`portrait_overrides`). The operator authors
 * them in the character editor; every portrait of that seat wears them.
 */
export class PortraitOverrideRepository extends Context.Service<PortraitOverrideRepository,
  {
    /** Every seat's override, normalized; unreadable rows are skipped. */
    readonly list: () => Effect.Effect<PortraitOverrides, PortraitOverridePersistenceError>;
    /**
     * Replace one seat's override, or reset it with null (or an override
     * with nothing usable left). Returns the override as stored.
     */
    readonly set: (
      seatId: string,
      override: PortraitOverride | null,
    ) => Effect.Effect<PortraitOverride | null, PortraitOverridePersistenceError>;
  }>()("@junto/PortraitOverrideRepository") {}

const OverrideRow = Schema.Struct({ seat_id: Schema.String, body_json: Schema.String });

const parse = (body: string): PortraitOverride | null => {
  try {
    return normalizePortraitOverride(JSON.parse(body));
  } catch {
    return null;
  }
};

const persistence = (operation: string) => (error: SqlError.SqlError | Schema.SchemaError) =>
  PortraitOverridePersistenceError.make({ operation, message: error.message, cause: error });

export const PortraitOverrideRepositoryLive: Layer.Layer<
  PortraitOverrideRepository,
  never,
  SqlClient.SqlClient
> = Layer.effect(
  PortraitOverrideRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: OverrideRow,
      execute: () => sql`SELECT seat_id, body_json FROM portrait_overrides`,
    });

    const list = Effect.fn("portrait-overrides.list")(function* () {
      const out: Record<string, PortraitOverride> = {};
      for (const row of yield* rows(undefined)) {
        const override = parse(row.body_json);
        if (override) out[row.seat_id] = override;
      }
      return out as PortraitOverrides;
    }, Effect.mapError(persistence("list")));

    const set = Effect.fn("portrait-overrides.set")(function* (seatId: string, override: PortraitOverride | null) {
      // Normalized bodies are a few hundred bytes; the table CHECK bounds them.
      const normalized = override === null ? null : normalizePortraitOverride(override);
      if (normalized === null) {
        yield* sql`DELETE FROM portrait_overrides WHERE seat_id = ${seatId}`;
        return null;
      }
      yield* sql`
        INSERT INTO portrait_overrides(seat_id, body_json, updated_at)
        VALUES (${seatId}, ${JSON.stringify(normalized)}, ${Date.now()})
        ON CONFLICT(seat_id) DO UPDATE SET
          body_json = excluded.body_json,
          updated_at = excluded.updated_at
      `;
      return normalized;
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "portrait-overrides.set"), Effect.mapError(persistence("set")));

    return { list, set };
  }),
);
