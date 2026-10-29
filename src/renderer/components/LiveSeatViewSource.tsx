import { useEffect, type ReactNode } from "react";
import type { Observable } from "@legendapp/state";
import type { PortraitConfig } from "@shared/agent-portrait";
import { canvasTier$ } from "../lib/canvas-tier";
import { portraitOverrides$, startPortraitOverrides } from "../lib/portrait-overrides-state";
import { surfaceMotionLive$ } from "../lib/surface-motion";
import { themeMode$ } from "../lib/theme-mode";
import { setMarkMotionSource } from "./ActivityMark";
import { SeatViewSourceProvider, type Readable, type SeatViewSource } from "./seat-view-source";

// The app's seats read the live stores: the theme, the camera's tier, the
// saved portraits, and the window's motion gate. Mounted once at the root
// (main.tsx); a seat drawn outside it falls back to fixed defaults, and
// tests/seat-view-source.test.tsx fails if the root loses it.

const readable = <T,>(value$: Observable<T>): Readable<T> => ({
  get: () => value$.peek(),
  subscribe: (onChange) => value$.onChange(onChange),
});

export const LIVE_SEAT_VIEW_SOURCE: SeatViewSource = {
  theme: readable(themeMode$),
  tier: readable(canvasTier$),
  portraits: {
    get: (identity) => {
      startPortraitOverrides();
      return portraitOverrides$[identity].peek() as PortraitConfig | undefined;
    },
    subscribe: (identity, onChange) => {
      startPortraitOverrides();
      return portraitOverrides$[identity].onChange(onChange);
    },
  },
};

const MOTION = readable(surfaceMotionLive$);

export function LiveSeatViewSource({ children }: { readonly children: ReactNode }) {
  useEffect(() => {
    setMarkMotionSource(MOTION);
    return () => setMarkMotionSource(undefined);
  }, []);
  return <SeatViewSourceProvider source={LIVE_SEAT_VIEW_SOURCE}>{children}</SeatViewSourceProvider>;
}
