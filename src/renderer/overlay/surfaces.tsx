import { surfaces } from "@junto/overlay/renderer";
import type { StoreSurfaceProps } from "@shared/overlay-contract";

// Renderer extension points the overlay may fill. Hosts render a slot only
// when it is filled, so an open-source build shows none of them.

export const overlaySurfaces = surfaces;

/** True when this build carries the premium store. */
export const hasStore = (): boolean => overlaySurfaces.store !== undefined;

/** The premium store, or nothing in an open-source build. */
export function StoreSlot({ onClose }: StoreSurfaceProps) {
  const store = overlaySurfaces.store;
  return store ? <store.Component onClose={onClose} /> : null;
}
