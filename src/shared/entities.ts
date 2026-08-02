import { Schema } from "effect";

// Normalized read-only snapshots from the adapter plane. Bindings in the
// canvas document are pointers into these; the document never stores server
// data, so a down server degrades to a stale badge and nothing else.

// Live adapter plane is hermes-only. Private-source adapters are retired —
// never reintroduce a second EntitySource without a full product decision.
export const EntitySource = Schema.Literal("hermes");
export type EntitySource = typeof EntitySource.Type;

export const Entity = Schema.Struct({
  source: EntitySource,
  // The canonical join key shared/connections.ts resolves identities against.
  key: Schema.String,
  kind: Schema.String,
  title: Schema.optionalKey(Schema.String),
  stats: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number])),
  updatedAt: Schema.String,
  // A retained last-known observation. `false` is meaningful on a partial
  // source read: that individual fact was observed during the current
  // attempt even though another host made the bundle unhealthy.
  stale: Schema.optionalKey(Schema.Boolean),
});
export type Entity = typeof Entity.Type;

export const SnapshotBundle = Schema.Struct({
  source: EntitySource,
  fetchedAt: Schema.String,
  ok: Schema.Boolean,
  // Explicit cache provenance. A failed/partial refresh may retain entities
  // for offline display, but stale facts are never authoritative predicates.
  stale: Schema.optionalKey(Schema.Boolean),
  lastSuccessfulAt: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
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

/**
 * Predicate-safe lookup. A healthy bundle is authoritative unless the
 * individual entity is explicitly retained/stale. A failed partial bundle
 * can still carry entities observed during that exact attempt; SnapshotsService
 * marks those `stale: false`, while cached last-known facts are `stale: true`.
 */
export const findFreshEntity = (
  state: SnapshotState,
  source: EntitySource,
  key: string,
): Entity | undefined => {
  const bundle = state.bundles.find((candidate) => candidate.source === source);
  const entity = bundle?.entities.find((candidate) => candidate.key === key);
  if (!bundle || !entity || entity.stale === true) return undefined;
  if (bundle.ok) return entity;
  return entity.stale === false ? entity : undefined;
};
