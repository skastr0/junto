/**
 * The loom's settled routes in `junto.db`: one JSON seed per canvas, the
 * router version it was written at, and when. Derived local data, never
 * journalled and never sent to another machine; a canvas's delete takes its
 * row. The renderer reads it once before the planner's first plan and writes
 * it when the planner settles.
 */
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlError } from "effect/sql";

export class LoomSeedPersistenceError extends Schema.TaggedError<LoomSeedPersistenceError>()(
  "LoomSeedPersistenceError",
  { operation: Schema.String, message: Schema.String, cause: Schema.Unknown },
) {}

const persistence =
  (operation: string) =>
  (error: SqlError.SqlError | Schema.SchemaError): LoomSeedPersistenceError =>
    LoomSeedPersistenceError.make({ operation, message: error.message, cause: error });

/** A canvas's stored seed, at the router version it was written. */
export type LoomSeedRow = { readonly routerVersion: number; readonly seedJson: string };

export class LoomSeedRepository extends Context.Service<
  LoomSeedRepository,
  {
    /** The canvas's seed, or undefined when none was saved. */
    readonly load: (canvas: string) => Effect.Effect<LoomSeedRow | undefined, LoomSeedPersistenceError>;
    /** Keep this seed for the canvas; last write wins. */
    readonly save: (
      canvas: string,
      routerVersion: number,
      seedJson: string,
    ) => Effect.Effect<void, LoomSeedPersistenceError>;
  }
>()("@junto/LoomSeedRepository") {}

type Row = { readonly router_version: number; readonly seed_json: string };

export const LoomSeedRepositoryLive: Layer.Layer<LoomSeedRepository, never, SqlClient.SqlClient> = Layer.effect(
  LoomSeedRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const load = Effect.fn("loomSeed.load")(function* (canvas: string) {
      const rows = yield* sql<Row>`
        SELECT router_version, seed_json FROM loom_seeds WHERE canvas_name = ${canvas}`;
      const row = rows[0];
      return row === undefined ? undefined : { routerVersion: row.router_version, seedJson: row.seed_json };
    }, Effect.mapError(persistence("load")));

    const save = Effect.fn("loomSeed.save")(function* (canvas: string, routerVersion: number, seedJson: string) {
      yield* sql`
        INSERT INTO loom_seeds (canvas_name, router_version, seed_json, saved_at)
        VALUES (${canvas}, ${routerVersion}, ${seedJson}, ${Date.now()})
        ON CONFLICT (canvas_name) DO UPDATE SET
          router_version = excluded.router_version,
          seed_json = excluded.seed_json,
          saved_at = excluded.saved_at`;
    }, Effect.mapError(persistence("save")));

    return { load, save };
  }),
);
