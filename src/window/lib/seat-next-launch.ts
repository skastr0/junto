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
 *
 * The same answer carries the seat against its cache window
 * (`seatCacheWindow$`): told while the seat is still and its next turn picks
 * up where it was, and asked again the moment the window ends.
 */
import { useEffect } from "react";
import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import type { AgentSeatState } from "@shared/agent-seat-state";
import type { AgentSignalKind } from "@shared/agent-signals";
import type { SeatCacheWindow, SeatNextTurn } from "@shared/seat-next-launch";
import type { ActivitySpec } from "./activity";
import { getJuntoApi } from "./junto-api";
import { notifyItem, type SeatFacts } from "./seat-projections";
import { seatOffboard$, seatOffboardProgressOf, subscribeSeatOffboard } from "./seat-offboard-state";
import { state$ } from "./state";

/** Canvas, then seat id. */
export const seatNextTurn$ = observable<Record<string, Record<string, SeatNextTurn | undefined> | undefined>>({});

/** Canvas, then seat id: the seat against its cache window, from the same answer. */
export const seatCacheWindow$ = observable<Record<string, Record<string, SeatCacheWindow | undefined> | undefined>>({});

/** Drop the last answer: a turn, or a seat that is no longer still, makes it stale. */
export const forgetSeatNextTurn = (canvas: string, id: string): void => {
  seatNextTurn$[canvas][id].delete();
  seatCacheWindow$[canvas][id].delete();
};

/** Ask main once for this seat. A refusal (another machine with no answer yet) clears the answer. */
export const askSeatNextTurn = async (canvas: string, id: string): Promise<void> => {
  const read = getJuntoApi()?.modelSeatLaunchState;
  if (!read) return;
  try {
    const { nextTurn, cacheWindow } = await read({ canvas, id });
    if (nextTurn) seatNextTurn$[canvas][id].set(nextTurn);
    else seatNextTurn$[canvas][id].delete();
    if (cacheWindow) seatCacheWindow$[canvas][id].set(cacheWindow);
    else seatCacheWindow$[canvas][id].delete();
  } catch {
    forgetSeatNextTurn(canvas, id);
  }
};

/** A timer's longest delay; a later moment is asked again when this one fires. */
const MAX_DELAY_MS = 2_147_483_647;

/**
 * The moment to ask again: when the session goes cold, else when the cache
 * window ends, if that is still ahead. A window already past moves nothing.
 */
export const nextMoment = (freshAt: number | undefined, windowEndsAt: number | undefined, now: number): number | undefined => {
  const ahead = windowEndsAt !== undefined && windowEndsAt > now ? windowEndsAt : undefined;
  if (freshAt === undefined) return ahead;
  return ahead === undefined ? freshAt : Math.min(freshAt, ahead);
};

/**
 * The still predicate every surface shares: no process, or one sitting idle,
 * with nothing asking for the operator. A blocked or escalated seat, or one
 * whose notify item is up, says only that. The card and the canvas feed both
 * ask main's next-turn answer on exactly this.
 */
export const seatStillForNextTurn = (input: {
  readonly facts: SeatFacts;
  readonly mark: ActivitySpec;
  readonly hand: AgentSignalKind | undefined;
  readonly seatState: AgentSeatState | undefined;
}): boolean =>
  notifyItem(input.facts) === null &&
  input.hand !== "blocked" &&
  input.hand !== "escalate" &&
  ((input.mark.mode === "static" && input.mark.glyph === "off") || input.seatState === "idle");

/**
 * What may have changed the answer, as one string: the seat's binding, its
 * reported state and time, its session epoch and status, whether its machine
 * is reachable, and whether the operator is looking at it. A surface that
 * asks on change keys on this; the offboard step and the cache windows this
 * machine's seats are cut at join it at the call site.
 */
export const seatLaunchMovedKey = (input: {
  readonly bindingId: string | undefined;
  readonly seatState: AgentSeatState | undefined;
  readonly seatAt: number | undefined;
  readonly epoch: string | undefined;
  readonly status: string | undefined;
  readonly reachable: boolean | undefined;
  readonly viewed: boolean;
}): string =>
  `${input.bindingId ?? ""}:${input.seatState ?? ""}:${input.seatAt ?? 0}:${input.epoch ?? ""}:${input.status ?? ""}:${String(input.reachable)}:${String(input.viewed)}`;

/** The still seat against its cache window, while main tells it. */
export const useSeatCacheWindow = (canvas: string, id: string): SeatCacheWindow | undefined =>
  use$(seatCacheWindow$[canvas][id]);

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
    else forgetSeatNextTurn(canvas, id);
  }, [canvas, id, still, moved, offboardAt, windows]);
  const next = use$(seatNextTurn$[canvas][id]);
  const windowEndsAt = use$(() => seatCacheWindow$[canvas][id].get()?.windowEndsAt);
  // Nothing moves when a still session goes cold, or when its cache window
  // ends: ask again at the first of those moments still ahead.
  const askAt = still ? nextMoment(next?.freshAt, windowEndsAt, Date.now()) : undefined;
  useEffect(() => {
    if (askAt === undefined) return;
    const timer = setTimeout(
      () => void askSeatNextTurn(canvas, id),
      Math.min(Math.max(askAt - Date.now(), 0) + 1_000, MAX_DELAY_MS),
    );
    return () => clearTimeout(timer);
  }, [canvas, id, askAt]);
  return still && next?.fresh === true;
};
