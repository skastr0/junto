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

import type { AgentSeatState } from "@shared/agent-seat-state";
import { GREEN, HUE } from "./theme";

export type ActivityTone = "amber" | "cyan" | "green" | "crimson" | "steel";
/** wave = clockwise trail - pulse = soft breath (complete) - static = settled */
export type ActivityMode = "wave" | "pulse" | "static";
/** node = card corner, inline = chips and rows, seat = the ring around a portrait. */
export type ActivitySize = "node" | "inline" | "seat";
/** Legacy motion nuance for wave states; ActivityMark ignores pattern. */
export type ActivityPattern = "arrow-up" | "diagonal" | "snake" | "ripple";

/**
 * What a mark draws, named by meaning; the concept in activity-concepts.ts
 * decides the form.
 * work → something is in flight (loops)
 * call → wants the operator (loops, then rests)
 * halt → blocked or failed (a slow double beat)
 * done → finished: draws itself once, then rests still
 * live → a warm session, quietly present
 * dot  → a settled fact in a tone (met, live chat)
 * rest → idle
 * off  → stopped, gone, unknown
 */
export type ActivityGlyph =
  "work" | "call" | "halt" | "done" | "live" | "dot" | "rest" | "off";

export interface ActivitySpec {
  readonly mode: ActivityMode;
  readonly tone: ActivityTone;
  /** Drawn form; derived from mode and tone when absent. */
  readonly glyph?: ActivityGlyph;
  /** Legacy semantic nuance for wave states; pulse/static ignore pattern. */
  readonly pattern?: ActivityPattern;
  /** Accessible name only — never rendered as chrome text. */
  readonly label: string;
}

export const ACTIVITY_TONE_HEX: Record<ActivityTone, string> = {
  amber: HUE.amber,
  cyan: HUE.cyan,
  green: GREEN,
  crimson: HUE.crimson,
  steel: HUE.steel,
};

/**
 * One mapping from state to drawn form, so every call site that passes only
 * mode and tone (hotbar chips, edge glances) draws the same thing a card does.
 */
export const resolveActivityGlyph = (
  mode: ActivityMode,
  tone: ActivityTone,
  glyph?: ActivityGlyph,
): ActivityGlyph => {
  if (glyph) return glyph;
  if (mode === "wave") {
    if (tone === "amber") return "call";
    if (tone === "crimson") return "halt";
    return "work";
  }
  if (mode === "pulse") return tone === "green" ? "done" : "live";
  if (tone === "crimson") return "halt";
  if (tone === "steel") return "rest";
  return "dot";
};

/** Severity → activity tone. Single map for seat/chat busy states. */
export const SEVERITY_TONE = {
  blocked: "crimson",
  attention: "amber",
  working: "cyan",
  idle: "steel",
} as const satisfies Record<string, ActivityTone>;

// --- native terminal / managed seat -----------------------------------------

/** Shells / idle OSC titles — not "a process the operator cares about". */
const SHELL_BASENAMES = new Set([
  "zsh",
  "bash",
  "sh",
  "fish",
  "csh",
  "tcsh",
  "dash",
  "ksh",
  "pwsh",
  "powershell",
  "login",
  "-zsh",
  "-bash",
]);

/**
 * True when the label names real foreground work (npm, vim, node, …),
 * not an idle shell or a cwd/prompt-style OSC title.
 *
 * Metadata monitors *commands*, not PTY liveness: a seated idle shell is
 * quiet steel, not a green "process running" wave.
 */
export const isActiveProcessLabel = (
  processName: string | null | undefined,
): boolean => {
  const raw = processName?.trim();
  if (!raw) return false;
  // user@host:path or user@host path — common idle shell OSC titles.
  if (/^[^@\s/]+@[^:\s]+[:\s]/.test(raw)) return false;
  // Bare path / home titles (OSC often sets cwd only).
  if (raw === "~" || raw.startsWith("~/") || raw.startsWith("/")) return false;
  // Take last path segment, then first token (e.g. /bin/zsh → zsh, "npm run" → npm).
  const base =
    raw
      .split(/[/\\]/)
      .pop()
      ?.trim()
      .split(/\s+/)[0]
      ?.toLowerCase() ?? "";
  if (!base) return false;
  if (SHELL_BASENAMES.has(base)) return false;
  return true;
};

/**
 * One status grammar for raw native terminals and managed agent terminals.
 * A seat event carries richer intent than bare process liveness and therefore
 * wins for attention / actor working. Green process wave is only for a
 * *non-shell* foreground label — an idle seated PTY is quiet, not "working".
 *
 * Pre-ownership spawn failures (`exitReason`) beat the idle "stopped" fallback
 * so a missing harness CLI never looks like a clean stop. Those errors are
 * crimson status — not graph-blocked (arrow-up / "blocked" label stays reserved).
 */
export function terminalActivity(input: {
  readonly seatState?: AgentSeatState | null;
  /**
   * Idle + needsLook → ready/complete: finished turn, operator
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
  /**
   * Best-effort foreground label (OSC title / argv). Shell names and
   * user@host:path titles do not count as active process work.
   */
  readonly processName?: string | null;
  /**
   * Managed harness seat. Missing/unknown state must stay seated/unknown —
   * never a process-name green wave (grok/claude). Unmanaged npm stays a wave.
   */
  readonly managedSeat?: boolean;
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
  // Actor harness turn — cyan snake (distinct from green process wave below).
  if (input.seatState === "working") {
    return {
      mode: "wave",
      tone: SEVERITY_TONE.working,
      pattern: "snake",
      label: "working",
    };
  }
  const processLabel = input.processName?.trim() || undefined;
  const activeProcess = isActiveProcessLabel(processLabel);
  // Spawn in flight — green diagonal for unmanaged only. Managed start is
  // seated/unknown, never a grok/claude process-wave.
  if (input.starting && !input.managedSeat) {
    return {
      mode: "wave",
      tone: "green",
      pattern: "diagonal",
      label: activeProcess && processLabel
        ? `starting — ${processLabel}`
        : "starting process",
    };
  }
  // Real foreground work only — not shell/PTY liveness (zsh, user@host:cwd, …).
  // Green process wave is unmanaged-only. A managed seat with no event yet
  // still runs grok/claude as the process name; that is seated, not "working".
  if (
    !input.managedSeat &&
    (input.seatState === undefined || input.seatState === null) &&
    input.running &&
    activeProcess &&
    processLabel
  ) {
    return {
      mode: "wave",
      tone: "green",
      pattern: "ripple",
      label: `process — ${processLabel}`,
    };
  }
  // Ready/complete: idle after work, operator has not looked.
  // Green pulse — distinct from attention amber (needs operator input).
  if (input.seatState === "idle" && input.needsLook === true) {
    return {
      mode: "pulse",
      tone: "green",
      label: "Ready — waiting for review",
    };
  }
  if (input.seatState === "idle") {
    return { mode: "static", tone: SEVERITY_TONE.idle, label: "idle" };
  }
  // Spawn / CLI failures: crimson error status — not graph-blocked.
  if (input.exitReason === "cli-missing") {
    return {
      mode: "wave",
      tone: "crimson",
      pattern: "diagonal",
      label:
        input.exitMessage?.trim() ||
        "CLI is not installed on this machine",
    };
  }
  if (input.exitReason === "spawn_failed") {
    return {
      mode: "wave",
      tone: "crimson",
      pattern: "diagonal",
      label: input.exitMessage?.trim() || "failed to start",
    };
  }
  // Live PTY with no agent seat and no active command — seated, not "working".
  if (input.running) {
    return { mode: "static", tone: SEVERITY_TONE.idle, label: "seated" };
  }
  if (
    input.managedSeat &&
    (input.seatState === "unknown" ||
      input.seatState === undefined ||
      input.seatState === null)
  ) {
    return { mode: "static", tone: SEVERITY_TONE.idle, glyph: "off", label: "unknown" };
  }
  return {
    mode: "static",
    tone: SEVERITY_TONE.idle,
    glyph: "off",
    label: input.seatState === "gone" ? "gone" : "stopped",
  };
}

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
  // Permission = attention (amber needs-input — not ready/complete green pulse).
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
    return { mode: "static", tone: "green", glyph: "done", label: "done" };
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
