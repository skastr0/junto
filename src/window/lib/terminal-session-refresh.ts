import type { TerminalSessionSummary } from "@shared/terminal";

/**
 * Canvas cards must not treat PTY output as a session-status edge.
 *
 * Output is coalesced at 50ms and already painted by the open xterm.
 * `terminalGet` + Legend/React writes on that cadence re-render every
 * subscribed card (and NodeShell occupancy) for the life of a stream —
 * the GPU/fan path. Session and exit are the only events that change
 * card chrome (status, pid, spawn failure).
 */
export const shouldRefreshSessionFromTerminalEvent = (
  event: unknown,
): boolean => {
  if (typeof event !== "object" || event === null) return false;
  const type = (event as { readonly type?: unknown }).type;
  return type === "session" || type === "exit";
};

/**
 * Title / processName change every OSC spinner frame. They are display
 * fallbacks, not occupancy. Skip store writes when lifecycle chrome is
 * unchanged so a 2.5s poll cannot re-render the canvas during a turn.
 */
export const sessionChromeUnchanged = (
  prev: TerminalSessionSummary | undefined,
  next: TerminalSessionSummary | undefined,
): boolean => {
  if (prev === next) return true;
  if (prev === undefined || next === undefined) return false;
  return (
    prev.bindingId === next.bindingId &&
    prev.epoch === next.epoch &&
    prev.status === next.status &&
    prev.stopping === next.stopping &&
    prev.pid === next.pid &&
    prev.exitReason === next.exitReason &&
    prev.exitMessage === next.exitMessage
  );
};
