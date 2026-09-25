/**
 * The words beneath an agent seat's name when neither a declared signal nor
 * an AI reading speaks: the control state, said the way an operator would
 * say it. Friendly and true, never a raw state name ("unknown", "idle").
 */

import type { ActivitySpec, ActivityTone } from "./activity";

export type SeatLine = { readonly text: string; readonly tone?: ActivityTone };

const PROCESS = /^process — (.+)$/;

export const seatLine = (activity: ActivitySpec): SeatLine => {
  const { mode, tone, label } = activity;
  if (mode === "pulse" && tone === "green") return { text: "done, ready for review", tone: "green" };
  if (mode === "wave" && tone === "amber") {
    return { text: /stall/i.test(label) ? "stalled, needs a look" : "wants your input", tone: "amber" };
  }
  // Crimson in flight is a stoppage or a failure; its label is already copy.
  if (mode === "wave" && tone === "crimson") return { text: label, tone: "crimson" };
  if (mode === "wave") {
    if (/^starting/.test(label)) return { text: "starting up" };
    const process = PROCESS.exec(label);
    if (process?.[1]) return { text: `running ${process[1]}` };
    return { text: label };
  }
  switch (label) {
    case "idle":
      return { text: "resting" };
    case "seated":
      return { text: "ready" };
    case "stopped":
      return { text: "stopped" };
    case "offline":
    case "gone":
    case "unknown":
      return { text: "offline" };
    default:
      return { text: label };
  }
};
