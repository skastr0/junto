import { Schema } from "effect";

// Normalized read-only snapshots from the adapter plane. Bindings in the
// canvas document are pointers into these; the document never stores server
// data, so a down server degrades to a stale badge and nothing else.

export const EntitySource = Schema.Literal("tower", "quasar", "booth", "hermes");
export type EntitySource = typeof EntitySource.Type;

export const Entity = Schema.Struct({
  source: EntitySource,
  // The canonical join key shared/connections.ts resolves identities against.
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

// Which private sources this station is configured for (an env var or the
// SDK's config file present — detected main-side, never stored in documents).
// Absent on states produced before detection ran; consumers treat absence as
// "all enabled".
export const SourceCapabilities = Schema.Struct({
  tower: Schema.Boolean,
  quasar: Schema.Boolean,
  booth: Schema.Boolean,
});
export type SourceCapabilities = typeof SourceCapabilities.Type;

export const SnapshotState = Schema.Struct({
  bundles: Schema.Array(SnapshotBundle),
  capabilities: Schema.optionalWith(SourceCapabilities, { exact: true }),
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
