import type { SeatGuidance, SeatGuidanceMap } from "@shared/seat-guidance";

/**
 * The seat guidance the spawn plan reads while it compiles a seat's doctrine.
 * Spawn is synchronous, so the rows live here as well as in junto.db: every
 * write through IPC notes its stored result, and boot hydrates the rest.
 * `hydrate` never undoes a write it did not see first.
 */
export type SeatGuidanceIndex = {
  readonly get: (seatId: string) => SeatGuidance | undefined;
  readonly note: (seatId: string, guidance: SeatGuidance | null) => void;
  readonly hydrate: (rows: SeatGuidanceMap) => void;
};

export const makeSeatGuidanceIndex = (): SeatGuidanceIndex => {
  const bySeat = new Map<string, SeatGuidance>();
  const noted = new Set<string>();
  return {
    get: (seatId) => bySeat.get(seatId),
    note: (seatId, guidance) => {
      noted.add(seatId);
      if (guidance === null) bySeat.delete(seatId);
      else bySeat.set(seatId, guidance);
    },
    hydrate: (rows) => {
      for (const [seatId, guidance] of Object.entries(rows)) {
        if (!noted.has(seatId)) bySeat.set(seatId, guidance);
      }
    },
  };
};

/** The process's one index, noted from the guidance write path. */
export const seatGuidanceIndex = makeSeatGuidanceIndex();
