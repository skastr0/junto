/**
 * ActivityMark predicates + house gradient stops.
 *
 * Rule: active work/block → wave (clockwise); ready/complete → pulse;
 * settled → static mark. Visible status labels are forbidden; aria/title
 * carry the word.
 *
 * Severity tones MUST match signal-mark / RTS ladder end-to-end
 * (cards, chips, minimap, command bar):
 *   blocked → crimson · attention → amber · working → cyan
 *   ready/complete → green · parked → violet (signal-mark only) · idle → steel
 * Motion pattern may change across states; the hue for a severity does not.
 */

import type { SpinPattern } from "gradient-spin";
import type { AgentSeatState } from "@shared/agent-seat-state";
import { HUE } from "./theme";

export type ActivityTone = "amber" | "cyan" | "green" | "crimson" | "steel";
/** wave = clockwise trail · pulse = soft breath (complete) · static = settled */
export type ActivityMode = "wave" | "pulse" | "static";
export type ActivitySize = "node" | "inline";

export interface ActivitySpec {
  readonly mode: ActivityMode;
  readonly tone: ActivityTone;
  /** Legacy semantic nuance for wave states; pulse/static ignore pattern. */
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

/** Severity → activity tone. Single map for herdr/chat busy states. */
export const SEVERITY_TONE = {
  blocked: "crimson",
  attention: "amber",
  working: "cyan",
  idle: "steel",
} as const satisfies Record<string, ActivityTone>;

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

export type HerdrAgentStatus =
  "idle" | "working" | "blocked" | "done" | "unknown" | string;
export type HerdrMetaStatus = "idle" | "loading" | "ok" | "error" | string;
export type HerdrConnState =
  "connected" | "degraded" | "lost" | "failed" | "unknown" | string;

/**
 * Herdr agent_status is (AgentState, seen):
 *   Idle+!seen → "done"  (finished turn, waiting for you to look)
 *   Idle+seen  → "idle"  (you've looked; quiet)
 *   Working / Blocked / Unknown map 1:1.
 *
 * Precedence: meta loading (cyan diagonal, first fetch only) → working/blocked
 * → done (green pulse — ready until open marks seen) → connection degraded
 * → lost/failed → idle (static steel — no animation; fleet-safe) → unknown green.
 *
 * Tones follow SEVERITY_TONE (same as chips/minimap). Patterns distinguish
 * states that share a hue (e.g. loading diagonal vs working snake, both cyan).
 * Ready/complete is green pulse — never amber and never the working clockwise.
 */
export function herdrActivity(input: {
  readonly agentStatus?: HerdrAgentStatus | null;
  readonly metaStatus?: HerdrMetaStatus | null;
  readonly connState?: HerdrConnState | null;
}): ActivitySpec {
  // First-hydrate must stay static. A fleet of unbound cards all hit
  // metaStatus:"loading" together — waving every GradientSpin pegs the
  // renderer (~70% CPU idle on an 80-pane board). Working/blocked still wave.
  if (input.metaStatus === "loading") {
    return {
      mode: "static",
      tone: SEVERITY_TONE.working,
      label: "loading meta",
    };
  }
  const agent = input.agentStatus ?? "unknown";
  if (agent === "working") {
    return {
      mode: "wave",
      tone: SEVERITY_TONE.working,
      pattern: "snake",
      label: "working",
    };
  }
  if (agent === "blocked") {
    return {
      mode: "wave",
      tone: SEVERITY_TONE.blocked,
      pattern: "arrow-up",
      label: "blocked",
    };
  }
  // Unseen idle: herdr's "done" = ready/complete. Green pulse until open
  // marks the pane seen (done → idle). Never amber (that's needs-input) and
  // never working-cyan (would lie the agent is still running).
  if (agent === "done") {
    return {
      mode: "pulse",
      tone: "green",
      label: "done — waiting for look",
    };
  }
  if (input.connState === "degraded") {
    return {
      mode: "wave",
      tone: "steel",
      pattern: "diagonal",
      label: "degraded",
    };
  }
  if (
    input.connState === "lost" ||
    input.connState === "failed" ||
    input.metaStatus === "error"
  ) {
    return {
      mode: "static",
      tone: SEVERITY_TONE.blocked,
      label: input.metaStatus === "error" ? "error" : String(input.connState),
    };
  }
  // Seen idle: quiet. Static — never animate every idle card in a fleet.
  if (agent === "idle") {
    return { mode: "static", tone: SEVERITY_TONE.idle, label: "idle" };
  }
  // Quiet healthy card: green static (connected, no agent report).
  if (agent === "unknown" || !agent) {
    return { mode: "static", tone: "green", label: "connected" };
  }
  return { mode: "static", tone: SEVERITY_TONE.idle, label: agent };
}

// --- native terminal / managed seat -----------------------------------------

/**
 * One status grammar for raw native terminals and managed agent terminals.
 * A seat event carries richer intent than process liveness and therefore wins.
 *
 * Pre-ownership spawn failures (`exitReason`) beat the idle "stopped" fallback
 * so a missing harness CLI never looks like a clean stop.
 */
export function terminalActivity(input: {
  readonly seatState?: AgentSeatState | null;
  /**
   * Idle + needsLook → ready/complete (herdr "done"): finished turn, operator
   * has not opened the seat yet. Never a physics state — presentation only.
   */
  readonly needsLook?: boolean;
  /**
   * Latest seat reason (e.g. `turn-stalled`, `prompt-stalled`). Shapes the
   * accessible label only — tone stays amber attention, never cyan working.
   */
  readonly seatReason?: string | null;
  readonly running?: boolean;
  readonly starting?: boolean;
  /**
   * Execution-graph blocked (waiting on upstream request/input, seed, etc.).
   * Seat-local attention still wins — that needs input on *this* seat.
   */
  readonly graphBlocked?: boolean;
  /**
   * Fail-before-ownership reason from TerminalSessionSummary.
   * Absent on true post-run exits (those stay stopped/exited).
   */
  readonly exitReason?: "cli-missing" | "spawn_failed" | null;
  /** Operator-facing copy when exitReason is set (harness display name). */
  readonly exitMessage?: string | null;
}): ActivitySpec {
  if (input.seatState === "attention") {
    const stalled =
      input.seatReason === "turn-stalled" ||
      input.seatReason === "prompt-stalled";
    return {
      mode: "wave",
      tone: SEVERITY_TONE.attention,
      pattern: "ripple",
      // Accessible name only — never chrome text. Stall vs needs-input stay distinct.
      label: stalled
        ? "stalled — needs operator look"
        : "needs operator input",
    };
  }
  // Stoppage cone membership: crimson spinner even when the seat is idle.
  if (input.graphBlocked) {
    return {
      mode: "wave",
      tone: SEVERITY_TONE.blocked,
      pattern: "arrow-up",
      label: "blocked",
    };
  }
  if (input.seatState === "working") {
    return {
      mode: "wave",
      tone: SEVERITY_TONE.working,
      pattern: "snake",
      label: "working",
    };
  }
  if (input.starting) {
    return {
      mode: "wave",
      tone: SEVERITY_TONE.working,
      pattern: "diagonal",
      label: "starting",
    };
  }
  // Ready/complete: idle after work, operator has not looked (herdr done).
  // Green pulse — distinct from attention amber (needs operator input).
  if (input.seatState === "idle" && input.needsLook === true) {
    return {
      mode: "pulse",
      tone: "green",
      label: "ready — waiting for look",
    };
  }
  if (input.seatState === "idle") {
    return { mode: "static", tone: SEVERITY_TONE.idle, label: "idle" };
  }
  if (input.running) {
    return { mode: "static", tone: "green", label: "running" };
  }
  // Missing CLI / spawn fail: amber attention — never steel "stopped".
  if (input.exitReason === "cli-missing") {
    return {
      mode: "static",
      tone: SEVERITY_TONE.attention,
      label:
        input.exitMessage?.trim() ||
        "CLI is not installed on this machine",
    };
  }
  if (input.exitReason === "spawn_failed") {
    return {
      mode: "static",
      tone: SEVERITY_TONE.attention,
      label: input.exitMessage?.trim() || "failed to start",
    };
  }
  return {
    mode: "static",
    tone: SEVERITY_TONE.idle,
    label: input.seatState === "gone" ? "gone" : "stopped",
  };
}

// --- browser -----------------------------------------------------------------

export type BrowserSessionState =
  "idle" | "loading" | "ready" | "failed" | "detached" | "destroyed" | string;

export function browserActivity(input: {
  readonly state?: BrowserSessionState | null;
  readonly attaching?: boolean;
}): ActivitySpec {
  if (input.attaching || input.state === "loading") {
    return {
      mode: "wave",
      tone: SEVERITY_TONE.working,
      label: input.attaching ? "attaching" : "loading",
    };
  }
  if (input.state === "ready") {
    return { mode: "static", tone: "green", label: "ready" };
  }
  if (input.state === "failed") {
    return { mode: "static", tone: SEVERITY_TONE.blocked, label: "failed" };
  }
  if (input.state === "detached") {
    return { mode: "static", tone: SEVERITY_TONE.idle, label: "detached" };
  }
  if (input.state === "destroyed") {
    return { mode: "static", tone: SEVERITY_TONE.idle, label: "destroyed" };
  }
  return { mode: "static", tone: SEVERITY_TONE.idle, label: "idle" };
}

// --- watcher / timer ---------------------------------------------------------

export type WatcherStatus = "satisfied" | "pending" | "unknown" | string;

export function watcherActivity(
  status: WatcherStatus | null | undefined,
): ActivitySpec {
  if (status === "pending") {
    return { mode: "wave", tone: SEVERITY_TONE.attention, label: "pending" };
  }
  if (status === "satisfied") {
    return { mode: "static", tone: "green", label: "satisfied" };
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

// --- hermes / chat -----------------------------------------------------------

export type ChatConnStatus =
  "idle" | "connecting" | "live" | "closed" | "error" | string;
export type ToolStatus =
  "pending" | "in_progress" | "completed" | "failed" | string;

export function chatActivity(input: {
  readonly status?: ChatConnStatus | null;
  readonly pendingPermission?: boolean;
  readonly tools?: ReadonlyArray<{ readonly status: ToolStatus }> | null;
  readonly sending?: boolean;
}): ActivitySpec {
  if (input.status === "connecting") {
    return { mode: "wave", tone: SEVERITY_TONE.working, label: "connecting" };
  }
  // Permission = attention (same amber as herdr done / flag:attention).
  if (input.pendingPermission) {
    return {
      mode: "wave",
      tone: SEVERITY_TONE.attention,
      label: "awaiting permission",
    };
  }
  if (input.sending) {
    return { mode: "wave", tone: SEVERITY_TONE.working, label: "sending" };
  }
  const tools = input.tools ?? [];
  const busyTool = tools.some(
    (t) => t.status === "pending" || t.status === "in_progress",
  );
  if (busyTool) {
    return { mode: "wave", tone: SEVERITY_TONE.working, label: "tool running" };
  }
  if (input.status === "error") {
    return { mode: "static", tone: SEVERITY_TONE.blocked, label: "error" };
  }
  if (input.status === "live") {
    return { mode: "static", tone: "green", label: "live" };
  }
  if (input.status === "closed") {
    return { mode: "static", tone: SEVERITY_TONE.idle, label: "closed" };
  }
  return { mode: "static", tone: SEVERITY_TONE.idle, label: "idle" };
}

export function toolActivity(
  status: ToolStatus | null | undefined,
): ActivitySpec {
  if (status === "pending" || status === "in_progress") {
    return { mode: "wave", tone: SEVERITY_TONE.working, label: status };
  }
  if (status === "completed") {
    return { mode: "static", tone: "green", label: "done" };
  }
  if (status === "failed") {
    return { mode: "static", tone: SEVERITY_TONE.blocked, label: "failed" };
  }
  return {
    mode: "static",
    tone: SEVERITY_TONE.idle,
    label: status ?? "unknown",
  };
}

export function loadingActivity(
  loading: boolean,
  label = "loading",
): ActivitySpec {
  return loading
    ? { mode: "wave", tone: SEVERITY_TONE.working, label }
    : { mode: "static", tone: SEVERITY_TONE.idle, label: "ready" };
}
