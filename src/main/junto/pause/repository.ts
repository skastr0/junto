import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlError, SqlSchema } from "effect/unstable/sql";
import {
  PAUSED_CANVAS,
  type CanvasPauseState,
} from "@shared/pause";
import { StateTransactionOperation } from "../state/service";

export class FactoryPausePersistenceError extends Schema.TaggedError<FactoryPausePersistenceError>()(
  "FactoryPausePersistenceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export type FactoryPauseRepositoryError = FactoryPausePersistenceError;

/**
 * effect-foundation **S4-rest-main** (staged, not half-migrated):
 * - Canonical id: `@junto/FactoryPauseRepository` — single definition; no dual path.
 * - Service id: Context.Service (Effect V4 live).
 * - Shape:
 *   `class FactoryPauseRepository extends Context.Service<FactoryPauseRepository, FactoryPauseRepository>()("@junto/FactoryPauseRepository") {}`
 * - Layer today: FactoryPauseRepositoryLive — V4 rename candidate FactoryPauseRepository.layer
 *   Do not dual-export Live + `.layer` names.
 */
export class FactoryPauseRepository extends Context.Service<FactoryPauseRepository,
  {
    readonly loadAll: Effect.Effect<
      ReadonlyMap<string, CanvasPauseState>,
      FactoryPauseRepositoryError
    >;
    readonly setPlaying: (
      canvasName: string,
      playing: boolean,
    ) => Effect.Effect<CanvasPauseState, FactoryPauseRepositoryError>;
  }>()("@junto/FactoryPauseRepository") {}

const CanvasRow = Schema.Struct({
  canvas_name: Schema.String,
  playing: Schema.Number,
  ever_played: Schema.Number,
});

const persistenceError = (
  operation: string,
  error: SqlError.SqlError | Schema.SchemaError,
): FactoryPauseRepositoryError =>
  FactoryPausePersistenceError.make({
    operation,
    message: error.message,
    cause: error,
  });

const stateForCanvas = (canvas: typeof CanvasRow.Type | undefined): CanvasPauseState => {
  if (!canvas) return PAUSED_CANVAS;
  // factory_pause_scopes (retired node and region pause) is never read:
  // its rows stay inert in the schema.
  return {
    playing: canvas.playing === 1,
    everPlayed: canvas.ever_played === 1,
  };
};

export const FactoryPauseRepositoryLive: Layer.Layer<
  FactoryPauseRepository,
  never,
  SqlClient.SqlClient
> = Layer.effect(
  FactoryPauseRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const allRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: CanvasRow,
      execute: () => sql`
        SELECT canvas_name, playing, ever_played
        FROM factory_pause_canvases ORDER BY canvas_name
      `,
    });
    const oneRow = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: CanvasRow,
      execute: (name) => sql`
        SELECT canvas_name, playing, ever_played
        FROM factory_pause_canvases WHERE canvas_name = ${name}
      `,
    });

    const loadAll = Effect.fn("factory-pause.load-all")(function* () {
      return new Map((yield* allRows(undefined)).map((canvas) => [canvas.canvas_name, stateForCanvas(canvas)]));
    }, Effect.mapError((error) => persistenceError("load all", error)))();

    const setPlaying = Effect.fn("factory-pause.set-playing")(function* (canvasName: string, playing: boolean) {
      const currentOption = yield* oneRow(canvasName);
      const current = currentOption._tag === "Some" ? currentOption.value : undefined;
      if (current === undefined && !playing) return PAUSED_CANVAS;
      yield* sql`
        INSERT INTO factory_pause_canvases(canvas_name, playing, ever_played, updated_at)
        VALUES (${canvasName}, ${playing ? 1 : 0}, ${current?.ever_played === 1 || playing ? 1 : 0}, ${new Date().toISOString()})
        ON CONFLICT(canvas_name) DO UPDATE SET
          playing = excluded.playing,
          ever_played = excluded.ever_played,
          updated_at = excluded.updated_at
      `;
      const updated = yield* oneRow(canvasName);
      return stateForCanvas(updated._tag === "Some" ? updated.value : undefined);
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "factory-pause.set-playing"),
    Effect.mapError((error) => persistenceError("set playing", error)));

    return FactoryPauseRepository.of({
      loadAll,
      setPlaying,
    });
  }),
);
