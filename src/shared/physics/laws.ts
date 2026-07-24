import { Data, HashSet, Match, Option } from "effect";
import type { FactoryRole, Port } from "./schema";
import { PortGrant } from "./schema";

// Role-pair laws for default edge grants. Edges are undirected for connectivity;
// the *caller → target* ordered pair selects the law at admit time.
//
// GrantLaw is the selection layer above PortGrant. PortGrant algebra (never
// expand under attenuate) is untouched; laws no longer return PortGrant
// directly — admit/selectGrant materializes a PortGrant from law + mask.

/**
 * Canonical ordered role pairs for grantLawBetween.
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

/**
 * Selection law for an ordered role pair before edge-port materialization.
 *
 * - Full  → PortGrant.full, then attenuate by mask if present
 * - OptIn → mask present ? PortGrant.subset(mask) : PortGrant.empty (discovery)
 * - None  → PortGrant.empty (role_law denial at admit)
 *
 * Actor→actor is OptIn so attenuation never has to expand empty→ports (I2/I8).
 */
export type GrantLaw = Data.TaggedEnum<{
  Full: {};
  OptIn: {};
  None: {};
}>;

export const GrantLaw = Data.taggedEnum<GrantLaw>();

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
 * Role-pair grant law (I8: actor→actor is OptIn / discovery-only).
 * ActorSink stays Full; scheduler/region/furniture/denied stay None.
 */
export const grantLawBetween = (pair: RolePair): GrantLaw =>
  Match.value(pair).pipe(
    Match.tagsExhaustive({
      ActorSink: () => GrantLaw.Full(),
      ActorActor: () => GrantLaw.OptIn(),
      ActorScheduler: () => GrantLaw.None(),
      ActorRegion: () => GrantLaw.None(),
      ActorFurniture: () => GrantLaw.None(),
      Denied: () => GrantLaw.None(),
    }),
  );

/** Convenience: roles → grant law. */
export const grantLawForRoles = (
  from: FactoryRole,
  to: FactoryRole,
): GrantLaw => grantLawBetween(canonicalRolePair(from, to));

/**
 * Materialize a concrete PortGrant from a GrantLaw + optional edge port mask.
 * PortGrant.attenuate is never asked to expand an empty grant into a mask.
 */
export const selectGrant = (
  law: GrantLaw,
  mask: HashSet.HashSet<Port> | undefined,
): PortGrant =>
  Match.value(law).pipe(
    Match.tagsExhaustive({
      Full: () => {
        const base = PortGrant.full;
        return mask !== undefined ? base.attenuate(mask) : base;
      },
      OptIn: () =>
        mask !== undefined ? PortGrant.subset(mask) : PortGrant.empty,
      None: () => PortGrant.empty,
    }),
  );

/** Option-flavored selectGrant for call sites holding Option masks. */
export const selectGrantFromOption = (
  law: GrantLaw,
  mask: Option.Option<HashSet.HashSet<Port>>,
): PortGrant =>
  selectGrant(law, Option.isSome(mask) ? mask.value : undefined);

