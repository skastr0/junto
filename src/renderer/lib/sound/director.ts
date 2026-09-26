/**
 * What each event sounds like. Pure mappings; the call sites (the alert
 * queue's rising edges, signal upserts, wire pulses, squad placement) only
 * name what happened.
 */

import type { AgentSignal, AgentSignalKind } from "@shared/agent-signals";
import type { AlertKind } from "../alert-queue";
import type { CueId } from "./cues";

/**
 * A node's state rising on the alert ladder (working < ready < attention <
 * blocked). The queue baselines first sight and re-fires only on a rise, so
 * a seat is heard when it gets more urgent, never when it calms down.
 */
export const ALERT_CUE: Readonly<Record<AlertKind, CueId>> = {
  blocked: "blocked",
  attention: "waiting",
  ready: "done",
  working: "working",
};

const SIGNAL_CUE: Readonly<Record<AgentSignalKind, CueId>> = {
  blocked: "blocked",
  escalate: "waiting",
  feedback: "review",
};

/**
 * A seat's own signal as it now stands, against what the mirror held. A new
 * open signal sounds its kind; an open signal the operator answered sounds
 * the answer landing. Dismissed and withdrawn signals are silent.
 */
export const signalCue = (previous: AgentSignal | undefined, next: AgentSignal): CueId | undefined => {
  if (next.state === "open") return previous === undefined ? SIGNAL_CUE[next.kind] : undefined;
  if (next.state === "answered" && previous?.state === "open") return "answered";
  return undefined;
};
