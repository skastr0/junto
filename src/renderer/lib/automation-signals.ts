/**
 * The signal rows an automation's firing names, by id (0.11.1).
 *
 * A signal step's ruling says which signal it raised; what became of that
 * signal is the signal's own row, not the firing's. This window already
 * mirrors every signal a seat or an automation raises (`agent-signals-state`),
 * so the history reads that mirror and never asks main twice.
 */
import { useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import type { AgentSignal } from "@shared/wire/agent-signals";
import { agentSignals$ } from "./agent-signals-state";

/**
 * Every signal in this window, re-read when one arrives, answers or closes.
 * The store mutates in place, so its identity never moves; the key is what
 * can change about a row, as the feed's own read does it.
 */
const useAllSignals = (): ReadonlyArray<AgentSignal> => {
  const key = use$(() =>
    Object.values(agentSignals$.get())
      .map((signal) => `${signal.signalId}:${signal.state}:${signal.closedAt ?? 0}:${signal.response?.at ?? 0}`)
      .join("|"),
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => Object.values(agentSignals$.peek()), [key]);
};

/** The named signals that are in this window, by id. */
export const useSignalsById = (ids: ReadonlyArray<string>): ReadonlyMap<string, AgentSignal> => {
  const all = useAllSignals();
  const wanted = ids.join("|");
  return useMemo(() => {
    const found = new Map<string, AgentSignal>();
    for (const signal of all) {
      if (wanted.split("|").includes(signal.signalId)) found.set(signal.signalId, signal);
    }
    return found;
  }, [all, wanted]);
};
