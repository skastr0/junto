/**
 * ActivityMark predicates.
 *
 * Rule: active work/block → wave (loops with the clock); ready/complete →
 * pulse (done draws itself once, then rests); settled → static mark.
 * Visible status labels are forbidden; aria/title carry the word. Complete
 * seats use the corner check only, no card-wide wash.
 *
 * Mode and tone say what the state is; the glyph is how the mark draws it
 * (see `resolveActivityGlyph` and activity-atlas.ts).
 *
 * Severity tones MUST match signal-mark / RTS ladder end-to-end
 * (cards, chips, minimap, command bar):
 *   blocked → crimson - attention → amber - working → cyan
 *   ready/complete → green - parked → violet (signal-mark only) - idle → steel
 * Motion pattern may change across states; the hue for a severity does not.
 */

import { SEVERITY_TONE, type ActivitySpec } from "@shared/seat-activity";
import { GREEN, HUE } from "./theme";

// The ring vocabulary is shared with the phone (src/shared/rings.ts).
export type { ActivityGlyph, ActivityTone } from "@shared/rings";
import type { ActivityTone } from "@shared/rings";
// The seat grammar is shared with the phone (src/shared/seat-activity.ts).
export {
  isActiveProcessLabel,
  resolveActivityGlyph,
  SEVERITY_TONE,
  terminalActivity,
  type ActivityMode,
  type ActivityPattern,
  type ActivitySpec,
} from "@shared/seat-activity";
/**
 * node = card corner, inline = chips and rows, seat = the ring around a
 * canvas portrait, glance = the ring around a small portrait in a list.
 */
export type ActivitySize = "node" | "inline" | "seat" | "glance";

export const ACTIVITY_TONE_HEX: Record<ActivityTone, string> = {
  amber: HUE.amber,
  cyan: HUE.cyan,
  green: GREEN,
  crimson: HUE.crimson,
  steel: HUE.steel,
};

// --- browser -----------------------------------------------------------------

export type BrowserSessionState =
  "idle" | "loading" | "ready" | "failed" | "detached" | "destroyed" | string;

/**
 * Browser page ActivityMark — session truth only (never agent-seat proxy).
 * - loading/attaching → cyan wave
 * - warm session (ready or detached) → green pulse
 * - failed → crimson wave
 * - cold → silent static
 * Live “who is automating” needs owner + op projection on BrowserSessionInfo.
 * Terminal and failed states beat an in-flight attach: a destroyed or failed
 * session must never keep waving cyan “attaching”.
 */
export function browserActivity(input: {
  readonly state?: BrowserSessionState | null;
  readonly attaching?: boolean;
  /** An operator open/stop/close operation failed — crimson beat, not work. */
  readonly opFailed?: boolean;
}): ActivitySpec {
  if (input.opFailed || input.state === "failed") {
    return {
      mode: "wave",
      tone: SEVERITY_TONE.blocked,
      pattern: "arrow-up",
      label: "failed",
    };
  }
  if (input.state === "destroyed") {
    return { mode: "static", tone: SEVERITY_TONE.idle, glyph: "off", label: "stopped" };
  }
  if (input.attaching || input.state === "loading") {
    return {
      mode: "wave",
      tone: SEVERITY_TONE.working,
      label: input.attaching ? "attaching" : "loading",
    };
  }
  // ready = surface open; detached = warm session without panel — both "running".
  if (input.state === "ready" || input.state === "detached") {
    return { mode: "pulse", tone: "green", glyph: "live", label: "live" };
  }
  return { mode: "static", tone: SEVERITY_TONE.idle, label: "idle" };
}

// --- watcher / timer ---------------------------------------------------------

export type WatcherStatus = "satisfied" | "pending" | "unknown" | string;

/**
 * Relay / gauge card motion.
 * These sensors **fire** on a rising edge — they do not sustain work. A
 * continuous wave/spin implied "busy forever" (wrong). Static for all levels;
 * sparks on edges show the actual fire moment.
 */
export function watcherActivity(
  status: WatcherStatus | null | undefined,
): ActivitySpec {
  if (status === "pending") {
    // Armed, condition not met — quiet wait, not a spinner.
    return { mode: "static", tone: SEVERITY_TONE.idle, label: "armed" };
  }
  if (status === "satisfied") {
    // Condition currently true (edge already consumed or not).
    return { mode: "static", tone: "green", label: "met" };
  }
  return {
    mode: "static",
    tone: SEVERITY_TONE.idle,
    label: status ?? "unknown",
  };
}

/**
 * Cron: wave when due (now >= nextFire). Missing nextFire is settled pending.
 */
export function timerActivity(input: {
  readonly nextFire?: number | null;
  readonly now: number;
}): ActivitySpec {
  if (input.nextFire === undefined || input.nextFire === null) {
    return { mode: "static", tone: SEVERITY_TONE.idle, label: "pending" };
  }
  if (input.now >= input.nextFire) {
    return { mode: "wave", tone: SEVERITY_TONE.attention, label: "due" };
  }
  return { mode: "static", tone: SEVERITY_TONE.idle, label: "scheduled" };
}

export function loadingActivity(
  loading: boolean,
  label = "loading",
): ActivitySpec {
  return loading
    ? { mode: "wave", tone: SEVERITY_TONE.working, label }
    : { mode: "static", tone: SEVERITY_TONE.idle, label: "ready" };
}
