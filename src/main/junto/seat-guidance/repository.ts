import { Context, Effect, Layer, Schema } from "effect";
import {
  normalizeSeatGuidance,
  type SeatGuidance,
  type SeatGuidanceMap,
} from "@shared/seat-guidance";
import { StateEngine, type StateEngineError, type StateRow } from "../state/service";

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

type GuidanceRow = StateRow & {
  readonly seat_id: string;
  readonly soul: string | null;
  readonly instructions: string | null;
};

const fromRow = (row: GuidanceRow): SeatGuidance | null => {
  const normalized = normalizeSeatGuidance({ soul: row.soul ?? undefined, instructions: row.instructions ?? undefined });
  return normalized.ok ? normalized.guidance : null;
};

const persistence = (operation: string) => (error: StateEngineError) =>
  error.cause instanceof SeatGuidanceRefused
    ? error.cause
    : SeatGuidancePersistenceError.make({ operation, message: error.message, cause: error });

export const SeatGuidanceRepositoryLive: Layer.Layer<SeatGuidanceRepository, never, StateEngine> =
  Layer.effect(
    SeatGuidanceRepository,
    Effect.gen(function* () {
      const state = yield* StateEngine;

      const list = () =>
        state
          .read("seat-guidance.list", (reader) => {
            const out: Record<string, SeatGuidance> = {};
            for (const row of reader.all<GuidanceRow>("SELECT seat_id, soul, instructions FROM seat_guidance")) {
              const guidance = fromRow(row);
              if (guidance) out[row.seat_id] = guidance;
            }
            return out as SeatGuidanceMap;
          })
          .pipe(Effect.mapError(persistence("list")));

      const get = (seatId: string) =>
        state
          .read("seat-guidance.get", (reader) => {
            const row = reader.get<GuidanceRow>(
              "SELECT seat_id, soul, instructions FROM seat_guidance WHERE seat_id = ?",
              [seatId],
            );
            return row === undefined ? null : fromRow(row);
          })
          .pipe(Effect.mapError(persistence("get")));

      const set = (seatId: string, guidance: unknown) =>
        state
          .transaction("seat-guidance.set", (writer) => {
            const normalized = normalizeSeatGuidance(guidance);
            if (!normalized.ok) throw SeatGuidanceRefused.make({ message: normalized.message });
            if (normalized.guidance === null) {
              writer.run("DELETE FROM seat_guidance WHERE seat_id = ?", [seatId]);
              return null;
            }
            writer.run(
              `
                INSERT INTO seat_guidance(seat_id, soul, instructions, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(seat_id) DO UPDATE SET
                  soul = excluded.soul,
                  instructions = excluded.instructions,
                  updated_at = excluded.updated_at
              `,
              [
                seatId,
                normalized.guidance.soul ?? null,
                normalized.guidance.instructions ?? null,
                Date.now(),
              ],
            );
            return normalized.guidance;
          })
          .pipe(Effect.mapError(persistence("set")));

      return SeatGuidanceRepository.of({ list, get, set });
    }),
  );
