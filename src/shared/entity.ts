/**
 * Canvas-scoped entity identity and lifecycle.
 *
 * Laws:
 * - Entity := CanvasName × EntityId (never free-floating).
 * - ActiveEntity is only constructible with membership proof (on-canvas).
 * - Off-canvas + active is unrepresentable.
 * - Multi-canvas entity does not exist: identity always includes canvas.
 * - lifecycle: active → archived → soft_deleted (no product hard-delete).
 * - archive/soft_delete are hidden from the execution graph and actor tools.
 * - archived may appear in future historic search; soft_deleted does not.
 */

import { Schema } from "effect";

export const EntityLifecycle = Schema.Literal(
  "active",
  "archived",
  "soft_deleted",
);
export type EntityLifecycle = typeof EntityLifecycle.Type;

/** Canvas-local node id; never a global free-floating identity. */
export const EntityId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(256),
  Schema.brand("EntityId"),
);
export type EntityId = typeof EntityId.Type;

export const asEntityId = (value: string): EntityId => value as EntityId;

/**
 * Durable entity key. Canvas is part of identity — there is no EntityId-only
 * product identity and no cross-canvas rehome.
 */
export const EntityKey = Schema.Struct({
  canvasName: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  entityId: EntityId,
});
export type EntityKey = typeof EntityKey.Type;

export const entityKeyOf = (
  canvasName: string,
  entityId: string,
): EntityKey => ({
  canvasName,
  entityId: asEntityId(entityId),
});

/**
 * Proof that an entity currently holds canvas membership (present in the
 * authorial document). Only ActiveEntity carries this brand.
 */
export type EntityMembershipProof = {
  readonly _tag: "EntityMembershipProof";
  readonly canvasName: string;
  readonly entityId: EntityId;
};

const membershipProof = (
  canvasName: string,
  entityId: EntityId,
): EntityMembershipProof => ({
  _tag: "EntityMembershipProof",
  canvasName,
  entityId,
});

/**
 * An entity that is on a canvas and lifecycle=active.
 * Construction requires a membership proof minted only from a live node id
 * present in a CanvasDoc for that canvas.
 */
export type ActiveEntity = {
  readonly _tag: "ActiveEntity";
  readonly key: EntityKey;
  readonly membership: EntityMembershipProof;
};

/**
 * Mint an ActiveEntity only when `entityId` is a member of the supplied
 * on-canvas id set. Callers must pass the set of node ids from the live
 * canvas document — never an ad-hoc list of "should be active" ids.
 */
export const asActiveEntity = (
  canvasName: string,
  entityId: string,
  onCanvasEntityIds: ReadonlySet<string>,
): ActiveEntity | undefined => {
  if (!onCanvasEntityIds.has(entityId)) return undefined;
  const id = asEntityId(entityId);
  const key = entityKeyOf(canvasName, id);
  return {
    _tag: "ActiveEntity",
    key,
    membership: membershipProof(canvasName, id),
  };
};

/** Collect ActiveEntity for every node currently on a canvas document. */
export const activeEntitiesFromNodeIds = (
  canvasName: string,
  nodeIds: ReadonlyArray<string>,
): ReadonlyArray<ActiveEntity> => {
  const set = new Set(nodeIds);
  const out: ActiveEntity[] = [];
  for (const nodeId of nodeIds) {
    const active = asActiveEntity(canvasName, nodeId, set);
    if (active !== undefined) out.push(active);
  }
  return out;
};

export const isHistoricSearchable = (lifecycle: EntityLifecycle): boolean =>
  lifecycle === "active" || lifecycle === "archived";

export const isExecutionVisible = (lifecycle: EntityLifecycle): boolean =>
  lifecycle === "active";

export const isActorToolVisible = (lifecycle: EntityLifecycle): boolean =>
  lifecycle === "active";
