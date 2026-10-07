/**
 * Where each seat's offboard stands, for the seat itself.
 *
 * The offboard controls live in the seat's editor and show every step there.
 * A failure must not need that panel open to be seen: an offboard is usually
 * the agent's own doing, the operator is looking at the canvas, and a session
 * that silently never closed is the worst outcome. So the latest progress per
 * seat is kept here and a failed one is said on the seat card.
 *
 * Main owns the progress (the offboard closer) and pushes each change; this
 * module subscribes, then hydrates the current list. Never writes the canvas.
 */
import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import { useEffect } from "react";
import type { SeatOffboardProgress } from "@shared/seat-sessions";
import { getJuntoApi } from "./junto-api";
import { state$ } from "./state";

const keyOf = (canvasName: string, seatId: string): string => `${canvasName}\u0000${seatId}`;

export const seatOffboard$ = observable<{
  readonly byKey: Record<string, SeatOffboardProgress | undefined>;
}>({ byKey: {} });

export const applySeatOffboardProgress = (progress: SeatOffboardProgress): void => {
  const key = keyOf(progress.canvasName, progress.seatId);
  const current = seatOffboard$.byKey[key].peek();
  // A list that races a pushed change must not put the older step back.
  if (current !== undefined && current.at > progress.at) return;
  seatOffboard$.byKey[key].set(progress);
};

let activeUnsubscribe: (() => void) | undefined;

/** Singleton fan-out; only the first call subscribes. */
export const subscribeSeatOffboard = (): (() => void) => {
  if (activeUnsubscribe) return activeUnsubscribe;
  const api = getJuntoApi();
  if (!api || typeof api.onSeatOffboardProgress !== "function") return () => undefined;
  const unsubscribe = api.onSeatOffboardProgress(applySeatOffboardProgress);
  let active = true;
  activeUnsubscribe = () => {
    active = false;
    unsubscribe();
    activeUnsubscribe = undefined;
  };
  void api.seatOffboardProgressList?.().then(
    (all) => {
      if (active && Array.isArray(all)) for (const progress of all) applySeatOffboardProgress(progress);
    },
    () => undefined,
  );
  return activeUnsubscribe;
};

/** What the seat says about an offboard that did not close its session. */
export const offboardFailureLine = (progress: SeatOffboardProgress | undefined): string | undefined => {
  if (progress?.stage !== "failed") return undefined;
  const reason = progress.message?.trim() || "Junto could not close this session.";
  return `Offboard did not finish: ${reason}`;
};

/** The failure line for one seat on the open canvas, while its latest offboard stands failed. */
export const useSeatOffboardFailure = (seatId: string): string | undefined => {
  useEffect(() => {
    subscribeSeatOffboard();
  }, []);
  const canvasName = use$(state$.canvasName);
  return use$(() => offboardFailureLine(seatOffboard$.byKey[keyOf(canvasName, seatId)].get()));
};
