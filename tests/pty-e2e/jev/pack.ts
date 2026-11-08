/**
 * The frozen question pack, verbatim.
 *
 * Copied from the parent's proof-of-concept (`scripts/jev-pty-poc.ts`, local
 * commit f483503, not in this checkout) as recovered from the parent thread.
 * The pack is the binding contract: instruction sentences, option names, and
 * the acceptance thresholds are reproduced exactly so a live run from this
 * harness produces the same answers the parent's paid runs did.
 *
 * Two things the parent's script did NOT pin, recorded here rather than
 * silently "fixed", because changing them would change the measurement:
 *  - no explicit `model` field was sent (the SDK default is `jev-latest`, and
 *    the service returned `jev-1.13.0`);
 *  - the corpus phase sent `evidence` as `{ earlier, now }` while the
 *    adversarial phase sent it as an array of id-tagged strings. This harness
 *    sends the corpus-phase object shape (see `buildState`).
 */

import type { IdLines } from "./evidence";

export type NoulQuestion = {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria?: { readonly true: string; readonly false: string };
};

export type ChoiceQuestion = {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string | null>>;
};

export type Question = NoulQuestion | ChoiceQuestion;

export type QuestionMap = Readonly<Record<string, Question>>;

export const PACK_IDS = [
  "activity",
  "turn_in_progress",
  "approval_requested",
  "answer_requested",
  "access_problem",
  "execution_error",
  "repetition",
  "highlight_exists",
  "highlight_line",
] as const;
export type PackId = (typeof PACK_IDS)[number];

/** The 7-way activity options, verbatim. */
export const ACTIVITY_OPTIONS = {
  investigating: "Reading files, searching, planning, or reasoning about the codebase",
  editing: "Writing or editing files or a diff",
  running_command: "Running a shell command, build, install, or tool call",
  testing: "Running tests or reading test results",
  reviewing: "Reviewing or summarizing work already done",
  reporting: "Presenting a final answer, summary, or plan to the human",
  indeterminate: "The screen does not show enough to judge, or shows only chrome",
} as const;

export const REPETITION_OPTIONS = {
  yes: "The same attempt fails the same way in more than one observation",
  no: "The attempts differ, or a later observation shows new progress",
  insufficient_evidence: "Fewer than two observations, or they are too similar to tell",
} as const;

/** Acceptance policy constants, verbatim. */
export const CHOICE_CONFIDENCE_MIN = 0.8;
export const CHOICE_TOP_PROBABILITY_MIN = 0.8;
export const NOUL_ACCEPT_MIN = 0.9;
/**
 * The negative bar of the two-sided Noul contract.
 *
 * A literal `0.1`, NOT `1 - NOUL_ACCEPT_MIN`: in IEEE-754 double arithmetic
 * `1 - 0.9` is `0.09999999999999998`, so a derived bar makes a Noul of exactly
 * `0.1` abstain instead of publishing `no`. The held-out run contained two such
 * answers, and both were correct: the derived bar cost 2 of 9 correct negatives
 * and cut `turn_in_progress` coverage from 23.8% to 19.0%.
 *
 * The same arithmetic was checked across the other seat-awareness layers and
 * this file was the only one that derived a bar (workstream C's negative bar is
 * a literal `0.1`; B and D compute no bar at all). Anyone adding a bar later
 * should write the literal and pin the `0.1` edge, as `rescore.test.ts` does.
 *
 * The abstention band is the open interval `0.1 < p < 0.9`.
 */
export const NOUL_REJECT_MAX = 0.1;
export const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export const REQUESTED_MODEL = "jev-latest";
export const RETURNED_MODEL_IN_PARENT_RUNS = "jev-1.13.0";

const noul = (
  instructions: string,
  criteria: { readonly true: string; readonly false: string },
): NoulQuestion => ({ type: "noul", instructions, criteria });

const choice = (
  instructions: string,
  criteria: Readonly<Record<string, string | null>>,
): ChoiceQuestion => ({ type: "choice", instructions, criteria });

/**
 * `questionPack(ids)` — the exact pack. `ids` are the evidence-window ids the
 * `highlight_line` Choice may point at, plus `NONE`.
 */
export const questionPack = (ids: readonly string[]): QuestionMap => ({
  activity: choice(
    "What is the coding agent predominantly doing in `screen` right now, judged from its own visible output?",
    { ...ACTIVITY_OPTIONS },
  ),
  turn_in_progress: noul(
    "Judging from the live status chrome in `screen` (spinner, elapsed-time line, working footer, or an interrupt hint), is the agent currently executing a turn?",
    {
      true: "A live turn is in progress right now",
      false: "No turn is in progress: the seat is idle, finished, or waiting on a human",
    },
  ),
  approval_requested: noul(
    "Is the agent, at this moment, waiting for the human to approve a specific action before it can continue?",
    {
      true: "A live approval or permission prompt is on screen and unanswered",
      false: "No live approval prompt is pending",
    },
  ),
  answer_requested: noul(
    "Is the agent, at this moment, waiting for the human to answer a question or choose between options?",
    {
      true: "A live question or choice is posed to the human and unanswered",
      false: "No live question is pending",
    },
  ),
  access_problem: noul(
    "Is the agent, at this moment, blocked by an authentication, credential, or access problem?",
    {
      true: "A login, key, permission or access failure is the current obstacle",
      false: "No access problem is current",
    },
  ),
  execution_error: noul(
    "Does the latest visible execution attempt report an error or failure that has not yet been addressed?",
    {
      true: "The most recent command or tool run visibly failed",
      false: "The latest execution did not fail, or an older failure was already addressed",
    },
  ),
  repetition: choice(
    "Comparing only the observations supplied in `evidence`, is the agent repeating the same failing attempt rather than making progress?",
    { ...REPETITION_OPTIONS },
  ),
  highlight_exists: noul(
    "Does `screen` contain one line worth surfacing to the operator as the most informative thing happening right now?",
    { true: "At least one line carries real current signal", false: "Only chrome, empty space, or noise" },
  ),
  highlight_line: choice(
    "Which single line of `screen` is the most informative thing to surface to the operator right now?",
    Object.fromEntries([...ids.map((id) => [id, null] as const), ["NONE", "No line is worth surfacing"]]),
  ),
});

/**
 * The state object sent with every corpus-phase call, exactly as the parent's
 * script built it.
 */
export type AwarenessState = {
  readonly harness: string;
  readonly scenario: string;
  readonly checkpoint: string;
  readonly signals: { readonly title: string; readonly osc9: string };
  readonly evidence?: { readonly earlier: string; readonly now: string };
  readonly screen: string;
};

export const buildState = (input: {
  readonly harness: string;
  readonly scenario: string;
  readonly checkpoint: string;
  readonly signals: { readonly title: string; readonly osc9: string };
  readonly screen: IdLines;
  readonly earlier?: IdLines;
}): AwarenessState => ({
  harness: input.harness,
  scenario: input.scenario,
  checkpoint: input.checkpoint,
  signals: { title: input.signals.title, osc9: input.signals.osc9 },
  ...(input.earlier ? { evidence: { earlier: input.earlier.text, now: input.screen.text } } : {}),
  screen: input.screen.text,
});

/** What the parent's checkpoint label meant: end-of-capture or mid-turn. */
export const checkpointName = (cut: number, bytes: number): string =>
  cut === bytes ? "end-of-capture" : "mid-turn";
