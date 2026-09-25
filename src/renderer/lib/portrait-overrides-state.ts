import { observable } from "@legendapp/state";
import type { PortraitConfig } from "@shared/agent-portrait";
import type { PortraitOverride } from "@shared/portrait-overrides";

/**
 * Renderer mirror of the per-seat portrait overrides main holds in junto.db.
 * Loaded once on first use, then kept live by main's per-seat broadcasts, so
 * every portrait of a seat (in any window) wears the same character.
 */
export const portraitOverrides$ = observable<Record<string, PortraitOverride>>({});

let started = false;

/** Load every override and follow main's broadcasts. Idempotent. */
export const startPortraitOverrides = (): void => {
  if (started) return;
  const api = typeof window === "undefined" ? undefined : window.junto;
  if (!api?.portraitOverridesList) return;
  started = true;
  api.onPortraitOverride?.(({ seatId, override }) => {
    if (override) portraitOverrides$[seatId].set(override);
    else portraitOverrides$[seatId].delete();
  });
  void api
    .portraitOverridesList()
    .then((overrides) => {
      // Broadcasts that landed while loading are newer than the list.
      portraitOverrides$.set({ ...overrides, ...portraitOverrides$.peek() });
    })
    .catch(() => {
      started = false;
    });
};

/** Replace one seat's override (null or empty resets). Resolves false when main refused. */
export const savePortraitOverride = async (seatId: string, config: PortraitConfig | null): Promise<boolean> => {
  const api = window.junto;
  if (!api?.portraitOverrideSet) return false;
  const empty = config === null || Object.values(config).every((value) => value === undefined);
  try {
    const result = await api.portraitOverrideSet(seatId, empty ? null : config);
    if (!result.ok) return false;
    if (result.override) portraitOverrides$[seatId].set(result.override);
    else portraitOverrides$[seatId].delete();
    return true;
  } catch {
    return false;
  }
};
