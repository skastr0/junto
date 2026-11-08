/**
 * The key a draining session is read under.
 *
 * When a seat offboards, its old process is detached and allowed to finish
 * its turn while the seat already points at a fresh session. That old process
 * is a draining session. It keeps its terminal grid and its seat-state
 * reading, but under its own key, so it is read by itself and never mistaken
 * for the session that replaced it. One seat can have several.
 *
 * Pure module, no Node imports.
 */

const DRAIN_KEY_PREFIX = "drain:";

/** `drain:<bindingId>:<epoch>`: the key for one detached generation. */
export const drainKeyOf = (bindingId: string, epoch: string): string =>
  `${DRAIN_KEY_PREFIX}${bindingId}:${epoch}`;

/** True for a key minted by `drainKeyOf`. A seat's own binding id never is. */
export const isDrainKey = (key: string): boolean => key.startsWith(DRAIN_KEY_PREFIX);
