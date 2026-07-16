/**
 * ActivityMark predicates + house gradient stops.
 *
 * Rule: active (working | waiting) → wave; settled → static mark.
 * Visible status labels are forbidden; aria/title carry the word.
 */

import { HUE, withAlpha } from "./theme";

export type ActivityTone = "amber" | "cyan" | "green" | "crimson" | "steel";
export type ActivityMode = "wave" | "static";
export type ActivitySize = "node" | "inline";

export interface ActivitySpec {
  readonly mode: ActivityMode;
  readonly tone: ActivityTone;
  /** Accessible name only — never rendered as chrome text. */
  readonly label: string;
}

export const ACTIVITY_TONE_HEX: Record<ActivityTone, string> = {
  amber: HUE.amber,
  cyan: HUE.cyan,
  green: "#5FB98E",
  crimson: HUE.crimson,
  steel: HUE.steel,
};

/** Monochrome (or amber→cyan tip) OKLab stops for gradient-spin. */
export function houseGradientStops(
  tone: ActivityTone,
  opts?: { readonly cyanTip?: boolean },
): ReadonlyArray<{ readonly color: string; readonly position: number }> {
  const hex = ACTIVITY_TONE_HEX[tone];
  if (opts?.cyanTip && tone === "amber") {
    return [
      { color: withAlpha(hex, 0.18), position: 0 },
      { color: hex, position: 0.55 },
      { color: withAlpha(HUE.cyan, 0.9), position: 1 },
    ];
  }
  return [
    { color: withAlpha(hex, 0.16), position: 0 },
    { color: hex, position: 0.5 },
    { color: withAlpha(hex, 0.85), position: 1 },
  ];
}

// --- herdr -------------------------------------------------------------------

export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown" | string;
export type HerdrMetaStatus = "idle" | "loading" | "ok" | "error" | string;
export type HerdrConnState =
  | "connected"
  | "degraded"
  | "lost"
  | "failed"
  | "unknown"
  | string;

/**
 * Precedence: meta loading (cyan wave) → agent working/blocked (amber/crimson wave)
 * → connection degraded (amber wave) → settled static.
 */
export function herdrActivity(input: {
  readonly agentStatus?: HerdrAgentStatus | null;
  readonly metaStatus?: HerdrMetaStatus | null;
  readonly connState?: HerdrConnState | null;
}): ActivitySpec {
  if (input.metaStatus === "loading") {
    return { mode: "wave", tone: "cyan", label: "loading meta" };
  }
  const agent = input.agentStatus ?? "unknown";
  if (agent === "working") {
    return { mode: "wave", tone: "amber", label: "working" };
  }
  if (agent === "blocked") {
    return { mode: "wave", tone: "crimson", label: "blocked" };
  }
  if (input.connState === "degraded") {
    return { mode: "wave", tone: "amber", label: "degraded" };
  }
  if (agent === "done") {
    return { mode: "static", tone: "green", label: "done" };
  }
  if (input.connState === "lost" || input.connState === "failed" || input.metaStatus === "error") {
    return { mode: "static", tone: "crimson", label: input.metaStatus === "error" ? "error" : String(input.connState) };
  }
  // Quiet healthy card: green static (connected + idle/unknown).
  if (agent === "idle" || agent === "unknown" || !agent) {
    return { mode: "static", tone: "green", label: agent === "idle" ? "idle" : "connected" };
  }
  return { mode: "static", tone: "steel", label: agent };
}

// --- browser -----------------------------------------------------------------

export type BrowserSessionState =
  | "idle"
  | "loading"
  | "ready"
  | "failed"
  | "detached"
  | "destroyed"
  | string;

export function browserActivity(input: {
  readonly state?: BrowserSessionState | null;
  readonly attaching?: boolean;
}): ActivitySpec {
  if (input.attaching || input.state === "loading") {
    return { mode: "wave", tone: "amber", label: input.attaching ? "attaching" : "loading" };
  }
  if (input.state === "ready") {
    return { mode: "static", tone: "green", label: "ready" };
  }
  if (input.state === "failed") {
    return { mode: "static", tone: "crimson", label: "failed" };
  }
  if (input.state === "detached") {
    return { mode: "static", tone: "steel", label: "detached" };
  }
  if (input.state === "destroyed") {
    return { mode: "static", tone: "steel", label: "destroyed" };
  }
  return { mode: "static", tone: "steel", label: "idle" };
}

// --- watcher / timer ---------------------------------------------------------

export type WatcherStatus = "satisfied" | "pending" | "unknown" | string;

export function watcherActivity(status: WatcherStatus | null | undefined): ActivitySpec {
  if (status === "pending") {
    return { mode: "wave", tone: "amber", label: "pending" };
  }
  if (status === "satisfied") {
    return { mode: "static", tone: "green", label: "satisfied" };
  }
  return { mode: "static", tone: "steel", label: status ?? "unknown" };
}

/** Timer is due (or mid-pulse) when nextFire is missing after being set, or now >= nextFire. */
export function timerActivity(input: {
  readonly nextFire?: number | null;
  readonly now: number;
}): ActivitySpec {
  if (input.nextFire === undefined || input.nextFire === null) {
    return { mode: "static", tone: "steel", label: "pending" };
  }
  if (input.now >= input.nextFire) {
    return { mode: "wave", tone: "amber", label: "pulsing" };
  }
  return { mode: "static", tone: "steel", label: "scheduled" };
}

// --- hermes / chat -----------------------------------------------------------

export type ChatConnStatus = "idle" | "connecting" | "live" | "closed" | "error" | string;
export type ToolStatus = "pending" | "in_progress" | "completed" | "failed" | string;

export function chatActivity(input: {
  readonly status?: ChatConnStatus | null;
  readonly pendingPermission?: boolean;
  readonly tools?: ReadonlyArray<{ readonly status: ToolStatus }> | null;
  readonly sending?: boolean;
}): ActivitySpec {
  if (input.status === "connecting") {
    return { mode: "wave", tone: "amber", label: "connecting" };
  }
  if (input.pendingPermission) {
    return { mode: "wave", tone: "amber", label: "awaiting permission" };
  }
  if (input.sending) {
    return { mode: "wave", tone: "amber", label: "sending" };
  }
  const tools = input.tools ?? [];
  const busyTool = tools.some((t) => t.status === "pending" || t.status === "in_progress");
  if (busyTool) {
    return { mode: "wave", tone: "amber", label: "tool running" };
  }
  if (input.status === "error") {
    return { mode: "static", tone: "crimson", label: "error" };
  }
  if (input.status === "live") {
    return { mode: "static", tone: "green", label: "live" };
  }
  if (input.status === "closed") {
    return { mode: "static", tone: "steel", label: "closed" };
  }
  return { mode: "static", tone: "steel", label: "idle" };
}

export function toolActivity(status: ToolStatus | null | undefined): ActivitySpec {
  if (status === "pending" || status === "in_progress") {
    return { mode: "wave", tone: "amber", label: status };
  }
  if (status === "completed") {
    return { mode: "static", tone: "green", label: "done" };
  }
  if (status === "failed") {
    return { mode: "static", tone: "crimson", label: "failed" };
  }
  return { mode: "static", tone: "steel", label: status ?? "unknown" };
}

export function loadingActivity(loading: boolean, label = "loading"): ActivitySpec {
  return loading
    ? { mode: "wave", tone: "cyan", label }
    : { mode: "static", tone: "steel", label: "ready" };
}
