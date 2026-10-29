/**
 * What each event sounds like. Pure mappings; the call sites (the alert
 * queue's rising edges, signal upserts, wire pulses, squad placement) only
 * name what happened.
 */

import type { AgentSignal, AgentSignalKind } from "@shared/agent-signals";
import { AlertKind } from "@shared/wire/urgency";
import type { AlertGroup } from "../alert-queue";
import type { CueId } from "./cues";

/**
 * The cue a node's state is heard as when it rises on the alert ladder
 * (working < ready < attention < blocked); the quiet group raises none. The
 * queue baselines first sight and re-fires only on a rise, so a seat is heard
 * when it gets more urgent, never when it calms down.
 */
export const alertCue = (group: AlertGroup): CueId | undefined => {
  switch (group) {
    case AlertKind.group.blocked:
      return "blocked";
    case AlertKind.group.attention:
      return "waiting";
    case AlertKind.group.ready:
      return "done";
    case AlertKind.group.working:
      return "working";
    case AlertKind.group.quiet:
      return undefined;
  }
};

const SIGNAL_CUE: Readonly<Record<AgentSignalKind, CueId>> = {
  blocked: "blocked",
  escalate: "waiting",
  feedback: "review",
  work: "review",
  notice: "bell",
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
