/**
 * Pure seat-state evaluation: hooks → OSC/grid rules (rank per harness).
 * No timers — debounce lives in SeatStateMachine.
 */

import type {
  AgentSeatHookState,
  AgentSeatState,
} from "../../../../shared/agent-seat-state";
import type { HarnessId } from "../../../../shared/managed-terminal-templates";
import { isHarnessId } from "../../../../shared/managed-terminal-templates";
import type { ObserverGridSnapshot } from "../observer/types";
import { ruleMatches } from "./match";
import { rulePackFor } from "./rules";
import type { SeatEvaluation, SeatRule, SeatRulePack } from "./types";

export type EvaluateOptions = {
  readonly harness: HarnessId | string;
  /** Optional hook / events.jsonl feed. */
  readonly hookState?: AgentSeatHookState | null;
  /** Override pack (tests). */
  readonly pack?: SeatRulePack;
  readonly now?: number;
};

const FALLBACK_IDLE_REASON = "default_known_agent_idle_fallback";
const UNKNOWN_HARNESS_REASON = "unknown_harness";
const HOOK_REASON_PREFIX = "hook:";

/** Feed rank: hooks win for claude/grok/hermes; codex is OSC→grid only. */
const HOOK_AUTHORITATIVE: ReadonlySet<HarnessId> = new Set([
  "claude",
  "grok",
  "hermes",
]);

const sortedRules = (pack: SeatRulePack): SeatRule[] =>
  [...pack.rules].sort((a, b) => b.priority - a.priority);

const flagsFor = (
  rule: SeatRule | null,
  state: AgentSeatState,
): Pick<
  SeatEvaluation,
  "visibleIdle" | "visibleWorking" | "visibleAttention" | "skipStateUpdate"
> => {
  if (!rule) {
    return {
      visibleIdle: false,
      visibleWorking: false,
      visibleAttention: false,
      skipStateUpdate: false,
    };
  }
  return {
    visibleIdle: Boolean(rule.visibleIdle && state === "idle"),
    visibleWorking: Boolean(rule.visibleWorking && state === "working"),
    visibleAttention: Boolean(
      rule.visibleAttention && state === "attention",
    ),
    skipStateUpdate: Boolean(rule.skipStateUpdate),
  };
};

const evaluationFromRule = (
  rule: SeatRule,
  pack: SeatRulePack,
): SeatEvaluation => {
  const state = rule.state;
  const flags = flagsFor(rule, state);
  const confidence: "high" | "low" =
    flags.visibleIdle ||
    flags.visibleWorking ||
    flags.visibleAttention ||
    rule.skipStateUpdate
      ? "high"
      : state === "attention" || state === "working"
        ? "high"
        : "low";
  return {
    state,
    reason: `rule:${rule.id}`,
    priority: rule.priority,
    confidence,
    ...flags,
    ruleId: rule.id,
    harness: pack.harness,
  };
};

const evaluateScreen = (
  snapshot: ObserverGridSnapshot,
  pack: SeatRulePack,
): SeatEvaluation => {
  const rules = sortedRules(pack);
  for (const rule of rules) {
    if (!ruleMatches(rule, snapshot)) continue;
    return evaluationFromRule(rule, pack);
  }
  // Known harness, no rule → low-confidence idle (debounce keys on this).
  return {
    state: "idle",
    reason: FALLBACK_IDLE_REASON,
    priority: 0,
    confidence: "low",
    visibleIdle: false,
    visibleWorking: false,
    visibleAttention: false,
    skipStateUpdate: false,
    ruleId: null,
    harness: pack.harness,
  };
};

/** Highest-priority attention match, if any (used as safety net over working title). */
const findMatchingAttention = (
  snapshot: ObserverGridSnapshot,
  pack: SeatRulePack,
): SeatEvaluation | null => {
  const rules = sortedRules(pack);
  for (const rule of rules) {
    if (rule.state !== "attention") continue;
    if (!ruleMatches(rule, snapshot)) continue;
    return evaluationFromRule(rule, pack);
  }
  return null;
};

/**
 * Evaluate a grid snapshot (+ optional hook) into a seat state.
 * Pure; no debounce.
 */
export const evaluate = (
  snapshot: ObserverGridSnapshot,
  opts: EvaluateOptions,
): SeatEvaluation => {
  const harnessRaw = opts.harness;
  if (!isHarnessId(harnessRaw) && !opts.pack) {
    return {
      state: "unknown",
      reason: UNKNOWN_HARNESS_REASON,
      priority: 0,
      confidence: "low",
      visibleIdle: false,
      visibleWorking: false,
      visibleAttention: false,
      skipStateUpdate: false,
      ruleId: null,
      harness: "claude", // placeholder; caller should not trust harness on unknown
    };
  }

  const pack =
    opts.pack ?? rulePackFor(harnessRaw as HarnessId);
  const screen = evaluateScreen(snapshot, pack);

  // skip_state_update: hold prior — caller must apply; we still return the flag.
  // Screen attention always surfaces (permission chrome must never be idle/working).
  if (screen.visibleAttention || screen.state === "attention") {
    return screen;
  }

  const hook = opts.hookState;
  const hooksWin =
    hook != null &&
    HOOK_AUTHORITATIVE.has(pack.harness) &&
    // Codex never takes hooks for state (plan §9: OSC → grid).
    pack.harness !== "codex";

  if (hooksWin && hook) {
    // Full-lifecycle hooks own the seat.
    if (hook.fullLifecycle) {
      return hookEvaluation(hook, pack.harness, 10_000);
    }
    // Non-full lifecycle. Resolution order (deterministic protocol first):
    // 1. Agreement law (OBS-8): a deterministic protocol idle (OSC 9;4;0)
    //    wins when the screen is ALSO idle — the protocol reason outranks a
    //    stale or weaker screen rule.
    if (hook.state === "idle" && screen.state === "idle") {
      return hookEvaluation(hook, pack.harness, 5_000);
    }
    // 2. Contradiction law (real-working vs stale-title): the deterministic
    //    OSC 9 flag resolves the ambiguity that a single snapshot cannot —
    //    a working hook (OSC 9;4;3) beats a PROMPT-BOX idle (Claude keeps an
    //    empty composer on screen while genuinely working: braille title +
    //    4;3 + empty `❯`), while an idle hook (4;0) beats a stale working
    //    title (braille + 4;0 = turn ended, title not repainted).
    //    EXCEPTION: a composer DRAFT/chip idle (our own unsubmitted paste in
    //    the box) stays idle — the chip is composer chrome, not working.
    if (
      screen.state === "idle" &&
      screen.confidence === "high" &&
      screen.visibleIdle
    ) {
      if (hook.state === "working" && screen.reason !== "rule:composer_draft_idle") {
        return hookEvaluation(hook, pack.harness, 5_000);
      }
      return screen;
    }
    if (hook.state === "idle" && screen.state === "working") {
      return hookEvaluation(hook, pack.harness, 5_000);
    }
    // 3. Low-confidence screen (fallback / unmatched chrome): hook carries
    //    the seat (any state).
    if (
      screen.confidence === "low" ||
      screen.reason === FALLBACK_IDLE_REASON
    ) {
      return hookEvaluation(hook, pack.harness, 5_000);
    }
    // 4. Screen working (with hook working or agreeing): keep the rule
    //    reason — the grid is the stronger evidence here.
    return screen;
  }

  // Safety net: if any attention rule matches (even below a working title hit),
  // force attention. Typing into a dialog is the failure mode this guards.
  // Runs AFTER hooks so a deterministic protocol idle (OSC 9;4;0) can outvote
  // a stale whole_recent attention match (OBS-8).
  const attentionHit = findMatchingAttention(snapshot, pack);
  if (attentionHit) {
    return attentionHit;
  }

  return screen;
};

const hookEvaluation = (
  hook: AgentSeatHookState,
  harness: HarnessId,
  priority: number,
): SeatEvaluation => ({
  state: hook.state,
  reason: `${HOOK_REASON_PREFIX}${hook.reason}`,
  priority,
  confidence: "high",
  visibleIdle: hook.state === "idle",
  visibleWorking: hook.state === "working",
  visibleAttention: hook.state === "attention",
  skipStateUpdate: false,
  ruleId: null,
  harness,
});

export const FALLBACK_IDLE = FALLBACK_IDLE_REASON;
