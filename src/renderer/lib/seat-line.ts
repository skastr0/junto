/**
 * The words beneath an agent seat's name when neither a declared signal nor
 * an AI reading speaks: the control state, said the way an operator would
 * say it. Friendly and true, never a raw state name ("unknown", "idle").
 */

import type { AgentSignal, AgentSignalKind } from "@shared/agent-signals";
import type { ThreadHealthTone } from "@shared/thread-health";
import type { ActivitySpec, ActivityTone } from "./activity";
import { SIGNAL_FLAG_TONE } from "./activity-atlas";
import { controlFromActivity, seatRollup } from "./seat-rollup";

export type SeatLine = { readonly text: string; readonly tone?: ActivityTone };

const PROCESS = /^process — (.+)$/;

export const seatLine = (activity: ActivitySpec): SeatLine => {
  const { mode, tone, label } = activity;
  if (mode === "pulse" && tone === "green") return { text: "done, not read yet", tone: "green" };
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

const SIGNAL_WORD: Readonly<Record<AgentSignalKind, string>> = {
  blocked: "blocked",
  escalate: "waiting on you",
  feedback: "ready for review",
};

/**
 * What a seat says beneath its name, loudest first: its own open signal, then
 * a spawn failure, then the AI's reading, then the control state. The order
 * is seatRollup's, so every surface that speaks for a seat (the canvas seat,
 * the cmd+K row) says the same thing.
 */
export type SeatSaying =
  | { readonly kind: "signal"; readonly word: string; readonly tone: ActivityTone; readonly text: string }
  | { readonly kind: "failure"; readonly text: string }
  | { readonly kind: "reading"; readonly text: string; readonly stale: boolean }
  | { readonly kind: "state"; readonly text: string; readonly tone?: ActivityTone };

export const seatSaying = (input: {
  readonly activity: ActivitySpec;
  readonly signal?: AgentSignal;
  readonly failure?: string;
  readonly health: {
    readonly health?: ThreadHealthTone;
    readonly healthStale?: boolean;
    readonly line?: string;
  };
}): SeatSaying => {
  const { activity, signal, failure, health } = input;
  if (signal) {
    return { kind: "signal", word: SIGNAL_WORD[signal.kind], tone: SIGNAL_FLAG_TONE[signal.kind], text: signal.text };
  }
  // A spawn failure is the seat's own fact; it is not a rollup input.
  if (failure) return { kind: "failure", text: failure };
  const rollup = seatRollup({
    control: controlFromActivity(activity),
    health: { health: health.health, healthStale: health.healthStale === true, line: health.line },
  });
  if (rollup?.source === "health") {
    return { kind: "reading", text: health.line ?? health.health ?? "", stale: health.healthStale === true };
  }
  return { kind: "state", ...seatLine(activity) };
};
