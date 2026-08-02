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

export type PauseMemberScope =
  | { readonly kind: "node"; readonly id: string }
  | { readonly kind: "region"; readonly id: string };

export class FactoryPausePersistenceError extends Schema.TaggedErrorClass<FactoryPausePersistenceError>()(
  "FactoryPausePersistenceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export class FactoryPauseStateCorruptError extends Schema.TaggedErrorClass<FactoryPauseStateCorruptError>()(
  "FactoryPauseStateCorruptError",
  {
    canvasName: Schema.String,
    message: Schema.String,
  },
) {}

export type FactoryPauseRepositoryError =
  | FactoryPausePersistenceError
  | FactoryPauseStateCorruptError;

/**
 * effect-foundation **S4-rest-main** (staged, not half-migrated):
 * - Canonical id: `@vellum/FactoryPauseRepository` — single definition; no dual path.
 * - Substrate: effect@3.21 → `Context.Tag` (`Context.Service` unavailable).
 * - V4 target:
 *   `class FactoryPauseRepository extends Context.Service<FactoryPauseRepository, FactoryPauseRepository>()("@vellum/FactoryPauseRepository") {}`
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
    readonly setMemberPaused: (
      canvasName: string,
      scope: PauseMemberScope,
      paused: boolean,
    ) => Effect.Effect<CanvasPauseState, FactoryPauseRepositoryError>;
  }>()("@vellum/FactoryPauseRepository") {}

type CanvasRow = StateRow & {
  readonly canvas_name: string;
  readonly playing: number;
  readonly ever_played: number;
};

type ScopeRow = StateRow & {
  readonly canvas_name: string;
  readonly scope_kind: string;
  readonly scope_id: string;
};

const persistenceError = (
  operation: string,
  error: StateEngineError,
): FactoryPauseRepositoryError =>
  error.cause instanceof FactoryPauseStateCorruptError
    ? error.cause
    : FactoryPausePersistenceError.make({
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
  const scopes = reader.all<ScopeRow>(
    `
      SELECT canvas_name, scope_kind, scope_id
      FROM factory_pause_scopes
      WHERE canvas_name = ?
      ORDER BY scope_kind, scope_id
    `,
    [canvasName],
  );
  const pausedNodes: string[] = [];
  const pausedRegions: string[] = [];
  for (const scope of scopes) {
    if (scope.scope_kind === "node") {
      pausedNodes.push(scope.scope_id);
    } else if (scope.scope_kind === "region") {
      pausedRegions.push(scope.scope_id);
    } else {
      throw FactoryPauseStateCorruptError.make({
        canvasName,
        message: `unknown persisted pause scope ${scope.scope_kind}`,
      });
    }
  }
  return {
    playing: canvas.playing === 1,
    everPlayed: canvas.ever_played === 1,
    pausedNodes,
    pausedRegions,
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

    const setMemberPaused = (
      canvasName: string,
      scope: PauseMemberScope,
      paused: boolean,
    ) =>
      state
        .transaction("factory-pause.set-member-paused", (writer) => {
          if (paused) {
            const now = new Date().toISOString();
            writer.run(
              `
                INSERT OR IGNORE INTO factory_pause_canvases(
                  canvas_name,
                  playing,
                  ever_played,
                  updated_at
                ) VALUES (?, 0, 0, ?)
              `,
              [canvasName, now],
            );
            writer.run(
              `
                INSERT INTO factory_pause_scopes(
                  canvas_name,
                  scope_kind,
                  scope_id,
                  paused_at
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(canvas_name, scope_kind, scope_id) DO UPDATE SET
                  paused_at = excluded.paused_at
              `,
              [canvasName, scope.kind, scope.id, now],
            );
          } else {
            writer.run(
              `
                DELETE FROM factory_pause_scopes
                WHERE canvas_name = ? AND scope_kind = ? AND scope_id = ?
              `,
              [canvasName, scope.kind, scope.id],
            );
          }
          return stateForCanvas(writer, canvasName);
        })
        .pipe(
          Effect.mapError((error) =>
            persistenceError(
              `${paused ? "pause" : "resume"} ${scope.kind} ${
                scope.id
              } on ${canvasName}`,
              error,
            )
          ),
        );

    return FactoryPauseRepository.of({
      loadAll,
      setPlaying,
      setMemberPaused,
    });
  }),
);
