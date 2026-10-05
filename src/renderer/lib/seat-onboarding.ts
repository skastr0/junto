/**
 * Seat onboarding, as the renderer shows it: whether each seat's agent ran
 * `junto onboard` in the harness session it is running now.
 *
 * Main owns the status and broadcasts `seatOnboardingChanged`, keyed by
 * terminal binding like seat state. This module subscribes, then hydrates the
 * snapshot, so a renderer restart loses nothing. A seat with no entry has no
 * status yet (it never started in this run), and nothing is shown for it.
 *
 * Never writes the canvas. Absent bridge degrades to a no-op subscribe.
 */

import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import { useEffect } from "react";
import type { CanvasNode } from "@shared/canvas";
import type {
  SeatOnboardingEvent,
  SeatOnboardingStatus,
  SeatOnboardNudgeResult,
} from "@shared/seat-onboarding-status";
import { bindingIdForNode } from "./agent-seat-state";
import { getJuntoApi } from "./junto-api";
import { state$ } from "./state";

export const seatOnboarding$ = observable<{
  readonly byBindingId: Record<string, SeatOnboardingEvent | undefined>;
}>({ byBindingId: {} });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Strict decode: the renderer shows only what it recognizes. */
export const decodeSeatOnboardingEvent = (raw: unknown): SeatOnboardingEvent | undefined => {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.bindingId !== "string" || raw.bindingId.length === 0) return undefined;
  if (raw.status !== "onboarded" && raw.status !== "not-onboarded") return undefined;
  if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) return undefined;
  return { bindingId: raw.bindingId, status: raw.status, at: raw.at };
};

export const applySeatOnboardingEvent = (event: SeatOnboardingEvent): void => {
  const current = seatOnboarding$.byBindingId[event.bindingId].peek();
  // A snapshot that races a streamed change must not put the older one back.
  if (current !== undefined && current.at > event.at) return;
  seatOnboarding$.byBindingId[event.bindingId].set(event);
};

let activeUnsubscribe: (() => void) | undefined;

/** Singleton fan-out; only the first call subscribes. */
export const subscribeSeatOnboarding = (): (() => void) => {
  if (activeUnsubscribe) return activeUnsubscribe;
  const api = getJuntoApi();
  if (!api || typeof api.onSeatOnboardingChanged !== "function") return () => undefined;
  const unsubscribe = api.onSeatOnboardingChanged((raw) => {
    const event = decodeSeatOnboardingEvent(raw);
    if (event) applySeatOnboardingEvent(event);
  });
  let active = true;
  activeUnsubscribe = () => {
    active = false;
    unsubscribe();
    activeUnsubscribe = undefined;
  };
  // Subscribe before reading current state, like seat state does.
  void api.seatOnboardingSnapshot?.().then(
    (snapshot) => {
      if (!active || !Array.isArray(snapshot)) return;
      for (const raw of snapshot) {
        const event = decodeSeatOnboardingEvent(raw);
        if (event) applySeatOnboardingEvent(event);
      }
    },
    () => undefined,
  );
  return activeUnsubscribe;
};

/** One seat's status; undefined until main has one for it. */
export const useSeatOnboarding = (
  node: Pick<CanvasNode, "id" | "ether">,
): SeatOnboardingStatus | undefined => {
  useEffect(() => {
    subscribeSeatOnboarding();
  }, []);
  const bindingId = bindingIdForNode(node);
  return use$(() => (bindingId ? seatOnboarding$.byBindingId[bindingId].get()?.status : undefined));
};

/** Ask main to type the onboarding nudge into this seat now. */
export const sendOnboardNudge = async (seatId: string): Promise<SeatOnboardNudgeResult> => {
  const result = await getJuntoApi()
    ?.seatOnboardNudge?.(state$.canvasName.peek(), seatId)
    .catch(() => undefined);
  return result ?? { ok: false, message: "Junto could not send the nudge." };
};
