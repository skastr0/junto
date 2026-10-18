/**
 * Whether a seat's next turn starts fresh. Main answers from the same test
 * that cuts a cold session (modelSeatLaunchState, operator-offboard.ts), for a
 * seat that is not running and for one sitting idle. The card asks again
 * whenever something that could change the answer moves (an exit, a state
 * change, an offboard step, a new binding, a changed cache window), and once
 * more at the moment main says the session goes cold. A seat in a turn
 * continues; nothing is asked. A seat on another machine is answered by that
 * machine over the link, its moment already on this clock (seats-launch.ts);
 * until it has answered, the seat says nothing.
 */
import { useEffect } from "react";
import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import type { SeatNextTurn } from "@shared/seat-next-launch";
import { getJuntoApi } from "./junto-api";
import { seatOffboard$, seatOffboardProgressOf, subscribeSeatOffboard } from "./seat-offboard-state";
import { state$ } from "./state";

/** Canvas, then seat id. */
export const seatNextTurn$ = observable<Record<string, Record<string, SeatNextTurn | undefined> | undefined>>({});

/** Ask main once for this seat. A refusal (another machine with no answer yet) clears the answer. */
export const askSeatNextTurn = async (canvas: string, id: string): Promise<void> => {
  const read = getJuntoApi()?.modelSeatLaunchState;
  if (!read) return;
  try {
    const { nextTurn } = await read({ canvas, id });
    if (nextTurn) seatNextTurn$[canvas][id].set(nextTurn);
    else seatNextTurn$[canvas][id].delete();
  } catch {
    seatNextTurn$[canvas][id].delete();
  }
};

/** A timer's longest delay; a later moment is asked again when this one fires. */
const MAX_DELAY_MS = 2_147_483_647;

/**
 * True when the seat's next turn starts fresh, while `still` (not running, or
 * idle). `moved` changes whenever the answer may have: the card passes what
 * it knows of the seat's process and state.
 */
export const useSeatFreshNext = (canvas: string, id: string, still: boolean, moved: string): boolean => {
  useEffect(() => {
    subscribeSeatOffboard();
  }, []);
  const offboardAt = use$(() => {
    // Every seat's progress is tracked; this card reads its own step.
    seatOffboard$.byKey.get();
    return seatOffboardProgressOf(canvas, id)?.at;
  });
  // The cache windows this machine's seats are cut at.
  const windows = use$(() => JSON.stringify(state$.settings.offboard.get() ?? null));
  useEffect(() => {
    if (still) void askSeatNextTurn(canvas, id);
    // A turn makes the last answer stale: drop it, so the line never flashes it.
    else seatNextTurn$[canvas][id].delete();
  }, [canvas, id, still, moved, offboardAt, windows]);
  const next = use$(seatNextTurn$[canvas][id]);
  // Nothing moves when a still session goes cold: ask again at that moment.
  const freshAt = still ? next?.freshAt : undefined;
  useEffect(() => {
    if (freshAt === undefined) return;
    const timer = setTimeout(
      () => void askSeatNextTurn(canvas, id),
      Math.min(Math.max(freshAt - Date.now(), 0) + 1_000, MAX_DELAY_MS),
    );
    return () => clearTimeout(timer);
  }, [canvas, id, freshAt]);
  return still && next?.fresh === true;
};
