import type { AgentSignal } from "./wire/agent-signals";

/**
 * An answer and a withdrawal that crossed, as either machine keeps them: the
 * editing machine an answered signal with `withdrawnAt` beside it, the seat's
 * machine a withdrawn one holding the answer that came after. The one rule
 * the core's thread reads and the feed's pane share.
 */
export const crossedClosing = (signal: AgentSignal): boolean =>
  (signal.state === "answered" && typeof (signal as { readonly withdrawnAt?: unknown }).withdrawnAt === "number") ||
  (signal.state === "withdrawn" && signal.response !== undefined);
