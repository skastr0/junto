import { Context, Effect, Layer, Schema } from "effect";
import {
  normalizePortraitOverride,
  type PortraitOverride,
  type PortraitOverrides,
} from "@shared/portrait-overrides";
import { StateEngine, type StateEngineError, type StateRow } from "../state/service";

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

type OverrideRow = StateRow & {
  readonly seat_id: string;
  readonly body_json: string;
};

const parse = (body: string): PortraitOverride | null => {
  try {
    return normalizePortraitOverride(JSON.parse(body));
  } catch {
    return null;
  }
};

const persistence = (operation: string) => (error: StateEngineError) =>
  PortraitOverridePersistenceError.make({ operation, message: error.message, cause: error });

export const PortraitOverrideRepositoryLive: Layer.Layer<
  PortraitOverrideRepository,
  never,
  StateEngine
> = Layer.effect(
  PortraitOverrideRepository,
  Effect.gen(function* () {
    const state = yield* StateEngine;

    const list = () =>
      state
        .read("portrait-overrides.list", (reader) => {
          const out: Record<string, PortraitOverride> = {};
          for (const row of reader.all<OverrideRow>("SELECT seat_id, body_json FROM portrait_overrides")) {
            const override = parse(row.body_json);
            if (override) out[row.seat_id] = override;
          }
          return out as PortraitOverrides;
        })
        .pipe(Effect.mapError(persistence("list")));

    const set = (seatId: string, override: PortraitOverride | null) =>
      state
        .transaction("portrait-overrides.set", (writer) => {
          // Normalized bodies are a few hundred bytes; the table CHECK bounds them.
          const normalized = override === null ? null : normalizePortraitOverride(override);
          if (normalized === null) {
            writer.run("DELETE FROM portrait_overrides WHERE seat_id = ?", [seatId]);
            return null;
          }
          writer.run(
            `
              INSERT INTO portrait_overrides(seat_id, body_json, updated_at)
              VALUES (?, ?, ?)
              ON CONFLICT(seat_id) DO UPDATE SET
                body_json = excluded.body_json,
                updated_at = excluded.updated_at
            `,
            [seatId, JSON.stringify(normalized), Date.now()],
          );
          return normalized;
        })
        .pipe(Effect.mapError(persistence("set")));

    return { list, set };
  }),
);
