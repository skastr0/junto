import { Context, Effect, Layer, Schema } from "effect";
import {
  PAUSED_CANVAS,
  type CanvasPauseState,
} from "@shared/pause";
import {
  StateEngine,
  type StateEngineError,
  type StateReader,
  type StateRow,
} from "../state/service";

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

type CanvasRow = StateRow & {
  readonly canvas_name: string;
  readonly playing: number;
  readonly ever_played: number;
};

const persistenceError = (
  operation: string,
  error: StateEngineError,
): FactoryPauseRepositoryError =>
  FactoryPausePersistenceError.make({
    operation,
    message: error.message,
    cause: error,
  });

const stateForCanvas = (
  reader: StateReader,
  canvasName: string,
): CanvasPauseState => {
  const canvas = reader.get<CanvasRow>(
    `
      SELECT canvas_name, playing, ever_played
      FROM factory_pause_canvases
      WHERE canvas_name = ?
    `,
    [canvasName],
  );
  if (canvas === undefined) return PAUSED_CANVAS;
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
  StateEngine
> = Layer.effect(
  FactoryPauseRepository,
  Effect.gen(function* () {
    const state = yield* StateEngine;

    const loadAll = state
      .read("factory-pause.load-all", (reader) => {
        const canvases = reader.all<CanvasRow>(
          `
            SELECT canvas_name, playing, ever_played
            FROM factory_pause_canvases
            ORDER BY canvas_name
          `,
        );
        return new Map(
          canvases.map((canvas) => [
            canvas.canvas_name,
            stateForCanvas(reader, canvas.canvas_name),
          ]),
        );
      })
      .pipe(Effect.mapError((error) => persistenceError("load all", error)));

    const setPlaying = (canvasName: string, playing: boolean) =>
      state
        .transaction("factory-pause.set-playing", (writer) => {
          const current = writer.get<CanvasRow>(
            `
              SELECT canvas_name, playing, ever_played
              FROM factory_pause_canvases
              WHERE canvas_name = ?
            `,
            [canvasName],
          );
          if (current === undefined && !playing) return PAUSED_CANVAS;
          writer.run(
            `
              INSERT INTO factory_pause_canvases(
                canvas_name,
                playing,
                ever_played,
                updated_at
              ) VALUES (?, ?, ?, ?)
              ON CONFLICT(canvas_name) DO UPDATE SET
                playing = excluded.playing,
                ever_played = excluded.ever_played,
                updated_at = excluded.updated_at
            `,
            [
              canvasName,
              playing ? 1 : 0,
              current?.ever_played === 1 || playing ? 1 : 0,
              new Date().toISOString(),
            ],
          );
          return stateForCanvas(writer, canvasName);
        })
        .pipe(
          Effect.mapError((error) =>
            persistenceError(
              `${playing ? "play" : "pause"} canvas ${canvasName}`,
              error,
            )
          ),
        );

    return FactoryPauseRepository.of({
      loadAll,
      setPlaying,
    });
  }),
);
