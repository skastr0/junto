/**
 * The seed beside the canvas: read once before the planner's first plan,
 * written when it settles. A seed from another router version is ignored (the
 * plan is made from scratch); a read or write failure is not an error the
 * operator sees, only a cold plan. Rows cross IPC as plain data; the worker
 * decodes each fact, never the page's thread.
 */
import { LOOM_ROUTER_VERSION, loomSeedTrusted, type LoomSeed, type LoomSeedChange } from "./loom-seed";

type StoredSeed = {
  readonly meta: {
    readonly routerVersion: number;
    readonly fingerprint: number;
    readonly specsKey: string;
    readonly geometryKey: number;
  } | null;
  readonly cards: LoomSeed["cards"];
  readonly wires: LoomSeed["wires"];
};

/** A change as the core's request schema wants it: its meta carries the version. */
type StoredChange = Omit<LoomSeedChange, "meta"> & {
  readonly meta: LoomSeedChange["meta"] & { readonly routerVersion: number };
};

type Api = {
  readonly load: (canvas: string) => Promise<StoredSeed>;
  readonly save: (canvas: string, change: StoredChange) => Promise<boolean>;
};

const api = (): Api | undefined =>
  (globalThis as { window?: { junto?: { loomSeed?: unknown } } }).window?.junto?.loomSeed as Api | undefined;

/** The canvas's trusted seed, or undefined for a cold plan. */
export const loadLoomSeed = async (canvas: string): Promise<LoomSeed | undefined> => {
  const store = api();
  if (store === undefined) return undefined;
  try {
    const stored = await store.load(canvas);
    if (stored.meta === null || stored.meta.routerVersion !== LOOM_ROUTER_VERSION) return undefined;
    const seed: LoomSeed = {
      version: stored.meta.routerVersion,
      meta: {
        fingerprint: stored.meta.fingerprint,
        specsKey: stored.meta.specsKey,
        geometryKey: stored.meta.geometryKey,
      },
      cards: stored.cards,
      wires: stored.wires,
    };
    return loomSeedTrusted(seed) ? seed : undefined;
  } catch {
    return undefined;
  }
};

/** Save a settled plan's changed rows; false when the store refused it. */
export const saveLoomSeed = async (canvas: string, change: LoomSeedChange): Promise<boolean> => {
  const store = api();
  if (store === undefined) return false;
  try {
    return await store.save(canvas, {
      ...change,
      // The core's request schema refuses a meta without the router version;
      // a save that loses it is a launch that routes everything again.
      meta: { ...change.meta, routerVersion: LOOM_ROUTER_VERSION },
    });
  } catch {
    return false;
  }
};
