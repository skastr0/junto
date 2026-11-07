import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { PortraitConfig } from "@shared/agent-portrait";
import type { ThemeMode } from "@shared/theme";
import type { CanvasTier } from "../lib/canvas-tier";

// What the seat's drawing reads from the app: the theme, the camera's
// detail tier, and the operator's saved portraits. The canvas feeds it from
// its stores (LiveSeatViewSource); with no provider a seat draws from fixed
// defaults, which is how the tour kit and the website draw one.

/** A value that can change, and tells whoever listens when it does. */
export type Readable<T> = {
  readonly get: () => T;
  readonly subscribe: (onChange: () => void) => () => void;
};

export type SeatViewSource = {
  readonly theme: Readable<ThemeMode>;
  readonly tier: Readable<CanvasTier>;
  readonly portraits: {
    readonly get: (identity: string) => PortraitConfig | undefined;
    readonly subscribe: (identity: string, onChange: () => void) => () => void;
  };
};

const NEVER = (): (() => void) => () => undefined;

export const fixedReadable = <T,>(value: T): Readable<T> => ({ get: () => value, subscribe: NEVER });

/**
 * No provider: the dark theme, full detail ("near", canvasTier$'s own
 * default, so every ring runs at its finest), no saved portraits.
 */
export const FIXED_SEAT_VIEW_SOURCE: SeatViewSource = {
  theme: fixedReadable<ThemeMode>("dark"),
  tier: fixedReadable<CanvasTier>("near"),
  portraits: { get: () => undefined, subscribe: NEVER },
};

const SeatViewSourceContext = createContext<SeatViewSource>(FIXED_SEAT_VIEW_SOURCE);

/** Feeds every seat drawn below it. Pass one source for the life of the tree. */
export function SeatViewSourceProvider({ source, children }: { readonly source: SeatViewSource; readonly children: ReactNode }) {
  return <SeatViewSourceContext.Provider value={source}>{children}</SeatViewSourceContext.Provider>;
}

const useReadable = <T,>(readable: Readable<T>): T => useSyncExternalStore(readable.subscribe, readable.get, readable.get);

export const useSeatTheme = (): ThemeMode => useReadable(useContext(SeatViewSourceContext).theme);

export const useSeatTier = (): CanvasTier => useReadable(useContext(SeatViewSourceContext).tier);

/** The operator's saved override for a seat's portrait, if any. */
export const useSeatPortraitConfig = (identity: string): PortraitConfig | undefined => {
  const { portraits } = useContext(SeatViewSourceContext);
  const subscribe = useCallback((onChange: () => void) => portraits.subscribe(identity, onChange), [portraits, identity]);
  const get = useCallback(() => portraits.get(identity), [portraits, identity]);
  return useSyncExternalStore(subscribe, get, get);
};
