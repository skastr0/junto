import { X } from "lucide-react";
import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import { surfaces } from "@junto/overlay/renderer";
import type { StoreSurfaceProps } from "@shared/overlay-contract";
import { FocusSurface } from "../components/FocusSurface";
import { IconButton, OverlayHeader } from "../components/ui";

// Renderer extension points the overlay may fill. Hosts render a slot only
// when it is filled, so an open-source build shows none of them.

export const overlaySurfaces = surfaces;

/** True when this build carries the premium store. */
export const hasStore = (): boolean => overlaySurfaces.store !== undefined;

export const store$ = observable({ open: false });
export const openStore = (): void => store$.open.set(hasStore());
export const closeStore = (): void => store$.open.set(false);

/** The premium store's content, or nothing in an open-source build. */
export function StoreSlot({ onClose }: StoreSurfaceProps) {
  const store = overlaySurfaces.store;
  return store ? <store.Component onClose={onClose} /> : null;
}

/** Always mounted: frames the store while open; renders nothing without one. */
export function StoreHost() {
  const open = use$(store$.open);
  const store = overlaySurfaces.store;
  if (!open || !store) return null;
  return (
    <FocusSurface measure="document" layer="detail" label={store.title} onClose={closeStore}>
      <OverlayHeader
        eyebrow="premium"
        title={store.title}
        actions={
          <IconButton aria-label={`Close ${store.title}`} title="Close (Esc)" onClick={closeStore}>
            <X size={15} strokeWidth={1.75} />
          </IconButton>
        }
      />
      <div data-testid="overlay-store">
        <StoreSlot onClose={closeStore} />
      </div>
    </FocusSurface>
  );
}
