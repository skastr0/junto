import { Data, Match } from "effect";
import type { FactoryRole } from "./schema";
import { PortGrant } from "./schema";

// Role-pair laws for default edge grants. Edges are undirected for connectivity;
// the *caller → target* ordered pair selects the law at admit time.

/**
 * Canonical ordered role pairs for defaultGrantBetween.
 * Non-actor callers and non-granting actor targets collapse to Denied.
 */
export type RolePair = Data.TaggedEnum<{
  ActorSink: {};
  ActorActor: {};
  ActorScheduler: {};
  ActorRegion: {};
  ActorFurniture: {};
  Denied: {
    readonly from: FactoryRole;
    readonly to: FactoryRole;
  };
}>;

export const RolePair = Data.taggedEnum<RolePair>();

/** Map ordered (caller role, target role) → RolePair for exhaustive grant match. */
export const canonicalRolePair = (
  from: FactoryRole,
  to: FactoryRole,
): RolePair => {
  if (from === "actor") {
    if (to === "sink") return RolePair.ActorSink();
    if (to === "actor") return RolePair.ActorActor();
    if (to === "scheduler") return RolePair.ActorScheduler();
    if (to === "region") return RolePair.ActorRegion();
    if (to === "furniture") return RolePair.ActorFurniture();
  }
  return RolePair.Denied({ from, to });
};

/**
 * Default grant for a role pair before edge-port attenuation.
 * Behavior-preserving: actor → sink and actor → actor are Full (caller receives
 * all of the target's KindSpec.offers when an edge exists and ports are absent).
 */
export const defaultGrantBetween = (pair: RolePair): PortGrant =>
  Match.value(pair).pipe(
    Match.tagsExhaustive({
      ActorSink: () => PortGrant.full,
      ActorActor: () => PortGrant.full,
      ActorScheduler: () => PortGrant.empty,
      ActorRegion: () => PortGrant.empty,
      ActorFurniture: () => PortGrant.empty,
      Denied: () => PortGrant.empty,
    }),
  );

/** Convenience: roles → default grant. */
export const defaultGrantForRoles = (
  from: FactoryRole,
  to: FactoryRole,
): PortGrant => defaultGrantBetween(canonicalRolePair(from, to));
