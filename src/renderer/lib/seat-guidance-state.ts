import { observable } from "@legendapp/state";
import type { SeatGuidance } from "@shared/seat-guidance";

/**
 * Renderer mirror of the per-seat soul and instructions main holds in
 * junto.db. Loaded once on first use, then kept live by main's per-seat
 * broadcasts, so every editor of a seat (in any window) reads the same text.
 */
export const seatGuidance$ = observable<Record<string, SeatGuidance>>({});

let started = false;

/** Load every seat's guidance and follow main's broadcasts. Idempotent. */
export const startSeatGuidance = (): void => {
  if (started) return;
  const api = typeof window === "undefined" ? undefined : window.junto;
  if (!api?.seatGuidanceList) return;
  started = true;
  api.onSeatGuidance?.(({ seatId, guidance }) => {
    if (guidance) seatGuidance$[seatId].set(guidance);
    else seatGuidance$[seatId].delete();
  });
  void api
    .seatGuidanceList()
    .then((rows) => {
      // Broadcasts that landed while loading are newer than the list.
      seatGuidance$.set({ ...rows, ...seatGuidance$.peek() });
    })
    .catch(() => {
      started = false;
    });
};

/** The saved guidance for one seat, if any. */
export const seatGuidanceOf = (seatId: string): SeatGuidance | undefined =>
  seatGuidance$[seatId].peek() as SeatGuidance | undefined;

/**
 * Replace one seat's soul and instructions (null or both empty clears).
 * Resolves "" when saved, else the reason main refused.
 */
export const saveSeatGuidance = async (seatId: string, guidance: SeatGuidance | null): Promise<string> => {
  const api = typeof window === "undefined" ? undefined : window.junto;
  if (!api?.seatGuidanceSet) return "seat guidance is unavailable";
  try {
    const result = await api.seatGuidanceSet(seatId, guidance);
    if (!result.ok) return result.message;
    if (result.guidance) seatGuidance$[seatId].set(result.guidance);
    else seatGuidance$[seatId].delete();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : "seat guidance save failed";
  }
};
