/**
 * Internal rule-pack types for the agent seat state engine.
 * Patterns are rewritten from probe captures — not vendored.
 */

import type { AgentSeatState } from "../../../../shared/agent-seat-state";
import type {
  Fidelity,
  HarnessSignal,
  SeatSignal,
  SignalSource,
} from "../../../../shared/harness-domain";
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
  | "above_prompt_box"
  | "from_last_arrow";

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

/**
 * The signal a rule emits when it matches: the tag and any constant fields.
 * Named groups in the rule's regex and lineRegex matchers fill the field of
 * the same name, e.g. `resets (?<resetsAt>.+)` on a `UsageLimitHit`. A
 * capture that does not read as its field (an unparseable time) is left out;
 * the constant fields always hold. Without one, the rule emits the signal its
 * state stands for (see screen-signal.ts).
 */
export type SeatRuleSignal = HarnessSignal extends infer S
  ? S extends { readonly _tag: infer T }
    ? { readonly _tag: T } & Partial<Omit<S, "_tag">>
    : never
  : never;

export type SeatRule = {
  readonly id: string;
  readonly state: AgentSeatState;
  readonly priority: number;
  readonly region: SeatRuleRegion;
  /** For `bottom_non_empty_lines` (default 5). */
  readonly regionN?: number;
  readonly matchers: SeatMatcher;
  /**
   * Positive matchers read `prompt_box_body` with its faint (SGR 2) cells
   * blanked: a hint or a suggested prompt the harness paints faint is not
   * text in the box. `not` arms still read the box as painted, so faint
   * dialog hints still veto. Other regions, and a snapshot read without cell
   * attributes, are read as painted.
   */
  readonly withoutFaint?: boolean;
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
  /** What the match means in the seat signal vocabulary; it must project to `state`. */
  readonly signal?: SeatRuleSignal;
};

/**
 * A fact the screen shows that changes no status: an error the turn ended
 * on, a context or quota level. Every fact rule that matches is read on each
 * frame, beside the one state rule that wins, and a fact is folded once,
 * when it appears. Its signal must leave any status as it was (the pack
 * tests hold this), so facts never compete with the state rules.
 */
export type SeatFactRule = {
  readonly id: string;
  readonly region: SeatRuleRegion;
  /** For `bottom_non_empty_lines` (default 5). */
  readonly regionN?: number;
  readonly matchers: SeatMatcher;
  readonly signal: SeatRuleSignal;
};

/**
 * What the screen proves about the seat's composer (the harness's input box).
 * "empty" — the box is visibly empty (bare glyph or the harness's known
 * placeholder hint); the only state in which a factory paste may land.
 * "draft" — visible unsubmitted text sits in the box (operator draft or an
 * unsubmitted paste chip); typing would append to it and CR would submit it.
 * null — no probe matched: a dialog covers the box, the screen is
 * mid-transition, or this harness has no grounded probes yet. Fail closed —
 * an unreadable composer is never a writable one.
 */
export type ComposerVerdict = "empty" | "draft" | null;

/**
 * One screen probe for the composer question. Probes are evaluated in
 * declared order and the FIRST match wins, so each pack encodes its own
 * precedence (a pack whose empty-glyph literal can also appear in scrollback
 * declares its draft probe first; a pack with precise whole-box empties
 * declares those first and a catch-all draft last).
 */
export type ComposerProbe = {
  readonly id: string;
  readonly verdict: "empty" | "draft";
  readonly region: SeatRuleRegion;
  /** For `bottom_non_empty_lines` (default 5). */
  readonly regionN?: number;
  readonly matchers: SeatMatcher;
  /** As on SeatRule. */
  readonly withoutFaint?: boolean;
};

export type SeatRulePack = {
  readonly harness: HarnessId;
  readonly version: string;
  readonly rules: readonly SeatRule[];
  /**
   * Composer probes — the screen-truth source for "may the factory type
   * here?". A pack without probes cannot prove an empty composer, so factory
   * typing into its seats refuses (fail closed) until its real chrome is
   * captured and encoded.
   */
  readonly composer?: readonly ComposerProbe[];
  /** Facts beside the state; see SeatFactRule. */
  readonly facts?: readonly SeatFactRule[];
  /**
   * Draft evidence the composer probes cannot see, read from the whole screen
   * (Codex expands a multiline paste past its bottom probes). It only ever
   * answers "draft": it gives no empty-composer or idle authority.
   */
  readonly composerDraft?: (lines: readonly string[]) => boolean;
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
  /**
   * The fact behind the state, in the seat signal vocabulary. Null when the
   * evaluation holds the prior state (skipStateUpdate).
   */
  readonly signal: SeatSignal | null;
  /** Where the fact was read: a screen rule, OSC 9;4 progress, a reporter. */
  readonly source: SignalSource;
  readonly fidelity: Fidelity;
  /** Facts the screen shows this frame (SeatFactRule), read off the screen. */
  readonly facts?: readonly SeatSignal[];
};
