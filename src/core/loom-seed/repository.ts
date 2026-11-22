/**
 * The loom seed in `junto.db`, in parts: a meta row, a row per card and a
 * row per wire. A moved card rewrites its own card row and the wires it
 * re-routed, never a canvas-wide blob. Derived local data, never journalled
 * and never sent to another machine; a canvas's delete takes every part.
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

export type LoomSeedMeta = {
  readonly routerVersion: number;
  readonly fingerprint: number;
  readonly specsKey: string;
  readonly geometryKey: number;
};
export type LoomSeedCard = {
  readonly nodeId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly obstacle: boolean;
};
export type LoomSeedWire = { readonly wireId: string; readonly specKey: string; readonly fact: string };
export type LoomSeedParts = {
  readonly meta: LoomSeedMeta | undefined;
  readonly cards: ReadonlyArray<LoomSeedCard>;
  readonly wires: ReadonlyArray<LoomSeedWire>;
};
export type LoomSeedChange = {
  readonly meta: LoomSeedMeta;
  /** Cards and wires written this save; every other row keeps its bytes. */
  readonly cards: ReadonlyArray<LoomSeedCard>;
  readonly wires: ReadonlyArray<LoomSeedWire>;
  readonly removedCards: ReadonlyArray<string>;
  readonly removedWires: ReadonlyArray<string>;
};

export class LoomSeedRepository extends Context.Service<
  LoomSeedRepository,
  {
    /** Every part of the canvas's seed; meta is undefined when none was saved. */
    readonly load: (canvas: string) => Effect.Effect<LoomSeedParts, LoomSeedPersistenceError>;
    /** Write what changed and remove what went; last write wins per row. */
    readonly save: (canvas: string, change: LoomSeedChange) => Effect.Effect<void, LoomSeedPersistenceError>;
  }
>()("@junto/LoomSeedRepository") {}

type MetaRow = {
  readonly router_version: number;
  readonly fingerprint: number;
  readonly specs_key: string;
  readonly geometry_key: number;
};
type CardRow = { readonly node_id: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly obstacle: number };
type WireRow = { readonly wire_id: string; readonly spec_key: string; readonly fact: string };

export const LoomSeedRepositoryLive: Layer.Layer<LoomSeedRepository, never, SqlClient.SqlClient> = Layer.effect(
  LoomSeedRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const load = Effect.fn("loomSeed.load")(function* (canvas: string) {
      const meta = yield* sql<MetaRow>`
        SELECT router_version, fingerprint, specs_key, geometry_key FROM loom_seed_meta WHERE canvas_name = ${canvas}`;
      const cards = yield* sql<CardRow>`
        SELECT node_id, x, y, width, height, obstacle FROM loom_seed_cards
        WHERE canvas_name = ${canvas} ORDER BY node_id`;
      const wires = yield* sql<WireRow>`
        SELECT wire_id, spec_key, fact FROM loom_seed_wires
        WHERE canvas_name = ${canvas} ORDER BY wire_id`;
      const head = meta[0];
      return {
        meta:
          head === undefined
            ? undefined
            : {
                routerVersion: head.router_version,
                fingerprint: head.fingerprint,
                specsKey: head.specs_key,
                geometryKey: head.geometry_key,
              },
        cards: cards.map((row) => ({
          nodeId: row.node_id,
          x: row.x,
          y: row.y,
          width: row.width,
          height: row.height,
          obstacle: row.obstacle === 1,
        })),
        wires: wires.map((row) => ({ wireId: row.wire_id, specKey: row.spec_key, fact: row.fact })),
      };
    }, Effect.mapError(persistence("load")));

    const write = Effect.fn("loomSeed.save")(function* (canvas: string, change: LoomSeedChange) {
      yield* sql`INSERT INTO loom_seed_meta (canvas_name, router_version, fingerprint, specs_key, geometry_key, saved_at)
        VALUES (${canvas}, ${change.meta.routerVersion}, ${change.meta.fingerprint}, ${change.meta.specsKey}, ${change.meta.geometryKey}, ${Date.now()})
        ON CONFLICT (canvas_name) DO UPDATE SET
          router_version = excluded.router_version,
          fingerprint = excluded.fingerprint,
          specs_key = excluded.specs_key,
          geometry_key = excluded.geometry_key,
          saved_at = excluded.saved_at`;
      for (const id of change.removedCards) {
        yield* sql`DELETE FROM loom_seed_cards WHERE canvas_name = ${canvas} AND node_id = ${id}`;
      }
      for (const card of change.cards) {
        yield* sql`INSERT INTO loom_seed_cards (canvas_name, node_id, x, y, width, height, obstacle)
          VALUES (${canvas}, ${card.nodeId}, ${card.x}, ${card.y}, ${card.width}, ${card.height}, ${card.obstacle ? 1 : 0})
          ON CONFLICT (canvas_name, node_id) DO UPDATE SET
            x = excluded.x, y = excluded.y, width = excluded.width, height = excluded.height,
            obstacle = excluded.obstacle`;
      }
      for (const id of change.removedWires) {
        yield* sql`DELETE FROM loom_seed_wires WHERE canvas_name = ${canvas} AND wire_id = ${id}`;
      }
      for (const wire of change.wires) {
        yield* sql`INSERT INTO loom_seed_wires (canvas_name, wire_id, spec_key, fact)
          VALUES (${canvas}, ${wire.wireId}, ${wire.specKey}, ${wire.fact})
          ON CONFLICT (canvas_name, wire_id) DO UPDATE SET
            spec_key = excluded.spec_key, fact = excluded.fact`;
      }
    }, Effect.mapError(persistence("save")));

    const save = (canvas: string, change: LoomSeedChange) =>
      write(canvas, change).pipe(sql.withTransaction) as Effect.Effect<void, LoomSeedPersistenceError>;

    return { load, save };
  }),
);
