import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import {
  rollupSeatSignals,
  type AgentSignal,
  type SeatSignalRollup,
} from "@shared/agent-signals";
import type { AgentSignalOperatorResult, JuntoApi } from "@shared/ipc";
import { getJuntoApi } from "./junto-api";
import { playCue } from "./sound";
import { signalCue } from "./sound/director";
import { state$ } from "./state";

/**
 * Renderer projection of the open canvas's agent signals, keyed by signalId.
 * Hydrated from main when the canvas opens and kept current by main's upsert
 * events. Main owns the durable rows; this is a live mirror, never written
 * back.
 */
export const agentSignals$ = observable<Record<string, AgentSignal>>({});

/**
 * Apply one signal as it now stands; another canvas's signals are ignored.
 * Live changes are heard (a new signal, an answer landing); hydration goes
 * through replaceAgentSignals and is silent.
 */
export const upsertAgentSignal = (signal: AgentSignal): void => {
  if (signal.canvasName !== state$.canvasName.peek()) return;
  const cue = signalCue(agentSignals$[signal.signalId].peek(), signal);
  agentSignals$[signal.signalId].set(signal);
  if (cue !== undefined) playCue(cue, { subject: signal.nodeId });
};

/** Replace the mirror with one canvas's listing (empty name clears it). */
export const replaceAgentSignals = (
  canvasName: string,
  signals: ReadonlyArray<AgentSignal>,
): void => {
  agentSignals$.set(
    Object.fromEntries(
      signals
        .filter((signal) => signal.canvasName === canvasName)
        .map((signal) => [signal.signalId, signal]),
    ),
  );
};

const sameRollup = (a: SeatSignalRollup, b: SeatSignalRollup): boolean =>
  a.kind === b.kind &&
  a.openCount === b.openCount &&
  a.signal.signalId === b.signal.signalId &&
  a.signal.state === b.signal.state &&
  a.signal.text === b.signal.text;

/**
 * Worst open signal per seat. An entry keeps its identity while its seat's
 * rollup is unchanged, so one seat's signal never re-renders every card.
 */
export const reconcileRollups = (
  previous: ReadonlyMap<string, SeatSignalRollup>,
  signals: Iterable<AgentSignal>,
): ReadonlyMap<string, SeatSignalRollup> => {
  const next = rollupSeatSignals(signals);
  const out = new Map<string, SeatSignalRollup>();
  for (const [nodeId, rollup] of next) {
    const prior = previous.get(nodeId);
    out.set(nodeId, prior !== undefined && sameRollup(prior, rollup) ? prior : rollup);
  }
  return out;
};

let lastRollups: ReadonlyMap<string, SeatSignalRollup> = new Map();

/** Seat rollups for the open canvas, keyed by nodeId. */
export const seatSignalRollups$ = observable((): Readonly<Record<string, SeatSignalRollup>> => {
  lastRollups = reconcileRollups(lastRollups, Object.values(agentSignals$.get()));
  return Object.fromEntries(lastRollups);
});

/** The seat's worst open signal (blocked > escalate > feedback), if any. */
export const useSeatSignalRollup = (
  canvasName: string,
  nodeId: string,
): SeatSignalRollup | undefined =>
  use$(() =>
    canvasName === state$.canvasName.get()
      ? seatSignalRollups$.get()[nodeId]
      : undefined,
  );

type SignalApi = Pick<
  JuntoApi,
  "agentSignalsList" | "agentSignalRespond" | "agentSignalDismiss" | "onAgentSignal"
>;

const hydrate = async (api: SignalApi, canvasName: string): Promise<void> => {
  if (canvasName === "") {
    replaceAgentSignals("", []);
    return;
  }
  const listed = await Promise.resolve()
    .then(() => api.agentSignalsList(canvasName))
    .catch(() => undefined);
  if (listed === undefined || state$.canvasName.peek() !== canvasName) return;
  // Events that raced the listing are newer than it; keep them over the list.
  const live = Object.values(agentSignals$.peek()).filter(
    (signal) => signal.canvasName === canvasName,
  );
  replaceAgentSignals(canvasName, [...listed, ...live]);
};

/**
 * Follow the open canvas: hydrate on every canvas change and apply main's
 * live upserts. Returns the unsubscribe.
 */
export const startAgentSignalSync = (api: SignalApi): (() => void) => {
  // Optional-chained: a test or demo bridge may predate the signal surface.
  const offEvent = api.onAgentSignal?.(upsertAgentSignal) ?? (() => undefined);
  const offCanvas = state$.canvasName.onChange(({ value }) => {
    replaceAgentSignals(value, []);
    void hydrate(api, value);
  });
  void hydrate(api, state$.canvasName.peek());
  return () => {
    offEvent();
    offCanvas();
  };
};

export type SignalActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

const settle = (result: AgentSignalOperatorResult): SignalActionResult => {
  if (!result.ok) return result;
  upsertAgentSignal(result.signal);
  return { ok: true };
};

const unavailable: SignalActionResult = {
  ok: false,
  message: "Junto is not connected.",
};

/** Answer an open signal; main types it into the seat as operator mail. */
export const respondToAgentSignal = async (
  signalId: string,
  text: string,
): Promise<SignalActionResult> => {
  const api = getJuntoApi();
  if (!api) return unavailable;
  return api
    .agentSignalRespond(signalId, text)
    .then(settle, (error: unknown) => ({
      ok: false as const,
      message: error instanceof Error ? error.message : "answer failed",
    }));
};

/** Close an open signal without mail. */
export const dismissAgentSignal = async (signalId: string): Promise<SignalActionResult> => {
  const api = getJuntoApi();
  if (!api) return unavailable;
  return api
    .agentSignalDismiss(signalId)
    .then(settle, (error: unknown) => ({
      ok: false as const,
      message: error instanceof Error ? error.message : "dismiss failed",
    }));
};
