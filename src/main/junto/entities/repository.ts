import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import {
  EntityLifecycle,
  type EntityKey,
  type EntityLifecycle as EntityLifecycleT,
  entityKeyOf,
} from "@shared/entity";
import { CanvasEntitySync } from "./sync";
import { StateTransactionOperation } from "../state/service";

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

const EntitySqlRow = Schema.Struct({
  canvas_name: Schema.String,
  entity_id: Schema.String,
  kind: Schema.NullOr(Schema.String),
  binding_id: Schema.NullOr(Schema.String),
  lifecycle: EntityLifecycle,
  created_at: Schema.String,
  updated_at: Schema.String,
  archived_at: Schema.NullOr(Schema.String),
  soft_deleted_at: Schema.NullOr(Schema.String),
});

const fromRow = (row: typeof EntitySqlRow.Type): CanvasEntityRecord => ({
  key: entityKeyOf(row.canvas_name, row.entity_id),
  kind: row.kind,
  bindingId: row.binding_id,
  lifecycle: row.lifecycle,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  archivedAt: row.archived_at,
  softDeletedAt: row.soft_deleted_at,
});

const persistenceError = (
  operation: string,
  error: unknown,
): CanvasEntityPersistenceError =>
  CanvasEntityPersistenceError.make({
    operation,
    message: error instanceof Error ? error.message : String(error),
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
  }>()("@junto/CanvasEntityRepository") {}

export const CanvasEntityRepositoryLive: Layer.Layer<
  CanvasEntityRepository,
  never,
  SqlClient.SqlClient
> = Layer.effect(
  CanvasEntityRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const entities = yield* CanvasEntitySync;
    const select = SqlSchema.findAll({
      Request: Schema.Struct({ canvasName: Schema.String, entityId: Schema.String }),
      Result: EntitySqlRow,
      execute: ({ canvasName, entityId }) => sql`
        SELECT canvas_name, entity_id, kind, binding_id, lifecycle,
               created_at, updated_at, archived_at, soft_deleted_at
        FROM canvas_entities
        WHERE canvas_name = ${canvasName} AND entity_id = ${entityId}`,
    });

    const get = Effect.fn("CanvasEntityRepository.get")((
      canvasName: string,
      entityId: string,
    ) => select({ canvasName, entityId }).pipe(
      Effect.map((rows) => rows[0] === undefined ? undefined : fromRow(rows[0])),
      Effect.mapError((error) => persistenceError("get", error)),
    ));

    const selectByCanvas = SqlSchema.findAll({
      Request: Schema.Struct({
        canvasName: Schema.String,
        lifecycle: Schema.optionalKey(EntityLifecycle),
      }),
      Result: EntitySqlRow,
      execute: ({ canvasName, lifecycle }) => lifecycle === undefined
        ? sql`SELECT canvas_name, entity_id, kind, binding_id, lifecycle,
                     created_at, updated_at, archived_at, soft_deleted_at
              FROM canvas_entities WHERE canvas_name = ${canvasName}
              ORDER BY lifecycle, updated_at, entity_id`
        : sql`SELECT canvas_name, entity_id, kind, binding_id, lifecycle,
                     created_at, updated_at, archived_at, soft_deleted_at
              FROM canvas_entities
              WHERE canvas_name = ${canvasName} AND lifecycle = ${lifecycle}
              ORDER BY updated_at, entity_id`,
    });
    const listByCanvas = Effect.fn("CanvasEntityRepository.listByCanvas")((
      canvasName: string,
      options?: { readonly lifecycle?: EntityLifecycleT },
    ) => selectByCanvas({ canvasName, ...options }).pipe(
      Effect.map((rows) => rows.map(fromRow)),
      Effect.mapError((error) => persistenceError("list", error)),
    ));

    const selectHistoric = SqlSchema.findAll({
      Request: Schema.String,
      Result: EntitySqlRow,
      execute: (canvasName) => sql`
        SELECT canvas_name, entity_id, kind, binding_id, lifecycle,
               created_at, updated_at, archived_at, soft_deleted_at
        FROM canvas_entities
        WHERE canvas_name = ${canvasName} AND lifecycle IN ('active', 'archived')
        ORDER BY lifecycle, updated_at, entity_id`,
    });
    const listHistoric = Effect.fn("CanvasEntityRepository.listHistoric")((
      canvasName: string,
    ) => selectHistoric(canvasName).pipe(
      Effect.map((rows) => rows.map(fromRow)),
      Effect.mapError((error) => persistenceError("listHistoric", error)),
    ));

    const selectSuppressed = SqlSchema.findAll({
      Request: Schema.String,
      Result: Schema.Struct({ entity_id: Schema.String }),
      execute: (canvasName) => sql`
        SELECT entity_id FROM canvas_entities
        WHERE canvas_name = ${canvasName} AND lifecycle IN ('archived', 'soft_deleted')`,
    });
    const listSuppressedEntityIds = Effect.fn("CanvasEntityRepository.listSuppressedEntityIds")((
      canvasName: string,
    ) => selectSuppressed(canvasName).pipe(
      Effect.map((rows) => new Set(rows.map((row) => row.entity_id))),
      Effect.mapError((error) => persistenceError("listSuppressed", error)),
    ));

    const softDelete = Effect.fn("CanvasEntityRepository.softDelete")(function* (
      canvasName: string,
      entityId: string,
    ) {
      const row = yield* get(canvasName, entityId);
      if (row === undefined) {
        return yield* Effect.fail(CanvasEntityMissingError.make({ canvasName, entityId }));
      }
      if (row.lifecycle !== "archived") {
        return yield* Effect.fail(CanvasEntityNotArchivedError.make({
          canvasName, entityId, lifecycle: row.lifecycle,
        }));
      }
      const now = new Date().toISOString();
      yield* entities.softDeleteCanvasEntity(canvasName, entityId, now);
      const updated = yield* get(canvasName, entityId);
      if (updated === undefined) {
        return yield* Effect.fail(CanvasEntityMissingError.make({ canvasName, entityId }));
      }
      return updated;
    }, sql.withTransaction,
    Effect.provideService(StateTransactionOperation, "canvas-entity.soft-delete"),
    Effect.mapError((error) =>
      error instanceof CanvasEntityMissingError || error instanceof CanvasEntityNotArchivedError
        ? error : persistenceError("softDelete", error),
    ));

    return CanvasEntityRepository.of({
      get,
      listByCanvas,
      listHistoric,
      listSuppressedEntityIds,
      softDelete,
    });
  }),
).pipe(Layer.provide(CanvasEntitySync.layer));
