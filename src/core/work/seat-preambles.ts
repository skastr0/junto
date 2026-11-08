/**
 * Each seat's last live `junto preamble`, for `seat read`: the thought bubble
 * a peer reads beside the screen. Memory only, never stored, as every
 * preamble is; a preamble past its expiry is gone.
 */

export type LiveSeatPreamble = { readonly text: string; readonly expiresAt: number };

const latest = new Map<string, LiveSeatPreamble>();
const key = (canvasName: string, nodeId: string): string => `${canvasName}\u0000${nodeId}`;

export const noteSeatPreamble = (canvasName: string, nodeId: string, preamble: LiveSeatPreamble): void => {
  latest.set(key(canvasName, nodeId), preamble);
};

/** The seat's last preamble while it is live, else undefined. */
export const liveSeatPreamble = (
  canvasName: string,
  nodeId: string,
  now: number = Date.now(),
): LiveSeatPreamble | undefined => {
  const ref = key(canvasName, nodeId);
  const preamble = latest.get(ref);
  if (preamble === undefined) return undefined;
  if (preamble.expiresAt > now) return preamble;
  latest.delete(ref);
  return undefined;
};
