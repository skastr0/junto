/**
 * The auto cache mode's question, for the seat's open terminal view.
 *
 * Main keeps the seats due the question (src/shared/seat-cache-due.ts) and
 * pushes the whole list on every change; this module subscribes, then reads
 * the list once for a window that just opened. A push that lands before that
 * read answers wins over it: the read is older. Never writes the canvas.
 */
import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import { useEffect } from "react";
import type { SeatCacheDue, SeatCacheDueAnswer, SeatCacheDueAnswerResult } from "@shared/seat-cache-due";
import { getJuntoApi } from "./junto-api";

const keyOf = (canvasName: string, seatId: string): string => `${canvasName}\u0000${seatId}`;

export const seatCacheDue$ = observable<{
  readonly byKey: Record<string, SeatCacheDue | undefined>;
}>({ byKey: {} });

/** Replace the seats due the question with main's whole list. */
export const applySeatCacheDue = (due: ReadonlyArray<SeatCacheDue>): void => {
  const byKey: Record<string, SeatCacheDue> = {};
  for (const ask of due) byKey[keyOf(ask.canvasName, ask.seatId)] = ask;
  seatCacheDue$.byKey.set(byKey);
};

let activeUnsubscribe: (() => void) | undefined;

/** Singleton fan-out; only the first call subscribes. */
export const subscribeSeatCacheDue = (): (() => void) => {
  if (activeUnsubscribe) return activeUnsubscribe;
  const api = getJuntoApi();
  if (!api || typeof api.onSeatCacheDue !== "function") return () => undefined;
  let pushed = false;
  const unsubscribe = api.onSeatCacheDue((due) => {
    pushed = true;
    applySeatCacheDue(due);
  });
  let active = true;
  activeUnsubscribe = () => {
    active = false;
    unsubscribe();
    activeUnsubscribe = undefined;
  };
  void api.seatCacheDueList?.().then(
    (due) => {
      if (active && !pushed && Array.isArray(due)) applySeatCacheDue(due);
    },
    () => undefined,
  );
  return activeUnsubscribe;
};

/** The seat's ask while main lists it, else undefined. */
export const useSeatCacheDue = (canvasName: string, seatId: string): SeatCacheDue | undefined => {
  useEffect(() => {
    subscribeSeatCacheDue();
  }, []);
  return use$(() => seatCacheDue$.byKey[keyOf(canvasName, seatId)].get());
};

/**
 * Send the operator's answer to the question main lists for the seat now,
 * named by its id. A bridge that is down or throws reads as a failure with a
 * message.
 */
export const answerSeatCacheDue = async (
  canvasName: string,
  seatId: string,
  answer: SeatCacheDueAnswer,
): Promise<SeatCacheDueAnswerResult> => {
  const send = getJuntoApi()?.seatCacheDueAnswer;
  if (typeof send !== "function") return { ok: false, message: "Junto could not reach this seat's machine." };
  const question = seatCacheDue$.byKey[keyOf(canvasName, seatId)].peek()?.question;
  if (question === undefined) return { ok: false, message: "This seat is no longer asking." };
  try {
    return await send({ canvasName, seatId, question, answer });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
};

/** "Cache expired 12m ago.", from when the window ended. */
export const cacheDueLine = (windowEndsAt: number, now: number): string => {
  const minutes = Math.floor((now - windowEndsAt) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "Cache expired just now.";
  if (minutes < 60) return `Cache expired ${minutes}m ago.`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `Cache expired ${hours}h ago.` : `Cache expired ${hours}h ${rest}m ago.`;
};
