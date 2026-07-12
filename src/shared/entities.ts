import { Schema } from "effect";

// Normalized read-only snapshots from the adapter plane. Bindings in the
// canvas document are pointers into these; the document never stores server
// data, so a down server degrades to a stale badge and nothing else.

export const EntitySource = Schema.Literal("tower", "quasar", "booth");
export type EntitySource = typeof EntitySource.Type;

export const Entity = Schema.Struct({
  source: EntitySource,
  // For project-level refs the key matches EtherBinding.ref.key exactly.
  key: Schema.String,
  kind: Schema.String,
  title: Schema.optionalWith(Schema.String, { exact: true }),
  stats: Schema.Record({
    key: Schema.String,
    value: Schema.Union(Schema.String, Schema.Number),
  }),
  updatedAt: Schema.String,
});
export type Entity = typeof Entity.Type;

export const SnapshotBundle = Schema.Struct({
  source: EntitySource,
  fetchedAt: Schema.String,
  ok: Schema.Boolean,
  error: Schema.optionalWith(Schema.String, { exact: true }),
  entities: Schema.Array(Entity),
});
export type SnapshotBundle = typeof SnapshotBundle.Type;

export const SnapshotState = Schema.Struct({
  bundles: Schema.Array(SnapshotBundle),
});
export type SnapshotState = typeof SnapshotState.Type;

export const findEntity = (
  state: SnapshotState,
  source: EntitySource,
  key: string,
): Entity | undefined =>
  state.bundles
    .find((bundle) => bundle.source === source)
    ?.entities.find((entity) => entity.key === key);
