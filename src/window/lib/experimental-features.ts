/**
 * Experimental features in the renderer: the build's tier folded with the
 * operator's toggle from Settings, Experimental. Every renderer consumer of a
 * tiered feature reads these, never the tier itself, so "compiled in" can
 * never be mistaken for "on".
 */

import { use$ } from "@legendapp/state/react";
import type { FeatureKey } from "@shared/feature-catalog";
import { featureOn, seatAwarenessOn } from "@shared/features";
import { patchSettings } from "./settings-state";
import { state$ } from "./state";

type TieredFeature = FeatureKey;

/** Resolved now, from the current settings snapshot (not reactive). */
export const featureOnNow = (key: TieredFeature): boolean =>
  featureOn(key, state$.settings.advanced.experimental.peek());

/** Resolved and reactive: re-renders when the operator flips the toggle. */
export const useFeatureOn = (key: TieredFeature): boolean =>
  use$(() => featureOn(key, state$.settings.advanced.experimental.get()));

/** Seat awareness (Jev), resolved and reactive. */
export const useSeatAwarenessOn = (): boolean =>
  use$(() => seatAwarenessOn(state$.settings.advanced.experimental.get()));

/** Seat awareness (Jev), resolved now. */
export const seatAwarenessOnNow = (): boolean =>
  seatAwarenessOn(state$.settings.advanced.experimental.peek());

/** Follow the toggle: `listener` hears each change of the resolved value. */
export const onSeatAwarenessToggle = (listener: (on: boolean) => void): (() => void) => {
  let last = seatAwarenessOnNow();
  return state$.settings.advanced.experimental.onChange(() => {
    const next = seatAwarenessOnNow();
    if (next === last) return;
    last = next;
    listener(next);
  });
};

/** Turn one experimental feature on or off; merged key by key in main. */
export const setExperimentalFeature = (key: TieredFeature, on: boolean): Promise<boolean> =>
  patchSettings({ advanced: { experimental: { [key]: on } } });
