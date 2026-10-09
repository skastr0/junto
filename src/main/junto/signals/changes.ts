import type { AgentSignal } from "@shared/agent-signals";

/**
 * Who hears that a signal was written: raised, withdrawn, answered,
 * dismissed, or taken from another machine. The store says so after every
 * committed write, so the row exchange carries it to the machine that needs it.
 */
type Listener = (signal: AgentSignal) => void;

const listeners = new Set<Listener>();

export const onAgentSignalChanged = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const emitAgentSignalChanged = (signal: AgentSignal): void => {
  for (const listener of [...listeners]) {
    try {
      listener(signal);
    } catch {
      // One listener's failure is not the writer's.
    }
  }
};
