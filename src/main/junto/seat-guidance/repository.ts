import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlError, SqlSchema } from "effect/unstable/sql";
import {
  normalizeSeatGuidance,
  type SeatGuidance,
  type SeatGuidanceMap,
} from "@shared/seat-guidance";
import { StateTransactionOperation } from "../state/service";

export class SeatGuidancePersistenceError extends Schema.TaggedError<SeatGuidancePersistenceError>()(
  "SeatGuidancePersistenceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

/** The operator's input cannot be saved (over its bound). */
export class SeatGuidanceRefused extends Schema.TaggedError<SeatGuidanceRefused>()(
  "SeatGuidanceRefused",
  { message: Schema.String },
) {}

export type SeatGuidanceRepositoryError = SeatGuidancePersistenceError | SeatGuidanceRefused;

/**
 * Per-seat soul and instructions (`seat_guidance`). The operator authors them
 * in the agent editor; the seat doctrine and `junto onboard` carry them.
 */
export class SeatGuidanceRepository extends Context.Service<SeatGuidanceRepository,
  {
    /** Every seat's guidance, normalized; unreadable rows are skipped. */
    readonly list: () => Effect.Effect<SeatGuidanceMap, SeatGuidanceRepositoryError>;
    readonly get: (seatId: string) => Effect.Effect<SeatGuidance | null, SeatGuidanceRepositoryError>;
    /** Replace one seat's guidance, or clear it with null (or nothing left). */
    readonly set: (
      seatId: string,
      guidance: unknown,
    ) => Effect.Effect<SeatGuidance | null, SeatGuidanceRepositoryError>;
  }>()("@junto/SeatGuidanceRepository") {}

const GuidanceRow = Schema.Struct({
  seat_id: Schema.String,
  soul: Schema.NullOr(Schema.String),
  instructions: Schema.NullOr(Schema.String),
});

const fromRow = (row: typeof GuidanceRow.Type): SeatGuidance | null => {
  const normalized = normalizeSeatGuidance({ soul: row.soul ?? undefined, instructions: row.instructions ?? undefined });
  return normalized.ok ? normalized.guidance : null;
};

const persistence = (operation: string) => (error: SqlError.SqlError | Schema.SchemaError | SeatGuidanceRefused) =>
  error instanceof SeatGuidanceRefused
    ? error
    : SeatGuidancePersistenceError.make({ operation, message: error.message, cause: error });

export const SeatGuidanceRepositoryLive: Layer.Layer<SeatGuidanceRepository, never, SqlClient.SqlClient> =
  Layer.effect(
    SeatGuidanceRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const allRows = SqlSchema.findAll({
        Request: Schema.Void,
        Result: GuidanceRow,
        execute: () => sql`SELECT seat_id, soul, instructions FROM seat_guidance`,
      });
      const oneRow = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: GuidanceRow,
        execute: (seatId) => sql`SELECT seat_id, soul, instructions FROM seat_guidance WHERE seat_id = ${seatId}`,
      });

      const list = Effect.fn("seat-guidance.list")(function* () {
        const out: Record<string, SeatGuidance> = {};
        for (const row of yield* allRows(undefined)) {
          const guidance = fromRow(row);
          if (guidance) out[row.seat_id] = guidance;
        }
        return out;
      }, Effect.mapError(persistence("list")));

      const get = Effect.fn("seat-guidance.get")(function* (seatId: string) {
        const row = yield* oneRow(seatId);
        return Option.isNone(row) ? null : fromRow(row.value);
      }, Effect.mapError(persistence("get")));

      const set = Effect.fn("seat-guidance.set")(function* (seatId: string, guidance: unknown) {
        const normalized = normalizeSeatGuidance(guidance);
        if (!normalized.ok) return yield* new SeatGuidanceRefused({ message: normalized.message });
        if (normalized.guidance === null) {
          yield* sql`DELETE FROM seat_guidance WHERE seat_id = ${seatId}`;
          return null;
        }
        yield* sql`
          INSERT INTO seat_guidance(seat_id, soul, instructions, updated_at)
          VALUES (${seatId}, ${normalized.guidance.soul ?? null}, ${normalized.guidance.instructions ?? null}, ${Date.now()})
          ON CONFLICT(seat_id) DO UPDATE SET
            soul = excluded.soul,
            instructions = excluded.instructions,
            updated_at = excluded.updated_at
        `;
        return normalized.guidance;
      }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "seat-guidance.set"), Effect.mapError(persistence("set")));

      return SeatGuidanceRepository.of({ list, get, set });
    }),
  );
