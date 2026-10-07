import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlError, SqlSchema } from "effect/unstable/sql";
import {
  cleanReferenceText,
  normalizeReferenceName,
  type AppBriefing,
  type ReferenceAuthor,
  type ReferencePlace,
  type RegionReference,
  type StoredReference,
} from "@shared/references";
import { StateTransactionOperation } from "../state/service";
import { emitReferencesChanged } from "./changes";

export class ReferencesPersistenceError extends Schema.TaggedError<ReferencesPersistenceError>()(
  "ReferencesPersistenceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

/** The input cannot be saved: a name that is not one, or no body. */
export class ReferenceRefused extends Schema.TaggedError<ReferenceRefused>()(
  "ReferenceRefused",
  { message: Schema.String },
) {}

export type ReferencesRepositoryError = ReferencesPersistenceError | ReferenceRefused;

/**
 * The app briefing and references (`app_texts`). The operator writes them in
 * Settings and an overseer through its closed commands; `junto onboard`
 * carries the briefing and lists the references, and a seat reads one on
 * demand.
 */
export class ReferencesRepository extends Context.Service<ReferencesRepository,
  {
    readonly briefingRead: () => Effect.Effect<AppBriefing | null, ReferencesRepositoryError>;
    /** Replace the briefing; nothing left clears it. */
    readonly briefingWrite: (
      body: unknown,
      by: ReferenceAuthor,
    ) => Effect.Effect<AppBriefing | null, ReferencesRepositoryError>;
    /** One place's references, by name. */
    readonly list: (place: ReferencePlace) => Effect.Effect<ReadonlyArray<StoredReference>, ReferencesRepositoryError>;
    readonly read: (
      place: ReferencePlace,
      name: unknown,
    ) => Effect.Effect<StoredReference | null, ReferencesRepositoryError>;
    /** Create or replace one reference. An empty body is refused: that is a delete. */
    readonly write: (
      place: ReferencePlace,
      input: { readonly name: unknown; readonly description?: unknown; readonly body: unknown },
      by: ReferenceAuthor,
    ) => Effect.Effect<StoredReference, ReferencesRepositoryError>;
    /** False when there was no such reference. */
    readonly remove: (place: ReferencePlace, name: unknown) => Effect.Effect<boolean, ReferencesRepositoryError>;
    /** The references of the named regions of one canvas, each tagged with its region. */
    readonly regionTexts: (
      canvasName: string,
      regionIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<RegionReference>, ReferencesRepositoryError>;
  }>()("@junto/ReferencesRepository") {}

const ReferenceRow = Schema.Struct({
  region_id: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  body: Schema.String,
  updated_at: Schema.Number,
});

const fromRow = (row: typeof ReferenceRow.Type): StoredReference => ({
  name: row.name,
  ...(row.description !== null ? { description: row.description } : {}),
  body: row.body,
  updatedAt: row.updated_at,
});

const keyOf = (place: ReferencePlace) =>
  place.kind === "app"
    ? { scopeKind: "app", canvasName: "", regionId: "" }
    : { scopeKind: "region", canvasName: place.canvasName, regionId: place.regionId };

const changed = (place: ReferencePlace, name: string) =>
  Effect.sync(() =>
    emitReferencesChanged(
      place.kind === "app"
        ? { kind: "reference", name }
        : { kind: "reference", name, canvasName: place.canvasName, regionId: place.regionId },
    ),
  );

const persistence = (operation: string) => (error: SqlError.SqlError | Schema.SchemaError | ReferenceRefused) =>
  error instanceof ReferenceRefused
    ? error
    : ReferencesPersistenceError.make({ operation, message: error.message, cause: error });

export const ReferencesRepositoryLive: Layer.Layer<ReferencesRepository, never, SqlClient.SqlClient> =
  Layer.effect(
    ReferencesRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const Key = Schema.Struct({ scopeKind: Schema.String, canvasName: Schema.String, regionId: Schema.String });
      const rowsAt = SqlSchema.findAll({
        Request: Key,
        Result: ReferenceRow,
        execute: (key) => sql`
          SELECT region_id, name, description, body, updated_at FROM app_texts
          WHERE scope_kind = ${key.scopeKind} AND canvas_name = ${key.canvasName} AND region_id = ${key.regionId}
          ORDER BY name
        `,
      });
      const rowAt = SqlSchema.findOneOption({
        Request: Schema.Struct({ ...Key.fields, name: Schema.String }),
        Result: ReferenceRow,
        execute: (key) => sql`
          SELECT region_id, name, description, body, updated_at FROM app_texts
          WHERE scope_kind = ${key.scopeKind} AND canvas_name = ${key.canvasName}
            AND region_id = ${key.regionId} AND name = ${key.name}
        `,
      });
      const rowsOfCanvas = SqlSchema.findAll({
        Request: Schema.String,
        Result: ReferenceRow,
        execute: (canvasName) => sql`
          SELECT region_id, name, description, body, updated_at FROM app_texts
          WHERE scope_kind = 'region' AND canvas_name = ${canvasName}
          ORDER BY region_id, name
        `,
      });
      const briefingKey = { scopeKind: "briefing", canvasName: "", regionId: "", name: "" };

      const named = (value: unknown) => {
        const normalized = normalizeReferenceName(value);
        return normalized.ok
          ? Effect.succeed(normalized.name)
          : Effect.fail(new ReferenceRefused({ message: normalized.message }));
      };

      const briefingRead = Effect.fn("references.briefing.read")(function* () {
        const row = yield* rowAt(briefingKey);
        return Option.isNone(row) ? null : { body: row.value.body, updatedAt: row.value.updated_at };
      }, Effect.mapError(persistence("briefing.read")));

      const briefingStore = Effect.fn("references.briefing.write")(function* (body: unknown, by: ReferenceAuthor) {
        const text = cleanReferenceText(body);
        if (text === undefined) {
          yield* sql`DELETE FROM app_texts WHERE scope_kind = 'briefing'`;
          return null;
        }
        const updatedAt = Date.now();
        yield* sql`
          INSERT INTO app_texts(scope_kind, canvas_name, region_id, name, description, body, updated_at, updated_by)
          VALUES ('briefing', '', '', '', NULL, ${text}, ${updatedAt}, ${by})
          ON CONFLICT(scope_kind, canvas_name, region_id, name) DO UPDATE SET
            body = excluded.body,
            updated_at = excluded.updated_at,
            updated_by = excluded.updated_by
        `;
        return { body: text, updatedAt };
      }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "references.briefing.write"), Effect.mapError(persistence("briefing.write")));

      const list = Effect.fn("references.list")(function* (place: ReferencePlace) {
        return (yield* rowsAt(keyOf(place))).map(fromRow);
      }, Effect.mapError(persistence("list")));

      const read = Effect.fn("references.read")(function* (place: ReferencePlace, name: unknown) {
        const row = yield* rowAt({ ...keyOf(place), name: yield* named(name) });
        return Option.isNone(row) ? null : fromRow(row.value);
      }, Effect.mapError(persistence("read")));

      const writeRow = Effect.fn("references.write")(function* (
        place: ReferencePlace,
        input: { readonly name: unknown; readonly description?: unknown; readonly body: unknown },
        by: ReferenceAuthor,
      ) {
        const name = yield* named(input.name);
        const body = cleanReferenceText(input.body);
        if (body === undefined) {
          return yield* new ReferenceRefused({
            message: `"${name}" has no body; to remove a reference, delete it`,
          });
        }
        const description = cleanReferenceText(input.description);
        const key = keyOf(place);
        const updatedAt = Date.now();
        yield* sql`
          INSERT INTO app_texts(scope_kind, canvas_name, region_id, name, description, body, updated_at, updated_by)
          VALUES (${key.scopeKind}, ${key.canvasName}, ${key.regionId}, ${name}, ${description ?? null}, ${body}, ${updatedAt}, ${by})
          ON CONFLICT(scope_kind, canvas_name, region_id, name) DO UPDATE SET
            description = excluded.description,
            body = excluded.body,
            updated_at = excluded.updated_at,
            updated_by = excluded.updated_by
        `;
        return { name, ...(description !== undefined ? { description } : {}), body, updatedAt };
      }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "references.write"), Effect.mapError(persistence("write")));

      const removeRow = Effect.fn("references.remove")(function* (place: ReferencePlace, name: unknown) {
        const key = { ...keyOf(place), name: yield* named(name) };
        const existing = yield* rowAt(key);
        if (Option.isNone(existing)) return false;
        yield* sql`
          DELETE FROM app_texts
          WHERE scope_kind = ${key.scopeKind} AND canvas_name = ${key.canvasName}
            AND region_id = ${key.regionId} AND name = ${key.name}
        `;
        return true;
      }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "references.remove"), Effect.mapError(persistence("remove")));

      // Listeners hear of a write once it is committed, never from inside it.
      const briefingWrite = (body: unknown, by: ReferenceAuthor) =>
        briefingStore(body, by).pipe(Effect.tap(() => Effect.sync(() => emitReferencesChanged({ kind: "briefing" }))));
      const write = (...input: Parameters<typeof writeRow>) =>
        writeRow(...input).pipe(Effect.tap((reference) => changed(input[0], reference.name)));
      const remove = (place: ReferencePlace, name: unknown) =>
        removeRow(place, name).pipe(
          Effect.tap((removed) => (removed ? changed(place, String(name).trim().toLowerCase()) : Effect.void)),
        );

      const regionTexts = Effect.fn("references.regionTexts")(function* (
        canvasName: string,
        regionIds: ReadonlyArray<string>,
      ) {
        if (regionIds.length === 0) return [];
        const wanted = new Set(regionIds);
        return (yield* rowsOfCanvas(canvasName))
          .filter((row) => wanted.has(row.region_id))
          .map((row): RegionReference => ({ ...fromRow(row), regionId: row.region_id }));
      }, Effect.mapError(persistence("regionTexts")));

      return ReferencesRepository.of({ briefingRead, briefingWrite, list, read, write, remove, regionTexts });
    }),
  );
