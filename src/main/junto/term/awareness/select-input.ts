/**
 * Awareness evidence projection — grid window to id-tagged bounded request.
 *
 * WHAT THIS DOES
 * --------------
 * Turns one bottom-anchored window of a managed terminal's headless grid into
 * the exact request state the awareness sidecar sends to the model:
 *
 *   - candidate lines are capped (128), then composer chrome and drafts are
 *     excluded, then known injected prompt bodies are excluded, then the text
 *     is redacted, then the evidence is capped by bytes, then the survivors are
 *     tagged `L000| text`;
 *   - a separate total serialized-request cap can then squeeze the request, and
 *     when it does the drop is reported, never silent;
 *   - the projection certifies what evidence it has (including whether a
 *     temporal comparison is even possible) so a question is never asked with
 *     the evidence missing.
 *
 * HONESTY RULES
 * -------------
 *   - Every drop is counted: candidate lines, byte-cap lines and bytes,
 *     request-cap lines, composer lines, injected-prompt lines, dropped
 *     questions, and whether a single line had to be clipped mid-text.
 *   - `windowTruncated` and `windowTotalLines` come from the observer, so a
 *     window that was itself clipped by the retained grid says so.
 *   - Redaction removes the secret and path shapes this module knows. It is NOT
 *     a confidentiality guarantee, and the report says exactly that.
 *   - The projection is pure and deterministic: same window and options in,
 *     same bytes and same window digest out.
 *
 * WINDOW DIGEST (shared with the scheduler and the renderer)
 * ---------------------------------------------------------
 * `computeWindowDigest` is a COARSE MATERIAL SCREEN REVISION over the bounded,
 * redacted evidence, after normalizing volatile chrome (spinner and animation
 * frames, elapsed-time and token counters, cursor position, byte and sequence
 * counters, and repaints that leave the visible text identical). It is exported
 * as the single normalization the scheduler's cache key and the renderer's
 * staleness comparison both call: two normalizations that disagree is the bug
 * this exists to prevent.
 *
 * It is deliberately NOT a per-burst value. A seat printing continuously must
 * not churn its digest on every burst, or a fresh judgment would read as stale
 * within seconds on exactly the seats that work. So the digest excludes the PTY
 * sequence and the wall clock, and includes the observation identity (binding
 * and generation) so an answer from a retired epoch is never mistaken for one
 * from the live session.
 *
 * Normalization is LINE-PRESERVING: it rewrites lines, never adds, removes, or
 * reorders them. Two cuts that share a digest therefore have the same line
 * count, so a line id resolves to the same position in either mapping and the
 * only textual difference between them is volatile chrome.
 *
 * AUTHORITY
 * ---------
 * Read-only. This module imports grid predicates and a type from the observer
 * and nothing from the seat state engine, the drive, IPC, or the renderer. It
 * returns a value; it sets no flag, marks no seat, and authors no canvas state.
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/work-canonical-json";
import { isHorizontalRule } from "../observer/regions";
import type { ObserverGridWindow } from "../observer/types";
import {
  AWARENESS_PACK_VERSION,
  AWARENESS_QUESTIONS,
  MAX_EVIDENCE_BYTES,
  MAX_EVIDENCE_CANDIDATE_LINES,
  MAX_REQUEST_BYTES,
  acceptanceThresholdsFor,
  formatEvidenceLineId,
  isQuestionAskable,
  permittedOptionIds,
  renderQuestionPrompt,
  type AcceptanceThresholds,
  type EvidenceRequirement,
} from "./questions";

// ---------------------------------------------------------------------------
// Window input
// ---------------------------------------------------------------------------

/**
 * One observation to project. `window` is exactly what the observer's
 * `readWindow` returns (production-shaped), plus the wall clock at read time.
 */
export type AwarenessEvidenceWindow = ObserverGridWindow & {
  /** Wall-clock ms when the window was read. */
  readonly observedAt: number;
};

export type SelectAwarenessInputOptions = {
  /**
   * Substrings whose lines are known injected prompt bodies for this seat (the
   * bootstrap marker token `[vc-…]` from `buildBootstrapMarker`, and the head
   * of a payload this app pasted). Only substrings the caller can ground: an
   * ungrounded guess would silently drop real evidence.
   */
  readonly injectedPromptNeedles?: readonly string[];
  /** Override the caps. Tests use this; production uses the pack constants. */
  readonly caps?: {
    readonly candidateLines?: number;
    readonly evidenceBytes?: number;
    readonly requestBytes?: number;
  };
  readonly packVersion?: string;
};

// ---------------------------------------------------------------------------
// Evidence shapes
// ---------------------------------------------------------------------------

export type EvidenceLine = {
  /** `L000`…, scoped to THIS observation. */
  readonly id: string;
  /** Redacted text as sent. */
  readonly text: string;
  /** Index into the window lines the caller supplied (before any exclusion). */
  readonly sourceIndex: number;
  /** The byte cap clipped this line mid-text. */
  readonly clipped: boolean;
};

export type RedactionReport = {
  readonly applied: boolean;
  /** Rule ids that fired, in declared order. */
  readonly ruleIds: readonly string[];
  readonly replacements: number;
  /** Stated in every request: redaction is not a confidentiality guarantee. */
  readonly disclaimer: string;
};

export type TemporalEvidenceAbsentReason =
  /** No failure marker on any evidence line. */
  | "no_failure_visible"
  /** One failure block only: a comparison needs two. */
  | "fewer_than_two_attempts";

export type TemporalEvidence =
  | { readonly kind: "absent"; readonly reason: TemporalEvidenceAbsentReason }
  | {
      readonly kind: "pair";
      /** Line ids of the earlier failure-bearing block. */
      readonly firstLineIds: readonly string[];
      /** Line ids of the later failure-bearing block. */
      readonly secondLineIds: readonly string[];
    };

export type EvidenceDrops = {
  /** Window lines above the candidate-line cap. */
  readonly candidateLines: number;
  /** Candidate lines dropped by the byte cap (oldest first). */
  readonly byteCapLines: number;
  /** Bytes those byte-cap lines would have contributed. */
  readonly byteCapBytes: number;
  /** Evidence lines dropped by the total serialized-request cap (oldest first). */
  readonly requestCapLines: number;
  /** Lines dropped as composer chrome or draft. */
  readonly composerLines: number;
  /** Lines dropped as known injected prompt bodies. */
  readonly injectedPromptLines: number;
  /** A single line was clipped mid-text by the byte cap. */
  readonly lineClipped: boolean;
  /** The observer window itself was clipped above (the grid retained fewer lines). */
  readonly windowTruncated: boolean;
  /** Lines the grid retained at read time. */
  readonly windowTotalLines: number;
  /** Lines the caller handed the projection. */
  readonly windowLines: number;
  /** Question ids dropped by the total serialized-request cap. */
  readonly questions: readonly string[];
};

export type SkippedQuestion = {
  readonly questionId: string;
  readonly reason: "evidence_unavailable" | "temporal_pair_missing";
};

export type AwarenessRequestedQuestion = {
  readonly id: string;
  readonly kind: "noul" | "choice";
  /** The exact text to send. */
  readonly prompt: string;
  /** Permitted option ids for this observation (empty for a Noul). */
  readonly optionIds: readonly string[];
  readonly requires: readonly EvidenceRequirement[];
  readonly acceptance: AcceptanceThresholds;
  readonly priority: number;
};

/**
 * The exact payload the transport sends for one observation. The total
 * serialized-request cap measures THIS, not the projection's own bookkeeping:
 * the drop counters, the redaction report, and the skipped-question list are
 * for the operator and never go on the wire, so a cap can never be "met" by
 * quietly omitting the honesty fields.
 */
export type AwarenessWireRequest = {
  readonly packVersion: string;
  /** The id-tagged evidence block, one `L000| text` entry per line. */
  readonly evidence: string;
  /** Tells the model which line ranges a temporal question compares. */
  readonly note: string;
  readonly questions: readonly { readonly id: string; readonly prompt: string }[];
};

export type AwarenessRequestState = {
  readonly packVersion: string;
  readonly bindingId: string;
  readonly epoch: string;
  /** PTY journal seq of the settled grid, as a string (wire-safe). */
  readonly sourceSeq: string;
  readonly observedAt: number;
  /** sha256 over the observation identity and the exact evidence lines sent. */
  /**
   * Coarse material revision of the evidence (`computeWindowDigest`): volatile
   * chrome normalized, PTY sequence and wall clock excluded, so a spinner frame
   * or a counter tick does not change it. An answer echoes this value, and a
   * material-equivalent observation is interchangeable for resolution because
   * normalization is line-preserving.
   */
  readonly evidenceHash: string;
  /** The evidence as sent: `L000| text` lines joined by newline. */
  readonly evidenceBlock: string;
  readonly evidenceLines: readonly EvidenceLine[];
  readonly evidenceBytes: number;
  readonly temporal: TemporalEvidence;
  /** Tells the model which line ranges a temporal question compares. */
  readonly temporalNote: string;
  readonly redaction: RedactionReport;
  readonly drops: EvidenceDrops;
  /** Questions to send, highest priority first. */
  readonly questions: readonly AwarenessRequestedQuestion[];
  /** Questions the pack wanted but the evidence could not support. */
  readonly skipped: readonly SkippedQuestion[];
  /** The exact bytes to send. */
  readonly wire: AwarenessWireRequest;
  readonly caps: {
    readonly candidateLines: number;
    readonly evidenceBytes: number;
    readonly requestBytes: number;
  };
  /** Bytes of the serialized wire payload. */
  readonly serializedBytes: number;
  /** The total-request cap forced a drop. */
  readonly requestTruncated: boolean;
  /**
   * False when even an empty request could not fit the cap. The cap is a
   * budget, not a promise: a cap below the fixed overhead is reported as not
   * honored rather than silently dropping the report.
   */
  readonly requestCapHonored: boolean;
};

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Redaction rules, in declared order. Patterns are stored as source strings and
 * compiled per call so no global-regex `lastIndex` state can leak between
 * observations and break determinism.
 *
 * Scope note: redaction is line-by-line. A secret split across a soft wrap is
 * matched on the row that carries the recognizable shape; a shape this list
 * does not know is not redacted, which is why the disclaimer exists.
 */
export type RedactionRule = {
  readonly id: string;
  readonly pattern: string;
  readonly flags: string;
  readonly replace: string;
  readonly why: string;
};

export const REDACTION_RULES: readonly RedactionRule[] = [
  {
    id: "private_key_block",
    pattern: "-----BEGIN [A-Z ]*PRIVATE KEY-----[^\\n]*",
    flags: "g",
    replace: "[redacted private key]",
    why: "an inline private key header is the one line that must never leave the machine",
  },
  {
    id: "bearer_token",
    pattern: "\\b(?:[Bb]earer)\\s+[A-Za-z0-9._~+/=-]{8,}",
    flags: "g",
    replace: "Bearer [redacted]",
    why: "`Bearer <token>` is the most common auth header in command output",
  },
  {
    id: "authorization_header",
    pattern: "\\b[Aa]uthorization\\s*[:=]\\s*\\S+",
    flags: "g",
    replace: "Authorization: [redacted]",
    why: "an explicit authorization header can carry a scheme this list does not know",
  },
  {
    id: "secret_env_assignment",
    pattern:
      "\\b((?:[A-Z][A-Z0-9_]*_)?(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|CREDENTIALS?|ACCESS_KEY))\\s*=\\s*(?:\"[^\"]*\"|'[^']*'|\\S+)",
    flags: "g",
    replace: "$1=[redacted]",
    why: "env dumps print secrets as NAME=value; the name survives, the value does not, and ordinary assignments (PATH, NODE_ENV) are left alone. Runs before the key-shape rule so a placeholder is never half-consumed.",
  },
  {
    id: "provider_api_key",
    pattern:
      "\\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\\b|\\bgh[pousr]_[A-Za-z0-9]{16,}\\b|\\bgithub_pat_[A-Za-z0-9_]{20,}\\b|\\bxox[abposr]-[A-Za-z0-9-]{8,}\\b|\\bAKIA[0-9A-Z]{16}\\b|\\bAIza[0-9A-Za-z_-]{20,}\\b",
    flags: "g",
    replace: "[redacted secret]",
    why: "the provider key shapes seen in real tool output and env dumps",
  },
  {
    id: "jwt",
    pattern: "\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{4,}\\b",
    flags: "g",
    replace: "[redacted token]",
    why: "a three-part base64url token is a session credential even when the key shape is unknown",
  },
  {
    id: "url_credentials",
    pattern: "\\b([a-z][a-z0-9+.-]*://)[^/\\s:@]+:[^/\\s@]+@",
    flags: "gi",
    replace: "$1[redacted]@",
    why: "credentials embedded in a remote URL survive copy/paste into any log",
  },
  {
    id: "email_address",
    pattern: "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b",
    flags: "g",
    replace: "[redacted email]",
    why: "an address identifies the operator and the account behind the seat",
  },
  {
    id: "posix_home_path",
    pattern: "(?:/Users/|/home/)[^/\\s:\"'`]+",
    flags: "g",
    replace: "/<home>",
    why: "an absolute home path carries the operator's account name into every path it prefixes",
  },
  {
    id: "windows_home_path",
    pattern: "[A-Za-z]:\\\\Users\\\\[^\\\\\\s\"'`]+",
    flags: "g",
    replace: "<home>",
    why: "the Windows form of the same identifying path",
  },
];

export const REDACTION_DISCLAIMER =
  "Redaction removes the secret and path shapes this sidecar knows. It is not a " +
  "confidentiality guarantee: an unrecognized secret, host name, customer value, or " +
  "free-form identifier can still appear in the evidence sent to the model.";

type Redacted = {
  readonly text: string;
  readonly ruleIds: readonly string[];
  readonly replacements: number;
};

/**
 * Expand `$1`-style backreferences in a rule's replacement template. The
 * replacer runs as a function (so a rule can count its hits), and a function
 * replacer does NOT expand `$1` on its own.
 */
const expandReplacement = (
  template: string,
  groups: readonly string[],
): string =>
  template.replace(/\$(\d+)/gu, (_, index: string) => groups[Number(index) - 1] ?? "");

/** Apply every redaction rule to one line. Deterministic; no shared regex state. */
export const redactEvidenceText = (text: string): Redacted => {
  let current = text;
  const fired: string[] = [];
  let replacements = 0;
  for (const rule of REDACTION_RULES) {
    const re = new RegExp(rule.pattern, rule.flags);
    let hits = 0;
    current = current.replace(re, (...args: unknown[]) => {
      hits += 1;
      const groups = args.slice(1, -2).map((value) => String(value ?? ""));
      return expandReplacement(rule.replace, groups);
    });
    if (hits > 0) {
      fired.push(rule.id);
      replacements += hits;
    }
  }
  return { text: current, ruleIds: fired, replacements };
};

// ---------------------------------------------------------------------------
// Composer / injected-prompt exclusion
// ---------------------------------------------------------------------------

export type ComposerExclusion = {
  readonly rule:
    | "prompt_box_body"
    | "after_last_horizontal_rule"
    | "bottom_prompt_glyph"
    | "rounded_bottom_box"
    | "none";
  /** Half-open range into the input lines that is composer chrome or draft. */
  readonly from: number;
  readonly to: number;
};

/** Harness prompt glyphs. Same set the observer's interaction layer anchors on. */
const PROMPT_GLYPH_LINE = /^\s*(?:❯|›|❭|>)(?:\s+|$)/u;
/** Amp draws a rounded composer box instead of rules or a bare glyph. */
const ROUNDED_BOTTOM_BORDER = /^\s*╰(?:─|\s*[∼≈≋~]\s)/u;
const ROUNDED_TOP_BORDER = /^\s*╭[─┴]/u;
const ROUNDED_BODY_ROW = /^\s*│.*│\s*$/u;
/** How far up a ruleless grid the glyph anchor is trusted. */
const GLYPH_TAIL_LINES = 10;

/**
 * The composer region of a grid tail — the lines that are input-box chrome or
 * an unsubmitted draft, never agent evidence.
 *
 * Grounded the same way the observer's interaction layer grounds it: rules
 * first (the box sits below the second-to-last rule), then a bottom prompt
 * glyph, then the rounded border pair Amp draws. A grid none of those describe
 * reports `none` and excludes nothing: an ungrounded guess would silently drop
 * real evidence, and a leak is reported honestly instead.
 *
 * Measured exception (2026-09-18): a screen with several decorative rules and
 * an error panel below them — `pi` printing "Error: No API key found for
 * builtin-mock-responses." — matched the rule branch, and the whole error block
 * was dropped as a composer body. The model was then asked whether the seat was
 * blocked on access with the credential failure deleted from the evidence, and
 * answered "no" at 0.02 on a screen that says the key is missing. A composer box
 * is an input box: it holds the operator's draft, never an error report. So a
 * candidate range that carries a failure marker is not a composer, and the
 * exclusion declines rather than drop it.
 */
export const detectComposerExclusion = (
  lines: readonly string[],
): ComposerExclusion => {
  const none: ComposerExclusion = { rule: "none", from: lines.length, to: lines.length };
  if (lines.length === 0) return none;

  const carriesFailure = (from: number, to: number): boolean =>
    lines.slice(from, to).some((line) => FAILURE_MARKERS.some((marker) => marker.test(line)));

  let ruleCount = 0;
  let secondToLastRule = -1;
  let lastRule = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (isHorizontalRule(lines[i]!)) {
      ruleCount += 1;
      secondToLastRule = lastRule;
      lastRule = i;
    }
  }
  if (ruleCount >= 2 && secondToLastRule >= 0) {
    const from = secondToLastRule + 1;
    if (!carriesFailure(from, lines.length)) {
      return { rule: "prompt_box_body", from, to: lines.length };
    }
  }
  if (ruleCount === 1 && lastRule >= 0) {
    const from = lastRule + 1;
    if (!carriesFailure(from, lines.length)) {
      return { rule: "after_last_horizontal_rule", from, to: lines.length };
    }
  }

  // Rounded box (Amp): the bottom-most non-blank line closes the box.
  let bottom = lines.length - 1;
  while (bottom >= 0 && lines[bottom]!.trim().length === 0) bottom -= 1;
  if (bottom >= 0 && ROUNDED_BOTTOM_BORDER.test(lines[bottom]!)) {
    let top = bottom - 1;
    while (top >= 0 && ROUNDED_BODY_ROW.test(lines[top]!)) top -= 1;
    if (top >= 0 && top < bottom - 1 && ROUNDED_TOP_BORDER.test(lines[top]!)) {
      return { rule: "rounded_bottom_box", from: top, to: bottom + 1 };
    }
  }

  const tailStart = Math.max(0, lines.length - GLYPH_TAIL_LINES);
  for (let i = lines.length - 1; i >= tailStart; i -= 1) {
    if (PROMPT_GLYPH_LINE.test(lines[i]!)) {
      return { rule: "bottom_prompt_glyph", from: i, to: lines.length };
    }
  }
  return none;
};

// ---------------------------------------------------------------------------
// Temporal evidence — what a comparison question needs supplied
// ---------------------------------------------------------------------------

/**
 * Failure markers. Deliberately small and literal: this detector exists to
 * certify that TWO failure-bearing blocks are on screen, so a comparison is
 * possible at all. It never decides whether the blocks repeat; that judgment is
 * the model's, and a false "two attempts present" would reintroduce the
 * measured false positive, so the marker set stays conservative. A zero count
 * ("0 failed", "exit code 0") is success and is not a marker.
 */
export const FAILURE_MARKERS: readonly RegExp[] = [
  /^\s*(?:FAIL|FAILED|FAILURE)\b/u,
  /^\s*(?:ERROR|Error|error)\b/u,
  /\bexit (?:code|status)\s+[1-9]/iu,
  /\b[1-9]\d*\s+(?:failed|failing)\b/iu,
  /^\s*(?:✗|×|✘)\s/u,
  /Traceback \(most recent call last\)/u,
  /\bpanic:/u,
  /\b(?:AssertionError|TypeError|ReferenceError|SyntaxError|RuntimeError)\b/u,
];

const isFailureLine = (text: string): boolean =>
  FAILURE_MARKERS.some((re) => re.test(text));

const isBlockBoundary = (text: string): boolean =>
  text.trim().length === 0 || isHorizontalRule(text);

/**
 * Two failure-bearing blocks, if the evidence holds them.
 *
 * A block is the maximal contiguous run of non-blank, non-rule lines around a
 * failure marker. Two failures inside one run are one block; two failures
 * separated by a blank line, a rule, or fresh output are two — which is the
 * shape a repeated attempt has on a real screen. Fewer than two blocks is
 * `absent`, and the comparison question is then not asked.
 */
export const detectTemporalEvidence = (
  lines: readonly Pick<EvidenceLine, "id" | "text">[],
): TemporalEvidence => {
  const blocks: Array<{ readonly start: number; readonly end: number }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!isFailureLine(lines[i]!.text)) continue;
    let start = i;
    while (start > 0 && !isBlockBoundary(lines[start - 1]!.text)) start -= 1;
    let end = i;
    while (end < lines.length - 1 && !isBlockBoundary(lines[end + 1]!.text)) end += 1;
    const prior = blocks[blocks.length - 1];
    if (prior !== undefined && start <= prior.end + 1) {
      if (end > prior.end) blocks[blocks.length - 1] = { start: prior.start, end };
      continue;
    }
    blocks.push({ start, end });
  }
  if (blocks.length === 0) return { kind: "absent", reason: "no_failure_visible" };
  if (blocks.length < 2) return { kind: "absent", reason: "fewer_than_two_attempts" };
  const first = blocks[blocks.length - 2]!;
  const second = blocks[blocks.length - 1]!;
  return {
    kind: "pair",
    firstLineIds: lines.slice(first.start, first.end + 1).map((l) => l.id),
    secondLineIds: lines.slice(second.start, second.end + 1).map((l) => l.id),
  };
};

const describeTemporal = (temporal: TemporalEvidence): string => {
  if (temporal.kind === "absent") {
    return temporal.reason === "no_failure_visible"
      ? "Note: no failure output is present in this evidence, so a repeat comparison is not possible."
      : "Note: only one failure block is present in this evidence, so a repeat comparison is not possible.";
  }
  const range = (ids: readonly string[]): string => `${ids[0]} to ${ids[ids.length - 1]}`;
  return (
    `Note: two comparable attempts are supplied. Attempt 1 is lines ${range(temporal.firstLineIds)}. ` +
    `Attempt 2 is lines ${range(temporal.secondLineIds)}.`
  );
};

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

type CandidateLine = {
  readonly text: string;
  readonly sourceIndex: number;
  readonly clipped: boolean;
};

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

const CLIP_MARKER = "…[clipped]";

/** Clip one line to `budget` bytes, keeping whole code points. */
const clipToBytes = (text: string, budget: number): string => {
  const markerBytes = byteLength(CLIP_MARKER);
  if (budget <= markerBytes) return "";
  const room = budget - markerBytes;
  let used = 0;
  const kept: string[] = [];
  for (const ch of text) {
    const size = byteLength(ch);
    if (used + size > room) break;
    kept.push(ch);
    used += size;
  }
  return `${kept.join("")}${CLIP_MARKER}`;
};

const renderEvidenceBlock = (lines: readonly EvidenceLine[]): string =>
  lines.map((line) => `${line.id}| ${line.text}`).join("\n");

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

const sha256Hex = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

// ---------------------------------------------------------------------------
// Window digest — the one normalization shared by cache key and staleness
// ---------------------------------------------------------------------------

/**
 * Bump when any rule in `VOLATILE_CHROME_RULES` changes shape. The version is
 * part of the digest input, so a rule change invalidates every cache key and
 * staleness comparison computed under the old rules instead of silently reusing
 * a value that now means something different.
 */
export const WINDOW_DIGEST_VERSION = 1;

export type VolatileChromeRule = {
  readonly id: string;
  readonly pattern: string;
  readonly flags: string;
  readonly replace: string;
  readonly why: string;
};

/**
 * Volatile chrome, in declared order. Each rule rewrites ONE line in place and
 * must never change the line count. Patterns are stored as source strings and
 * compiled per call so no global-regex state can leak between observations.
 *
 * The discipline is one-sided: a rule that fails to normalize some volatile
 * frame costs a redundant judgment, while a rule that swallows a material
 * difference hides real news. So every rule targets a recognized counter or
 * frame shape, and `tests/awareness-digest.test.ts` pins the material cases
 * (test counts, error text, payload lines, file paths) as digest-changing.
 */
export const VOLATILE_CHROME_RULES: readonly VolatileChromeRule[] = [
  {
    id: "braille_animation_frames",
    pattern: "[\u2800-\u28ff]+",
    flags: "gu",
    replace: "*",
    why: "braille cells are the spinner alphabet on Claude, Amp, Muse, OMP, and Codex; the frame is pure animation",
  },
  {
    id: "status_glyph_frames",
    pattern: "[\u2722\u2733\u2736\u2737\u273b\u273d\u273e\u273f\u2740\u2741]+",
    flags: "gu",
    replace: "*",
    why: "the Claude-family working-status glyph churns between frames while the status text beside it stays the same",
  },
  {
    id: "elapsed_seconds_after_preposition",
    pattern: "\\b(for|in)\\s+\\d+(?:\\.\\d+)?\\s*(?:ms|s|m|h)\\b",
    flags: "gu",
    replace: "$1 <t>",
    why: "elapsed-time counter (`Churned for 2s`, `completed in 12s`)",
  },
  {
    id: "elapsed_seconds_in_parenthesis",
    pattern: "\\(\\s*\\d+(?:\\.\\d+)?\\s*s\\b",
    flags: "gu",
    replace: "(<t>",
    why: "Claude's status line leads with a live duration: `(2s \u00b7 \u2193 102 tokens \u00b7 thinking)`",
  },
  {
    id: "elapsed_seconds_after_dot",
    pattern: "\\u00b7\\s*\\d+(?:\\.\\d+)?\\s*s\\b",
    flags: "gu",
    replace: "\u00b7 <t>",
    why: "the same status line's second duration, after the separator",
  },
  {
    id: "interrupt_footer_seconds",
    pattern: "\\b\\d+(?:\\.\\d+)?s\\s*\\(esc (?:twice )?to interrupt\\)",
    flags: "gu",
    replace: "<t> (esc to interrupt)",
    why: "pi and devin print a live turn timer in their footer",
  },
  {
    id: "context_token_ratio",
    pattern: "Context:\\s*\\d+(?:\\.\\d+)?k?\\s*/\\s*\\d+(?:\\.\\d+)?k?",
    flags: "giu",
    replace: "Context: <n>/<n>",
    why: "a context meter's numerator and limit move every turn; the label is kept so the line still reads as a context meter",
  },
  {
    id: "token_counters",
    pattern: "\\b\\d+(?:\\.\\d+)?k?\\s*tokens?\\b",
    flags: "giu",
    replace: "<tokens>",
    why: "token counters (`\u2193 102 tokens`, `44k tokens`)",
  },
  {
    id: "percent_of_limit",
    pattern: "\\b\\d+(?:\\.\\d+)?%\\s*/\\s*\\d+(?:\\.\\d+)?[KM]?\\b",
    flags: "gu",
    replace: "<pct>/<limit>",
    why: "context meters (`0.0%/400k`, `21%/1M`)",
  },
  {
    id: "percent_meters",
    pattern: "\\b\\d+(?:\\.\\d+)?%",
    flags: "gu",
    replace: "<pct>",
    why: "progress and context percentages",
  },
  {
    id: "cost_meters",
    pattern: "\\$\\d+(?:\\.\\d+)?|\\$\\s*[.\\u00b7]{2,}",
    flags: "gu",
    replace: "<$>",
    why: "the cost meter (`$0.00`, `$\u00b7\u00b7\u00b7\u00b7`)",
  },
  {
    id: "relative_ages",
    pattern: "\\(\\s*\\d+\\s*m ago\\s*\\)",
    flags: "gu",
    replace: "(<ago>)",
    why: "relative timestamps (`(5m ago)`)",
  },
  {
    id: "usage_multipliers",
    pattern: "\\b\\d+x usage\\b",
    flags: "gu",
    replace: "<usage>",
    why: "the usage multiplier on a model row (`1x usage`)",
  },
  {
    id: "byte_counters",
    pattern: "\\b\\d+(?:\\.\\d+)?\\s*(?:bytes?|KB|MB|GB)\\b",
    flags: "giu",
    replace: "<bytes>",
    why: "byte counters, which move with every burst",
  },
  {
    id: "sequence_counters",
    pattern: "\\b(seq|sequence|offset)\\s*[:=]\\s*\\d+\\b",
    flags: "giu",
    replace: "$1: <n>",
    why: "sequence and offset counters, which move with every burst; the label is kept so a counter is never confused with a byte count",
  },
  {
    id: "block_cursor_runs",
    pattern: "[\u2588\u2589\u258a\u258b\u258c\u258d\u258e\u258f\u2590\u2591\u2592\u2593]+",
    flags: "gu",
    replace: "",
    why: "a block-glyph run is the cursor cell or a scrollbar column, and both move with position rather than content; removing the run is what makes a repaint with identical visible text digest-equal. The cost is that the PRESENCE of such a run is erased too, which is deliberate: a bar appearing or vanishing is a control transition the scheduler already triggers on, not a material text change",
  },
  {
    id: "trailing_padding",
    pattern: "[ \\t]+$",
    flags: "gu",
    replace: "",
    why: "a repaint that pads a line to the same visible text must not read as a change",
  },
];

/** Rewrite one evidence line into its volatile-chrome-normalized form. */
export const normalizeVolatileChrome = (text: string): string => {
  let current = text;
  for (const rule of VOLATILE_CHROME_RULES) {
    const re = new RegExp(rule.pattern, rule.flags);
    current = current.replace(re, (...args: unknown[]) => {
      const groups = args.slice(1, -2).map((value) => String(value ?? ""));
      return expandReplacement(rule.replace, groups);
    });
  }
  return current;
};

export type WindowDigestInput = {
  /** Observation identity: two seats and two generations never share a digest. */
  readonly bindingId: string;
  readonly epoch: string;
  /** The bounded, redacted evidence lines exactly as sent. */
  readonly lines: readonly Pick<EvidenceLine, "text">[];
};

/**
 * The coarse material screen revision for one observation.
 *
 * This is the single function the scheduler's cache key and the renderer's
 * staleness comparison call. It deliberately excludes the PTY sequence and the
 * wall clock: a burst of new output that does not change the visible material
 * must not move the digest, or every fresh judgment would read as stale within
 * seconds on a continuously printing seat.
 */
export const computeWindowDigest = (input: WindowDigestInput): string =>
  sha256Hex(windowDigestMaterial(input));

/**
 * The exact value the digest is taken over. Exported so a caller (or a test) can
 * see that the rule-set version participates: changing a rule changes the
 * digest of unchanged evidence, which is what makes a stale cache key
 * impossible to reuse by accident.
 */
export const windowDigestMaterial = (input: WindowDigestInput): unknown => ({
  version: WINDOW_DIGEST_VERSION,
  bindingId: input.bindingId,
  epoch: input.epoch,
  lines: input.lines.map((line) => normalizeVolatileChrome(line.text)),
});

type BuildInput = {
  readonly window: AwarenessEvidenceWindow;
  readonly caps: {
    readonly candidateLines: number;
    readonly evidenceBytes: number;
    readonly requestBytes: number;
  };
  readonly packVersion: string;
  /** Redacted survivors, oldest first, before any cap. */
  readonly survivors: readonly CandidateLine[];
  readonly redaction: RedactionReport;
  /** Drops already known before the request-cap loop. */
  readonly baseDrops: Omit<EvidenceDrops, "requestCapLines" | "questions">;
  /** Question ids still in play (a request-cap squeeze removes from this set). */
  readonly questionIds: readonly string[];
  /** Evidence lines removed by the request-cap squeeze (oldest first). */
  readonly requestCapLines: number;
  readonly droppedQuestionIds: readonly string[];
};

const assembleRequest = (input: BuildInput): AwarenessRequestState => {
  const { window, caps, survivors } = input;

  // Byte cap: drop the oldest lines until the evidence fits, then clip the
  // newest line if it alone cannot. Each rendered line is `id| text`, and the
  // id prefix is estimated at the widest id the candidate cap can produce, so
  // the measured block can never exceed the cap.
  const idWidth = byteLength(`${formatEvidenceLineId(caps.candidateLines)}| `);
  const kept: CandidateLine[] = [];
  let bytes = 0;
  let byteCapLines = 0;
  let byteCapBytes = 0;
  let lineClipped = false;
  for (let i = survivors.length - 1; i >= 0; i -= 1) {
    const candidate = survivors[i]!;
    const size = idWidth + byteLength(candidate.text);
    if (bytes + size > caps.evidenceBytes) {
      if (kept.length === 0) {
        // A single line cannot fit: keep the newest line, clipped, so the
        // bottom of the screen is never dropped entirely.
        const clippedText = clipToBytes(candidate.text, caps.evidenceBytes - idWidth);
        if (clippedText.length > 0) {
          kept.push({ text: clippedText, sourceIndex: candidate.sourceIndex, clipped: true });
          bytes = idWidth + byteLength(clippedText);
          lineClipped = true;
          continue;
        }
      }
      byteCapLines += 1;
      byteCapBytes += size;
      continue;
    }
    kept.push(candidate);
    bytes += size;
  }
  kept.reverse();

  // Id tagging happens last: the ids name exactly the lines that are sent.
  const evidenceLines: EvidenceLine[] = kept.map((line, index) => ({
    id: formatEvidenceLineId(index),
    text: line.text,
    sourceIndex: line.sourceIndex,
    clipped: line.clipped,
  }));

  const temporal = detectTemporalEvidence(evidenceLines);
  const availability = {
    evidenceLines: evidenceLines.length,
    temporalPair: temporal.kind === "pair",
  };

  const evidenceLineIds = evidenceLines.map((line) => line.id);
  const requested: AwarenessRequestedQuestion[] = [];
  const skipped: SkippedQuestion[] = [];
  const wanted = new Set(input.questionIds);
  for (const question of AWARENESS_QUESTIONS) {
    if (!wanted.has(question.id)) continue;
    if (!isQuestionAskable(question, availability)) {
      skipped.push({
        questionId: question.id,
        reason:
          availability.evidenceLines <= 0 ? "evidence_unavailable" : "temporal_pair_missing",
      });
      continue;
    }
    requested.push({
      id: question.id,
      kind: question.kind,
      prompt: renderQuestionPrompt(question, evidenceLineIds),
      optionIds: permittedOptionIds(question, evidenceLineIds),
      requires: question.requires,
      acceptance: acceptanceThresholdsFor(question),
      priority: question.priority,
    });
  }
  requested.sort((left, right) => right.priority - left.priority || (left.id < right.id ? -1 : 1));

  const evidenceBlock = renderEvidenceBlock(evidenceLines);
  const evidenceBytes = byteLength(evidenceBlock);
  const drops: EvidenceDrops = {
    ...input.baseDrops,
    byteCapLines: input.baseDrops.byteCapLines + byteCapLines,
    byteCapBytes: input.baseDrops.byteCapBytes + byteCapBytes,
    lineClipped: input.baseDrops.lineClipped || lineClipped,
    requestCapLines: input.requestCapLines,
    questions: input.droppedQuestionIds,
  };

  const temporalNote = describeTemporal(temporal);
  const wire: AwarenessWireRequest = {
    packVersion: input.packVersion,
    evidence: evidenceBlock,
    note: temporalNote,
    questions: requested.map((question) => ({ id: question.id, prompt: question.prompt })),
  };
  const serializedBytes = byteLength(JSON.stringify(wire));

  const state: AwarenessRequestState = {
    packVersion: input.packVersion,
    bindingId: window.bindingId,
    epoch: window.epoch,
    sourceSeq: window.seq.toString(),
    observedAt: window.observedAt,
    evidenceHash: computeWindowDigest({
      bindingId: window.bindingId,
      epoch: window.epoch,
      lines: evidenceLines,
    }),
    evidenceBlock,
    evidenceLines,
    evidenceBytes,
    temporal,
    temporalNote,
    redaction: input.redaction,
    drops,
    questions: requested,
    skipped,
    wire,
    caps: { ...caps },
    serializedBytes,
    requestTruncated: input.droppedQuestionIds.length > 0 || input.requestCapLines > 0,
    requestCapHonored: serializedBytes <= caps.requestBytes,
  };
  return state;
};

/**
 * Project one observation into the request state.
 *
 * Pure and deterministic. `opts.injectedPromptNeedles` are the only caller
 * knowledge this accepts, because only the caller can ground what this app
 * pasted into the seat.
 */
export const selectAwarenessInput = (
  window: AwarenessEvidenceWindow,
  opts: SelectAwarenessInputOptions = {},
): AwarenessRequestState => {
  const caps = {
    candidateLines: opts.caps?.candidateLines ?? MAX_EVIDENCE_CANDIDATE_LINES,
    evidenceBytes: opts.caps?.evidenceBytes ?? MAX_EVIDENCE_BYTES,
    requestBytes: opts.caps?.requestBytes ?? MAX_REQUEST_BYTES,
  };
  const packVersion = opts.packVersion ?? AWARENESS_PACK_VERSION;

  // 1. Candidate lines: the bottom of the window, newest kept.
  const candidateCount = Math.max(0, Math.min(caps.candidateLines, window.lines.length));
  const firstCandidate = window.lines.length - candidateCount;
  const candidates: CandidateLine[] = window.lines
    .slice(firstCandidate)
    .map((text, index) => ({ text, sourceIndex: firstCandidate + index, clipped: false }));

  // 2. Composer chrome and drafts, then known injected prompt bodies.
  const composer = detectComposerExclusion(candidates.map((line) => line.text));
  const needles = (opts.injectedPromptNeedles ?? []).filter((needle) => needle.length > 0);
  let composerLines = 0;
  let injectedPromptLines = 0;
  const survivors: CandidateLine[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const line = candidates[i]!;
    if (i >= composer.from && i < composer.to) {
      composerLines += 1;
      continue;
    }
    if (needles.some((needle) => line.text.includes(needle))) {
      injectedPromptLines += 1;
      continue;
    }
    survivors.push(line);
  }

  // 3. Redaction, then the byte cap and id tagging (inside the assembler).
  const firedRules = new Set<string>();
  let replacements = 0;
  const redacted: CandidateLine[] = survivors.map((line) => {
    const result = redactEvidenceText(line.text);
    for (const id of result.ruleIds) firedRules.add(id);
    replacements += result.replacements;
    return { ...line, text: result.text };
  });
  const redaction: RedactionReport = {
    applied: replacements > 0,
    ruleIds: REDACTION_RULES.map((rule) => rule.id).filter((id) => firedRules.has(id)),
    replacements,
    disclaimer: REDACTION_DISCLAIMER,
  };

  const baseDrops: Omit<EvidenceDrops, "requestCapLines" | "questions"> = {
    candidateLines: window.lines.length - candidateCount,
    byteCapLines: 0,
    byteCapBytes: 0,
    composerLines,
    injectedPromptLines,
    lineClipped: false,
    windowTruncated: window.truncated,
    windowTotalLines: window.totalLines,
    windowLines: window.lines.length,
  };

  // 4. Assemble, then squeeze under the total serialized-request cap. The cap
  //    drops the lowest-priority question first; only if no question is left
  //    does it drop evidence lines (oldest first). Either way the drop is
  //    reported, and `requestCapHonored` says plainly whether the cap was met.
  let questionIds = AWARENESS_QUESTIONS.map((q) => q.id);
  const droppedQuestionIds: string[] = [];
  let requestCapLines = 0;
  for (;;) {
    const state = assembleRequest({
      window,
      caps,
      packVersion,
      survivors: redacted,
      redaction,
      baseDrops,
      questionIds,
      requestCapLines,
      droppedQuestionIds,
    });
    if (state.requestCapHonored) return state;
    // Only a question that was actually requested can be squeezed out:
    // `requested` is already ordered highest priority first, so the last entry
    // is the cheapest to lose.
    const victim = state.questions[state.questions.length - 1];
    if (victim !== undefined) {
      questionIds = questionIds.filter((id) => id !== victim.id);
      droppedQuestionIds.push(victim.id);
      continue;
    }
    if (redacted.length > 0) {
      redacted.shift();
      requestCapLines += 1;
      continue;
    }
    // Nothing left to drop: the cap is below the request's fixed floor. The
    // state already reports `requestCapHonored: false`.
    return state;
  }
};
