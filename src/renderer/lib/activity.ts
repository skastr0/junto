/**
 * ActivityMark predicates + house gradient stops.
 *
 * Rule: active (working | waiting) → wave; settled → static mark.
 * Visible status labels are forbidden; aria/title carry the word.
 */

import type { SpinPattern } from "gradient-spin";
import { HUE } from "./theme";

export type ActivityTone = "amber" | "cyan" | "green" | "crimson" | "steel";
export type ActivityMode = "wave" | "static";
export type ActivitySize = "node" | "inline";

export interface ActivitySpec {
  readonly mode: ActivityMode;
  readonly tone: ActivityTone;
  /** Wavefront shape when mode is "wave" (gradient-spin). Default at the mark: "snake". */
  readonly pattern?: SpinPattern;
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

/** Near-black house ground — used as the dim end of monochrome ramps. */
const GROUND_HEX = "#0c0b0a";

/**
 * Linear mix of two #rrggbb colors. gradient-spin's OKLab sampler only accepts
 * hex (hexToOklab) — rgba stops become NaN cell fills.
 */
export function mixHex(a: string, b: string, t: number): string {
  const parse = (hex: string): [number, number, number] => {
    const clean = hex.replace("#", "");
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16),
    ];
  };
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const to = (n: number) => clamp(n).toString(16).padStart(2, "0");
  const r = ar + (br - ar) * t;
  const g = ag + (bg - ag) * t;
  const bl = ab + (bb - ab) * t;
  return `#${to(r)}${to(g)}${to(bl)}`;
}

/** Monochrome (or amber→cyan tip) hex stops for gradient-spin. */
export function houseGradientStops(
  tone: ActivityTone,
  opts?: { readonly cyanTip?: boolean },
): ReadonlyArray<{ readonly color: string; readonly position: number }> {
  const hex = ACTIVITY_TONE_HEX[tone];
  if (opts?.cyanTip && tone === "amber") {
    return [
      { color: mixHex(GROUND_HEX, hex, 0.22), position: 0 },
      { color: hex, position: 0.55 },
      { color: mixHex(hex, HUE.cyan, 0.65), position: 1 },
    ];
  }
  return [
    { color: mixHex(GROUND_HEX, hex, 0.2), position: 0 },
    { color: hex, position: 0.5 },
    { color: mixHex(hex, "#ffffff", 0.12), position: 1 },
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
 * Herdr agent_status is (AgentState, seen):
 *   Idle+!seen → "done"  (finished turn, waiting for you to look)
 *   Idle+seen  → "idle"  (you've looked; quiet)
 *   Working / Blocked / Unknown map 1:1.
 *
 * Precedence: meta loading (cyan diagonal, first fetch only) → working/blocked
 * → done (amber ripple — attention until open marks seen) → connection degraded
 * → lost/failed → idle (static steel — no animation; fleet-safe) → unknown green.
 * Each wave state owns a distinct (tone, pattern) pair so states read apart
 * by shape, not just color.
 */
export function herdrActivity(input: {
  readonly agentStatus?: HerdrAgentStatus | null;
  readonly metaStatus?: HerdrMetaStatus | null;
  readonly connState?: HerdrConnState | null;
}): ActivitySpec {
  if (input.metaStatus === "loading") {
    return { mode: "wave", tone: "cyan", pattern: "diagonal", label: "loading meta" };
  }
  const agent = input.agentStatus ?? "unknown";
  if (agent === "working") {
    return { mode: "wave", tone: "amber", pattern: "snake", label: "working" };
  }
  if (agent === "blocked") {
    return { mode: "wave", tone: "crimson", pattern: "arrow-up", label: "blocked" };
  }
  // Unseen idle: herdr's "done" = waiting for the operator to look. Wave until
  // open marks the pane seen (done → idle). Must not be static green — that
  // read as "settled" and never cleared when focus propagation was missing.
  if (agent === "done") {
    return { mode: "wave", tone: "amber", pattern: "ripple", label: "done — waiting for look" };
  }
  if (input.connState === "degraded") {
    return { mode: "wave", tone: "steel", pattern: "diagonal", label: "degraded" };
  }
  if (input.connState === "lost" || input.connState === "failed" || input.metaStatus === "error") {
    return { mode: "static", tone: "crimson", label: input.metaStatus === "error" ? "error" : String(input.connState) };
  }
  // Seen idle: quiet. Static — never animate every idle card in a fleet.
  if (agent === "idle") {
    return { mode: "static", tone: "steel", label: "idle" };
  }
  // Quiet healthy card: green static (connected, no agent report).
  if (agent === "unknown" || !agent) {
    return { mode: "static", tone: "green", label: "connected" };
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

/**
 * Timer: wave when due (now >= nextFire). Missing nextFire is settled pending
 * (static), not "actively pulsing."
 */
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
