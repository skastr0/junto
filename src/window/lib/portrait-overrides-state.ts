import { observable } from "@legendapp/state";
import type { PortraitConfig } from "@shared/agent-portrait";
import { normalizePortraitOverride, type PortraitOverride } from "@shared/portrait-overrides";
import type { ContentCalls } from "./content-calls";

/**
 * Renderer mirror of the per-seat portrait overrides the core holds in
 * junto.db. Loaded once when the app's root mounts (LiveSeatViewSource), then
 * kept live by main's per-seat broadcasts, so every portrait of a seat (in any
 * window) wears the same character.
 */
export const portraitOverrides$ = observable<Record<string, PortraitOverride>>({});

let started = false;

/** Load every override and follow main's broadcasts. Idempotent; a failed load lets the next start try again. */
export const startPortraitOverrides = (content: ContentCalls | undefined): void => {
  if (started || content === undefined) return;
  started = true;
  window.junto?.onPortraitOverride?.(({ seatId, override }) => {
    if (override) portraitOverrides$[seatId].set(override);
    else portraitOverrides$[seatId].delete();
  });
  void content
    .portraitOverrides()
    .then((overrides) => {
      // Broadcasts that landed while loading are newer than the list.
      portraitOverrides$.set({ ...overrides, ...portraitOverrides$.peek() });
    })
    .catch(() => {
      started = false;
    });
};

/**
 * Replace one seat's override (null, empty or nothing well-shaped resets).
 * Resolves false when the store refused it or no call could be made.
 */
export const savePortraitOverride = async (
  content: ContentCalls | undefined,
  seatId: string,
  config: PortraitConfig | null,
): Promise<boolean> => {
  if (content === undefined) return false;
  try {
    const result = await content.portraitOverrideSet(seatId, config === null ? null : normalizePortraitOverride(config));
    if (!result.ok) return false;
    if (result.override) portraitOverrides$[seatId].set(result.override);
    else portraitOverrides$[seatId].delete();
    return true;
  } catch {
    return false;
  }
};
