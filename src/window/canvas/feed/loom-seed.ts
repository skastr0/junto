/**
 * The loom planner's settled state, as it crosses a launch, in parts: the
 * cards it routed around, and each wire's spec key and drawn fact. A launch
 * hands the facts over once; a save writes only the rows that changed.
 *
 * The seed is derived local data, keyed by `LOOM_ROUTER_VERSION`: a router
 * change that can move a path bumps the version and no older seed is trusted.
 * The planner owns the shape; the store owns the rows. No DB, no renderer
 * state here.
 */
import type { WireRouteFact } from "../contract";

/**
 * Bump when a routing change can move an existing path: routeWire's geometry,
 * the loom's plan, or the seed's own shape. A seed at another version is
 * dropped, so the launch routes the board again.
 */
export const LOOM_ROUTER_VERSION = 1;

/** One card the plan was made around, as the board drew it. */
export type LoomSeedCard = {
  readonly nodeId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly obstacle: boolean;
};

/** One wire's plan: its spec key and its drawn fact, as JSON. */
export type LoomSeedWire = {
  readonly wireId: string;
  readonly specKey: string;
  /** A `WireRouteFact`; decoded in the worker, never on the page's thread. */
  readonly fact: string;
};

export type LoomSeedMeta = {
  readonly fingerprint: number;
  /** The plan's spec key and geometry key, so the seed's row order never matters. */
  readonly specsKey: string;
  readonly geometryKey: number;
};

/** The parts a launch reads: a meta row, every card, every wire. */
export type LoomSeed = {
  readonly version: number;
  readonly meta: LoomSeedMeta;
  readonly cards: ReadonlyArray<LoomSeedCard>;
  readonly wires: ReadonlyArray<LoomSeedWire>;
};

/** What a settle writes: only the rows that changed, and what went. */
export type LoomSeedChange = {
  readonly meta: LoomSeedMeta;
  readonly cards: ReadonlyArray<LoomSeedCard>;
  readonly wires: ReadonlyArray<LoomSeedWire>;
  readonly removedCards: ReadonlyArray<string>;
  readonly removedWires: ReadonlyArray<string>;
};

/** A seed is trusted only at this router's version. */
export const loomSeedTrusted = (seed: LoomSeed): boolean => seed.version === LOOM_ROUTER_VERSION;

/** The fact as the planner parsed it (the worker's thread, not the page's). */
export const loomSeedFact = (wire: LoomSeedWire): WireRouteFact => JSON.parse(wire.fact) as WireRouteFact;
