/**
 * Label derivation — the ground truth a live model run is compared against.
 *
 * Every label is read from the RENDERED screen, the observer's own
 * title/OSC signals, the capture's recorded timestamps, and the chrome
 * literals in `chrome.ts` (which are themselves read off captures). Nothing
 * here consults the seat-state rule engine, the composer verdict, the drive,
 * or a model. `authority.test.ts` refuses a control-path import in this
 * directory so the property cannot be lost by a later edit.
 *
 * Where the screen cannot ground a label the value is the literal string
 * `insufficient_evidence` and `basis` says what was missing. An abstention is
 * a real result: the frozen pack's `repetition` Choice even offers
 * `insufficient_evidence` as one of its own options.
 */

import type { ChromeMatch, CheckpointClass, Label, LabelVector, ConcernId } from "./types";
import { CONCERNS } from "./types";
import type { IdLines } from "./evidence";

export const INSUFFICIENT = "insufficient_evidence" as const;

/**
 * Activity markers, scoped to the harness's OWN live-status lines.
 *
 * Transcript prose is deliberately not activity evidence: omp's
 * "I can explore the codebase, fix bugs, or build features" is the model
 * describing what it might do, not what it is doing now, and grok's
 * "Write forty numbered lines" is the operator's instruction. Reading an
 * activity class out of prose is how a 7-way Choice ends up at 0.46-0.60
 * confidence on a genuinely working screen.
 */
export const ACTIVITY_MARKERS: ReadonlyArray<{
  readonly option: string;
  readonly source: string;
  readonly flags: string;
  readonly provenance: string;
}> = [
  {
    option: "testing",
    source: "\\brunning (?:the )?tests?\\b|\\btests? (?:passed|failed)\\b|\\bvitest\\b|\\bbun test\\b",
    flags: "iu",
    provenance: "pack activity option `testing`; no committed capture paints it",
  },
  {
    option: "running_command",
    source: "\\brunning (?:command|build|install|script)\\b|\\bexecuting\\b",
    flags: "iu",
    provenance: "pack activity option `running_command`; no committed capture paints it",
  },
  {
    option: "editing",
    source: "\\b(?:editing|writing) (?:file|files|edit|patch|diff)\\b|\\bapplying (?:edit|patch|diff)\\b",
    flags: "iu",
    provenance: "pack activity option `editing`; no committed capture paints it",
  },
  {
    option: "investigating",
    source: "\\b(?:reading|searching|scanning|grepping|globbing)\\b",
    flags: "iu",
    provenance: "pack activity option `investigating`; no committed capture paints it",
  },
  {
    option: "reviewing",
    source: "\\breviewing\\b",
    flags: "iu",
    provenance: "pack activity option `reviewing`; no committed capture paints it",
  },
  {
    option: "reporting",
    source: "\\b(?:final answer|summar(?:y|izing|ising))\\b",
    flags: "iu",
    provenance: "pack activity option `reporting`; no committed capture paints it",
  },
];

/**
 * Failure literals used for the `repetition` Choice and for grounding
 * `execution_error` absence. Each was read off a capture or is the harness's
 * own visible error prefix.
 */
export const FAILURE_LITERALS: ReadonlyArray<{
  readonly source: string;
  readonly flags: string;
  readonly provenance: string;
}> = [
  { source: "error: agent init failed", flags: "iu", provenance: "P1 hermes/* rendered error line" },
  { source: "No Codex credentials stored", flags: "iu", provenance: "P1 hermes/* rendered error line" },
  { source: "Error: LLM not set", flags: "iu", provenance: "P1 kimi/type-echo rendered error line" },
  { source: "No API key found", flags: "iu", provenance: "P1 pi/type-echo rendered error line" },
  { source: "\\berror\\b|\\bfailed\\b|\\bcannot\\b|\\bnot found\\b", flags: "iu", provenance: "generic failure vocabulary" },
];

const CHROME_LINE = [
  /^\s*$/u,
  /^[\s─━═=_·.]+$/u,
  /^\s*[│┃╭╰╮╯]+/u,
  /^\s*[❯›❭>]\s*$/u,
  /^\s*[\u2800-\u28FF\u25D0-\u25D3\u25F4-\u25F7\u25CB-\u25CF]+/u,
  /^\s*[\u25C7\u25C6\u25C8\u23F3\u{1F311}-\u{1F318}]/u,
  /^\s*[·•]\s/u,
];

// Compiled once: label derivation runs on every sampled step of every capture.
const ACTIVITY_COMPILED = ACTIVITY_MARKERS.map((marker) => ({
  option: marker.option,
  provenance: marker.provenance,
  re: new RegExp(marker.source, marker.flags),
}));

const FAILURE_COMPILED = FAILURE_LITERALS.map((failure) => ({
  provenance: failure.provenance,
  re: new RegExp(failure.source, failure.flags),
}));

const isChromeOnlyLine = (line: string, literals: readonly string[]): boolean => {
  const t = line.trimEnd();
  if (CHROME_LINE.some((re) => re.test(t))) return true;
  return literals.some((literal) => literal.length > 0 && t.includes(literal));
};

/** Volatile chrome that must not read as "the attempts differ". */
const normalizeScreen = (lines: readonly string[]): string =>
  lines
    .join("\n")
    .replace(/\d+/gu, "#")
    .replace(/\s+/gu, " ")
    .trim();

const matchesFailure = (lines: readonly string[]): string | undefined => {
  const text = lines.join("\n");
  for (const failure of FAILURE_COMPILED) {
    const hit = failure.re.exec(text);
    if (hit) return hit[0];
  }
  return undefined;
};

export type LabelInput = {
  /** Which chrome vocabulary applies — resolved by the caller into `matches`. */
  readonly class: CheckpointClass;
  readonly matches: readonly ChromeMatch[];
  /** The rendered window lines (bottom of the grid). */
  readonly lines: readonly string[];
  readonly window: IdLines;
  /** The earlier observation's lines, when the evidence pair exists. */
  readonly earlierLines: readonly string[] | undefined;
};

const concernMatch = (
  matches: readonly ChromeMatch[],
  concern: ConcernId,
): ChromeMatch | undefined => matches.find((m) => m.concern === concern);

/** The harness's own live-status lines, the only activity-evidence surface. */
const activityCandidates = (
  matches: readonly ChromeMatch[],
  lines: readonly string[],
): readonly string[] => {
  const lastNonEmpty = [...lines].reverse().find((l) => l.trim().length > 0);
  return [
    ...matches.filter((m) => m.where === "screen").map((m) => m.matchedText),
    ...(lastNonEmpty ? [lastNonEmpty] : []),
  ];
};

export const labelCheckpoint = (input: LabelInput): LabelVector => {
  const { matches, lines, window: win, earlierLines } = input;
  const liveTurn = matches.find((m) => m.kind === "live_turn");
  const pendingDialog = matches.find((m) => m.role === "dialog");
  const settledIdle = matches.find((m) => m.role === "settled_idle");
  // A frame that shows no live turn is either a pending-human dialog or the
  // harness's own settled-ready chrome. The pack's own false criterion covers
  // both ("the seat is idle, finished, or waiting on a human"). A
  // composer/footer probe that also paints mid-turn (codex's model footer,
  // claude's `❯`) is deliberately NOT allowed to outrank live-turn chrome.

  // ---- turn_in_progress -------------------------------------------------
  const turnInProgress: Label =
    liveTurn && pendingDialog
      ? {
          value: INSUFFICIENT,
          basis:
            "both live-turn chrome and a pending-human frame are on screen; the pack's boundary is ambiguous here",
        }
      : liveTurn
        ? {
            value: "yes",
            basis: "live-turn chrome on the rendered screen",
            literal: liveTurn.matchedText,
          }
        : pendingDialog
          ? {
              value: "no",
              basis:
                "no live-turn chrome; a pending-human frame is on screen, which the pack's own false criterion names (\"waiting on a human\")",
              literal: pendingDialog.matchedText,
            }
          : settledIdle
            ? {
                value: "no",
                basis: "no live-turn chrome; the harness's own settled idle chrome is on screen",
                literal: settledIdle.matchedText,
              }
            : {
                value: INSUFFICIENT,
                basis: "no live-turn chrome and no not-working frame matched on this screen",
              };

  // ---- activity ---------------------------------------------------------
  const candidates = activityCandidates(matches, lines);
  let activity: Label = {
    value: "indeterminate",
    basis:
      "no activity-class marker on the harness's own live-status lines; the pack's `indeterminate` option covers exactly this",
  };
  for (const marker of ACTIVITY_COMPILED) {
    const hit = candidates.map((c) => marker.re.exec(c)).find((m) => m !== null) ?? null;
    if (hit) {
      activity = {
        value: marker.option,
        basis: `activity marker on a live-status line (${marker.provenance})`,
        literal: hit[0],
      };
      break;
    }
  }
  if (candidates.length === 0) {
    activity = { value: INSUFFICIENT, basis: "no live-status line to read an activity from" };
  }

  // ---- concerns ---------------------------------------------------------
  const concernLabels: Record<ConcernId, Label> = {} as Record<ConcernId, Label>;
  for (const concern of CONCERNS) {
    const hit = concernMatch(matches, concern);
    concernLabels[concern] = hit
      ? { value: "yes", basis: `concern literal on the rendered screen (${hit.probeId})`, literal: hit.matchedText }
      : input.class === "settled_idle"
        ? {
            value: "no",
            basis: "the harness's own settled idle chrome is on screen and no concern literal is",
          }
        : {
            value: INSUFFICIENT,
            basis: "no concern literal on screen and no settled idle chrome to ground an absence",
          };
  }

  // ---- repetition -------------------------------------------------------
  let repetition: Label;
  if (earlierLines === undefined) {
    repetition = {
      value: INSUFFICIENT,
      basis: "fewer than two observations — the pack's own `insufficient_evidence` option",
    };
  } else {
    const nowNorm = normalizeScreen(lines);
    const thenNorm = normalizeScreen(earlierLines);
    if (nowNorm === thenNorm) {
      repetition = {
        value: INSUFFICIENT,
        basis: "the two observations are identical after stripping volatile chrome — too similar to tell",
      };
    } else {
      const nowFailure = matchesFailure(lines);
      const thenFailure = matchesFailure(earlierLines);
      repetition =
        nowFailure !== undefined && thenFailure !== undefined && nowFailure === thenFailure
          ? {
              value: "yes",
              basis: "the same failure literal appears in both observations",
              literal: nowFailure,
            }
          : {
              value: "no",
              basis: "the two observations differ after normalisation — the pack's own `no` criterion",
            };
    }
  }

  // ---- highlight --------------------------------------------------------
  const idleLiterals = matches.filter((m) => m.role === "settled_idle").map((m) => m.matchedText);
  const nonChromeLines = lines.filter((l) => l.trim().length > 0 && !isChromeOnlyLine(l, idleLiterals));
  const highlightExists: Label =
    pendingDialog !== undefined
      ? { value: "yes", basis: "a pending-human frame carries real current signal", literal: pendingDialog.matchedText }
      : liveTurn !== undefined
        ? { value: "yes", basis: "live-turn chrome is the most informative thing on screen", literal: liveTurn.matchedText }
        : input.class === "settled_idle" && nonChromeLines.length === 0
          ? { value: "no", basis: "settled idle chrome and nothing but chrome/empty space on screen" }
          : nonChromeLines.length === 0
            ? { value: "no", basis: "nothing but chrome/empty space on screen" }
            : {
                value: INSUFFICIENT,
                basis: "the screen carries content, but choosing the single most informative line is a judgement, not a screen fact",
              };

  // ---- highlight_line ---------------------------------------------------
  // The answer space is the window's own ids plus NONE, so a grounded label can
  // only name a line the screen FACTS single out. When more than one line
  // carries current signal the "most informative line" is a judgement, and the
  // label abstains instead of pretending one of them is the truth.
  const signalLines = [
    ...new Set(
      matches
        .filter((m) => m.where === "screen" && m.role !== "settled_idle")
        .map((m) => m.matchedText.trim()),
    ),
  ];
  let highlightLine: Label;
  if (highlightExists.value === "no") {
    highlightLine = { value: "NONE", basis: "nothing worth surfacing (see highlight_exists)" };
  } else if (signalLines.length === 0) {
    highlightLine = {
      value: INSUFFICIENT,
      basis: "no screen line carries current signal (the selecting chrome is an OSC title/OSC9)",
    };
  } else if (signalLines.length > 1) {
    highlightLine = {
      value: INSUFFICIENT,
      basis: `${signalLines.length} distinct window lines carry current signal, so the single most informative line is a judgement, not a screen fact`,
    };
  } else {
    const wanted = signalLines[0]!;
    const hits = win.lines
      .map((line, i) => ({ id: win.ids[i]!, line: line.trim() }))
      .filter((entry) => entry.line === wanted || entry.line.includes(wanted));
    highlightLine =
      hits.length === 1
        ? {
            value: hits[0]!.id,
            basis: "the only window line carrying current signal",
            literal: wanted,
          }
        : {
            value: INSUFFICIENT,
            basis: `${hits.length} window lines carry the same literal — the target is ambiguous`,
          };
  }

  return {
    activity,
    turn_in_progress: turnInProgress,
    approval_requested: concernLabels.approval_requested,
    answer_requested: concernLabels.answer_requested,
    access_problem: concernLabels.access_problem,
    execution_error: concernLabels.execution_error,
    repetition,
    highlight_exists: highlightExists,
    highlight_line: highlightLine,
  };
};
