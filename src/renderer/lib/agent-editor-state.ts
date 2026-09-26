/**
 * The customize-agent editor, opened from anywhere: the focus header portrait,
 * the seat toolbar, the seat right-click menu, the selection bar. It is a
 * modal; one is open at a time, and opening another seat replaces it.
 */
import { observable } from "@legendapp/state";

export const agentEditor$ = observable<{
  readonly seatId: string;
  readonly section?: string;
  /** Bumps on every open, so reopening starts fresh. */
  readonly opened: number;
} | null>(null);

let opens = 0;

export const openAgentEditor = (seatId: string, options: { readonly section?: string } = {}): void => {
  opens += 1;
  agentEditor$.set({ seatId, ...(options.section ? { section: options.section } : {}), opened: opens });
};

export const closeAgentEditor = (): void => {
  agentEditor$.set(null);
};
