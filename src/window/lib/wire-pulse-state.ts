/**
 * The canvas's wire pulses: the per-edge pulse the edges subscribe to and
 * the one scheduler that fills it (wire-pulse.ts holds the pure rules).
 */

import { observable } from "@legendapp/state";
import { WirePulseScheduler, type WirePulse } from "./wire-pulse";

/** Per-edge pulse, keyed so only the lit edge re-renders. */
export const wirePulses$ = observable<Record<string, WirePulse>>({});

export const wirePulseScheduler = new WirePulseScheduler((edgeId, pulse) => {
  if (pulse === undefined) wirePulses$[edgeId]!.delete();
  else wirePulses$[edgeId]!.set(pulse);
});
