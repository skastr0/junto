/**
 * The loom seed beside the canvas: read once before the planner's first plan,
 * written when it settles. A seed from another router version is ignored (the
 * plan is made from scratch); a seed that does not decode is ignored too, and
 * a read or write failure is not an error the operator sees, only a cold plan.
 */
import { LOOM_ROUTER_VERSION, loomSeedTrusted, type LoomSeed } from "./loom-seed";

/** The canvas's trusted seed, or undefined for a cold plan. */
export const loadLoomSeed = async (canvas: string): Promise<LoomSeed | undefined> => {
  const api = (globalThis as { window?: { junto?: { loomSeed?: unknown } } }).window?.junto?.loomSeed as
    | { load: (canvas: string) => Promise<{ routerVersion: number; seedJson: string } | null> }
    | undefined;
  if (api === undefined) return undefined;
  try {
    const stored = await api.load(canvas);
    if (stored === null || stored.routerVersion !== LOOM_ROUTER_VERSION) return undefined;
    const seed = JSON.parse(stored.seedJson) as LoomSeed;
    return loomSeedTrusted(seed) ? seed : undefined;
  } catch {
    return undefined;
  }
};

/** Save a settled plan; false when the store refused it, which leaves the old seed. */
export const saveLoomSeed = async (canvas: string, seed: LoomSeed): Promise<boolean> => {
  const api = (globalThis as { window?: { junto?: { loomSeed?: unknown } } }).window?.junto?.loomSeed as
    | { save: (canvas: string, routerVersion: number, seedJson: string) => Promise<boolean> }
    | undefined;
  if (api === undefined) return false;
  try {
    return await api.save(canvas, LOOM_ROUTER_VERSION, JSON.stringify(seed));
  } catch {
    return false;
  }
};
