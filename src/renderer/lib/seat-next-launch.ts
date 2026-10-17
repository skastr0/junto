/**
 * What a seat that is not running will do when it next starts: resume its
 * session or begin fresh. Main answers from the seat's sessions and the
 * harness's own store (modelSeatLaunchState); the card asks again whenever
 * something that could change the answer moves (an exit, an offboard step,
 * a new binding). A seat on another machine gets no answer and says only
 * that it is not running.
 */
import { useEffect } from "react";
import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import type { SeatNextLaunch } from "@shared/seat-next-launch";
import { getJuntoApi } from "./junto-api";
import { seatOffboard$, seatOffboardProgressOf, subscribeSeatOffboard } from "./seat-offboard-state";

/** Canvas, then seat id. */
export const seatNextLaunch$ = observable<Record<string, Record<string, SeatNextLaunch | undefined> | undefined>>({});

/** Ask main once for this seat. A refusal (another machine) clears the answer. */
export const askSeatNextLaunch = async (canvas: string, id: string): Promise<void> => {
  const read = getJuntoApi()?.modelSeatLaunchState;
  if (!read) return;
  try {
    seatNextLaunch$[canvas][id].set((await read({ canvas, id })).next);
  } catch {
    seatNextLaunch$[canvas][id].delete();
  }
};

/**
 * The seat's next start, while `notRunning`. `moved` changes whenever the
 * answer may have: the card passes what it knows of the seat's process.
 */
export const useSeatNextLaunch = (
  canvas: string,
  id: string,
  notRunning: boolean,
  moved: string,
): SeatNextLaunch | undefined => {
  useEffect(() => {
    subscribeSeatOffboard();
  }, []);
  const offboardAt = use$(() => {
    // Every seat's progress is tracked; this card reads its own step.
    seatOffboard$.byKey.get();
    return seatOffboardProgressOf(canvas, id)?.at;
  });
  useEffect(() => {
    if (notRunning) void askSeatNextLaunch(canvas, id);
  }, [canvas, id, notRunning, moved, offboardAt]);
  const next = use$(seatNextLaunch$[canvas][id]);
  return notRunning ? next : undefined;
};
