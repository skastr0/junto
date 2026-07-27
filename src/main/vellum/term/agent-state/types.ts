/**
 * Internal rule-pack types for the agent seat state engine.
 * Patterns are rewritten from probe captures + herdr design notes — not vendored.
 */

import type { AgentSeatState } from "../../../../shared/agent-seat-state";
import type { HarnessId } from "../../../../shared/managed-terminal-templates";

/** Regions available to rule packs (observer signal + grid slices). */
export type SeatRuleRegion =
  | "osc_title"
  | "osc9"
  | "whole_recent"
  | "bottom_non_empty_lines"
  | "footer_line"
  | "after_last_horizontal_rule"
  | "prompt_box_body"
  | "above_prompt_box";

/**
 * Nested gate tree. All positive arms AND; `any` is OR of children;
 * `not` fails the gate if any child matches.
 */
export type SeatMatcher = {
  /** Case-insensitive substrings; all must appear in region text. */
  readonly contains?: readonly string[];
  /** RegExp source strings; all must match region text. */
  readonly regex?: readonly string[];
  /** Each pattern must match at least one line of the region. */
  readonly lineRegex?: readonly string[];
  readonly all?: readonly SeatMatcher[];
  readonly any?: readonly SeatMatcher[];
  readonly not?: readonly SeatMatcher[];
};

export type SeatRule = {
  readonly id: string;
  readonly state: AgentSeatState;
  readonly priority: number;
  readonly region: SeatRuleRegion;
  /** For `bottom_non_empty_lines` (default 5). */
  readonly regionN?: number;
  readonly matchers: SeatMatcher;
  /** Live on-screen idle chrome (prompt box) — bypasses working→idle debounce. */
  readonly visibleIdle?: boolean;
  readonly visibleWorking?: boolean;
  /** Permission / form chrome — never publish idle while this is true. */
  readonly visibleAttention?: boolean;
  /**
   * Viewer / menu overlay: hold prior seat state (do not treat as unknown).
   * Only legal with state "unknown".
   */
  readonly skipStateUpdate?: boolean;
};

export type SeatRulePack = {
  readonly harness: HarnessId;
  readonly version: string;
  readonly rules: readonly SeatRule[];
};

export type SeatEvaluation = {
  readonly state: AgentSeatState;
  readonly reason: string;
  readonly priority: number;
  readonly confidence: "high" | "low";
  readonly visibleIdle: boolean;
  readonly visibleWorking: boolean;
  readonly visibleAttention: boolean;
  readonly skipStateUpdate: boolean;
  readonly ruleId: string | null;
  readonly harness: HarnessId;
};
