/**
 * What deleting a canvas takes with it that the confirm names: the signals
 * still open on its seats, which close with it. The window mirrors the open
 * canvas's signals (agentSignals$), and a canvas is deleted from the bar
 * while it is the open one, so the mirror is the whole count.
 */
import type { AgentSignal } from "@shared/agent-signals";

/** Every signal in state open on this canvas, whatever its kind and whoever raised it. */
export const openSignalCount = (signals: Iterable<AgentSignal>, canvasName: string): number => {
  let count = 0;
  for (const signal of signals) if (signal.state === "open" && signal.canvasName === canvasName) count += 1;
  return count;
};

/** The line the delete confirm adds, only when something is open. */
export const signalsCloseLine = (count: number): string | undefined =>
  count === 0 ? undefined : count === 1 ? "1 open signal closes with it." : `${count} open signals close with it.`;
