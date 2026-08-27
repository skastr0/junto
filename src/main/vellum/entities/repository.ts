import { Context, Effect, Layer, Schema } from "effect";
import {
  EntityLifecycle,
  type EntityKey,
  type EntityLifecycle as EntityLifecycleT,
  entityKeyOf,
} from "@shared/entity";
import {
  StateEngine,
  type StateEngineError,
  type StateRow,
} from "../state/service";
import { softDeleteCanvasEntity } from "./sync";

export class CanvasEntityPersistenceError extends Schema.TaggedError<CanvasEntityPersistenceError>()(
  "CanvasEntityPersistenceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export class CanvasEntityNotArchivedError extends Schema.TaggedError<CanvasEntityNotArchivedError>()(
  "CanvasEntityNotArchivedError",
  {
    canvasName: Schema.String,
    entityId: Schema.String,
    lifecycle: EntityLifecycle,
  },
) {}

export class CanvasEntityMissingError extends Schema.TaggedError<CanvasEntityMissingError>()(
  "CanvasEntityMissingError",
  {
    canvasName: Schema.String,
    entityId: Schema.String,
  },
) {}

export type CanvasEntityRepositoryError =
  | CanvasEntityPersistenceError
  | CanvasEntityNotArchivedError
  | CanvasEntityMissingError;

export type CanvasEntityRecord = {
  readonly key: EntityKey;
  readonly kind: string | null;
  readonly bindingId: string | null;
  readonly lifecycle: EntityLifecycleT;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly softDeletedAt: string | null;
};

type EntitySqlRow = StateRow & {
  readonly canvas_name: string;
  readonly entity_id: string;
  readonly kind: string | null;
  readonly binding_id: string | null;
  readonly lifecycle: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: string | null;
  readonly soft_deleted_at: string | null;
};

const decodeLifecycle = (value: string): EntityLifecycleT => {
  if (
    value === "active" ||
    value === "archived" ||
    value === "soft_deleted"
  ) {
    return value;
  }
  throw new Error(`invalid entity lifecycle: ${value}`);
};

const fromRow = (row: EntitySqlRow): CanvasEntityRecord => ({
  key: entityKeyOf(row.canvas_name, row.entity_id),
  kind: row.kind,
  bindingId: row.binding_id,
  lifecycle: decodeLifecycle(row.lifecycle),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  archivedAt: row.archived_at,
  softDeletedAt: row.soft_deleted_at,
});

const persistenceError = (
  operation: string,
  error: StateEngineError,
): CanvasEntityPersistenceError =>
  CanvasEntityPersistenceError.make({
    operation,
    message: error.message,
    cause: error,
  });

export class CanvasEntityRepository extends Context.Service<CanvasEntityRepository,
  {
    readonly get: (
      canvasName: string,
      entityId: string,
    ) => Effect.Effect<CanvasEntityRecord | undefined, CanvasEntityRepositoryError>;
    readonly listByCanvas: (
      canvasName: string,
      options?: { readonly lifecycle?: EntityLifecycleT },
    ) => Effect.Effect<
      ReadonlyArray<CanvasEntityRecord>,
      CanvasEntityRepositoryError
    >;
    /** Historic-searchable rows (active + archived). Soft-deleted excluded. */
    readonly listHistoric: (
      canvasName: string,
    ) => Effect.Effect<
      ReadonlyArray<CanvasEntityRecord>,
      CanvasEntityRepositoryError
    >;
    /**
     * Entity ids that must not be re-minted by portfolio merge (archived or
     * soft_deleted). Active ids are omitted — they already have membership.
     */
    readonly listSuppressedEntityIds: (
      canvasName: string,
    ) => Effect.Effect<ReadonlySet<string>, CanvasEntityRepositoryError>;
    /**
     * Soft-delete from archive only. No hard-delete product path.
     * Soft-deleted entities are unindexed for historic search.
     */
    readonly softDelete: (
      canvasName: string,
      entityId: string,
    ) => Effect.Effect<CanvasEntityRecord, CanvasEntityRepositoryError>;
  }>()("@vellum/CanvasEntityRepository") {}

export const CanvasEntityRepositoryLive: Layer.Layer<
  CanvasEntityRepository,
  never,
  StateEngine
> = Layer.effect(
  CanvasEntityRepository,
  Effect.gen(function* () {
    const state = yield* StateEngine;

    const get = (
      canvasName: string,
      entityId: string,
    ): Effect.Effect<
      CanvasEntityRecord | undefined,
      CanvasEntityRepositoryError
    > =>
      state
        .read("canvas-entity.get", (reader) => {
          const row = reader.get<EntitySqlRow>(
            `
              SELECT
                canvas_name,
                entity_id,
                kind,
                binding_id,
                lifecycle,
                created_at,
                updated_at,
                archived_at,
                soft_deleted_at
              FROM canvas_entities
              WHERE canvas_name = ?
                AND entity_id = ?
            `,
            [canvasName, entityId],
          );
          return row === undefined ? undefined : fromRow(row);
        })
        .pipe(Effect.mapError((error) => persistenceError("get", error)));

    const listByCanvas = (
      canvasName: string,
      options?: { readonly lifecycle?: EntityLifecycleT },
    ): Effect.Effect<
      ReadonlyArray<CanvasEntityRecord>,
      CanvasEntityRepositoryError
    > =>
      state
        .read("canvas-entity.list", (reader) => {
          if (options?.lifecycle !== undefined) {
            return reader
              .all<EntitySqlRow>(
                `
                  SELECT
                    canvas_name,
                    entity_id,
                    kind,
                    binding_id,
                    lifecycle,
                    created_at,
                    updated_at,
                    archived_at,
                    soft_deleted_at
                  FROM canvas_entities
                  WHERE canvas_name = ?
                    AND lifecycle = ?
                  ORDER BY updated_at, entity_id
                `,
                [canvasName, options.lifecycle],
              )
              .map(fromRow);
          }
          return reader
            .all<EntitySqlRow>(
              `
                SELECT
                  canvas_name,
                  entity_id,
                  kind,
                  binding_id,
                  lifecycle,
                  created_at,
                  updated_at,
                  archived_at,
                  soft_deleted_at
                FROM canvas_entities
                WHERE canvas_name = ?
                ORDER BY lifecycle, updated_at, entity_id
              `,
              [canvasName],
            )
            .map(fromRow);
        })
        .pipe(Effect.mapError((error) => persistenceError("list", error)));

    const listHistoric = (
      canvasName: string,
    ): Effect.Effect<
      ReadonlyArray<CanvasEntityRecord>,
      CanvasEntityRepositoryError
    > =>
      state
        .read("canvas-entity.list-historic", (reader) =>
          reader
            .all<EntitySqlRow>(
              `
                SELECT
                  canvas_name,
                  entity_id,
                  kind,
                  binding_id,
                  lifecycle,
                  created_at,
                  updated_at,
                  archived_at,
                  soft_deleted_at
                FROM canvas_entities
                WHERE canvas_name = ?
                  AND lifecycle IN ('active', 'archived')
                ORDER BY lifecycle, updated_at, entity_id
              `,
              [canvasName],
            )
            .map(fromRow),
        )
        .pipe(
          Effect.mapError((error) =>
            persistenceError("listHistoric", error),
          ),
        );

    const listSuppressedEntityIds = (
      canvasName: string,
    ): Effect.Effect<ReadonlySet<string>, CanvasEntityRepositoryError> =>
      state
        .read("canvas-entity.list-suppressed", (reader) => {
          const rows = reader.all<{ readonly entity_id: string }>(
            `
              SELECT entity_id
              FROM canvas_entities
              WHERE canvas_name = ?
                AND lifecycle IN ('archived', 'soft_deleted')
            `,
            [canvasName],
          );
          return new Set(rows.map((row) => row.entity_id));
        })
        .pipe(
          Effect.mapError((error) =>
            persistenceError("listSuppressed", error),
          ),
        );

    const softDelete = (
      canvasName: string,
      entityId: string,
    ): Effect.Effect<CanvasEntityRecord, CanvasEntityRepositoryError> =>
      state
        .transaction("canvas-entity.soft-delete", (writer) => {
          const now = new Date().toISOString();
          const result = softDeleteCanvasEntity(
            writer,
            canvasName,
            entityId,
            now,
          );
          if (result === "missing") {
            throw CanvasEntityMissingError.make({ canvasName, entityId });
          }
          if (result === "not_archived") {
            const row = writer.get<EntitySqlRow>(
              `
                SELECT
                  canvas_name,
                  entity_id,
                  kind,
                  binding_id,
                  lifecycle,
                  created_at,
                  updated_at,
                  archived_at,
                  soft_deleted_at
                FROM canvas_entities
                WHERE canvas_name = ?
                  AND entity_id = ?
              `,
              [canvasName, entityId],
            );
            throw CanvasEntityNotArchivedError.make({
              canvasName,
              entityId,
              lifecycle: decodeLifecycle(row?.lifecycle ?? "active"),
            });
          }
          const row = writer.get<EntitySqlRow>(
            `
              SELECT
                canvas_name,
                entity_id,
                kind,
                binding_id,
                lifecycle,
                created_at,
                updated_at,
                archived_at,
                soft_deleted_at
              FROM canvas_entities
              WHERE canvas_name = ?
                AND entity_id = ?
            `,
            [canvasName, entityId],
          );
          if (row === undefined) {
            throw CanvasEntityMissingError.make({ canvasName, entityId });
          }
          return fromRow(row);
        })
        .pipe(
          Effect.mapError((error) => {
            if (
              error.cause instanceof CanvasEntityMissingError ||
              error.cause instanceof CanvasEntityNotArchivedError
            ) {
              return error.cause;
            }
            if (
              error instanceof CanvasEntityMissingError ||
              error instanceof CanvasEntityNotArchivedError
            ) {
              return error;
            }
            return persistenceError("softDelete", error as StateEngineError);
          }),
        );

    return CanvasEntityRepository.of({
      get,
      listByCanvas,
      listHistoric,
      listSuppressedEntityIds,
      softDelete,
    });
  }),
);
