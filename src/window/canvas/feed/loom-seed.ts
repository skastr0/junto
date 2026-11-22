/**
 * The loom planner's settled state, as it crosses a launch.
 *
 * A launch that keeps its routes needs more than the routes: the geometry,
 * spec keys and obstacles they were worked out against are what let the
 * planner's own diff (`routesOwedWithCause`) say that nothing is owed. The
 * seed is derived local data, keyed by `LOOM_ROUTER_VERSION`: a router change
 * that can move a path bumps the version and no older seed is trusted.
 *
 * The planner owns the shape; the store owns the bytes. No DB, no renderer
 * state here.
 */
import type { LoomObstacle, LoomPlan, LoomStrand } from "../../lib/wire-loom";
import type { WireRect } from "../../../shared/wire-route";
import type { LoomNode } from "../../lib/loom-geometry";
import type { LoomRoute } from "../../lib/loom-view";

/**
 * Bump when a routing change can move an existing path: routeWire's geometry,
 * the loom's plan, or the seed's own shape. A seed at another version is
 * dropped, so the launch routes the board again.
 */
export const LOOM_ROUTER_VERSION = 1;

export type LoomSeed = {
  readonly version: number;
  readonly geometry: ReadonlyArray<LoomNode>;
  /** Every wire's spec key at the time (`specsOf`), as entries. */
  readonly specs: ReadonlyArray<readonly [string, string]>;
  readonly obstacles: ReadonlyArray<LoomObstacle>;
  /** The routes themselves, as entries; a strand carries its own geometry. */
  readonly routes: ReadonlyArray<readonly [string, LoomRoute]>;
  readonly strands: ReadonlyArray<readonly [string, LoomStrand]>;
  /** The fan fingerprint the plan was made from (planLoom's prior check). */
  readonly fingerprint: number;
  /** The plan's trunk and comb bounds, for stoppage clearance. */
  readonly corridors: ReadonlyArray<WireRect>;
};

/**
 * The plan the seed was made from, ready as `planLoom`'s prior: a launch
 * whose edges and obstacles did not change gets its strands back without
 * routing a wire.
 */
export const loomSeedPlan = (seed: LoomSeed): LoomPlan => ({
  strands: new Map(seed.strands),
  corridors: seed.corridors,
  fingerprint: seed.fingerprint,
  obstacles: seed.obstacles,
});

/** A seed is trusted only at this router's version. */
export const loomSeedTrusted = (seed: LoomSeed): boolean => seed.version === LOOM_ROUTER_VERSION;
