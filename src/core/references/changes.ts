import type { ReferencesChangedEvent } from "@shared/references";

/**
 * Who hears that the briefing or a reference changed. The store says so after
 * every committed write, whoever wrote it, so a page the operator has open
 * refreshes after an overseer writes.
 */
type Listener = (event: ReferencesChangedEvent) => void;

const listeners = new Set<Listener>();

export const onReferencesChanged = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const emitReferencesChanged = (event: ReferencesChangedEvent): void => {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // One listener's failure is not the writer's.
    }
  }
};
