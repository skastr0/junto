/**
 * Seat activity grammar: the state a seat's ring draws, as mode, tone and
 * glyph. Shared so the desktop and the phone resolve one seat the same way;
 * the renderer re-exports it from lib/activity.ts.
 *
 * Severity tones MUST match signal-mark / RTS ladder end-to-end:
 *   blocked → crimson - attention → amber - working → cyan
 *   ready/complete → green - idle → steel
 */

import type { AgentSeatState } from "./agent-seat-state";
import type { ActivityGlyph, ActivityTone } from "./rings";

/** wave = clockwise trail - pulse = soft breath (complete) - static = settled */
export type ActivityMode = "wave" | "pulse" | "static";
/** Legacy motion nuance for wave states; ActivityMark ignores pattern. */
export type ActivityPattern = "arrow-up" | "diagonal" | "snake" | "ripple";

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
    // No seat event and no live process: the seat is not running. Say so,
    // never "unknown", and never "offline": that is a machine's word.
    return { mode: "static", tone: SEVERITY_TONE.idle, glyph: "off", label: "not running" };
  }
  return {
    mode: "static",
    tone: SEVERITY_TONE.idle,
    glyph: "off",
    label: input.seatState === "gone" ? "gone" : "stopped",
  };
}
