/**
 * Awareness question pack (versioned) for the optional seat-awareness sidecar.
 *
 * WHAT THE SIDECAR IS
 * -------------------
 * The sidecar asks one small typed model (TypeSafe AI `systemone`, measured as
 * `jev-1.13.0`, p50 128ms) a fixed pack of narrow questions about a bounded
 * window of one managed terminal, and shows the answers as advisory display.
 * This file is the pack: the questions, their options, their acceptance
 * thresholds, and the code-side combination rules. It is the artifact the
 * operator reviews, so every threshold is a named constant here and every
 * question carries the failure mode it exists to catch.
 *
 * AUTHORITY BOUNDARY (binding)
 * ----------------------------
 * Awareness output is advisory display only. It may never feed the seat
 * evaluator, the seat state machine, the composer verdict, or any delivery
 * decision, and it may never set or clear a flag, mark a seat seen, or author
 * canvas state.
 * A concern is shown as "AI suggests checking approval", never as one of the
 * canonical control states and never as a flag. Awareness adds orthogonal
 * READ-ONLY axes beside them: AI activity, AI concerns, and assessment
 * availability. The canonical control states keep their own authority and
 * their own vocabulary; the awareness sources do not use that vocabulary at
 * all, and `tests/awareness-authority.test.ts` cements the ban along with the
 * import ban on the state engine, the drive, and IPC.
 *
 * THE MEASURED LESSON THIS PACK ENCODES
 * -------------------------------------
 * On 19 live calls over this repository's own corpus: a 7-way "what is the
 * agent doing" Choice was low-confidence on every genuinely working screen
 * (0.46 to 0.60) and agreed with screen truth 3/10, while a narrow
 * turn-in-progress Noul over the same evidence agreed 9/10 raw (7/10 accepted
 * at the 0.9 bar). Narrow property questions work; taxonomies over a thin
 * slice do not. So this pack asks NO taxonomy Choice:
 *
 *   - activity is a set of narrow property Nouls, combined in code by a fixed
 *     precedence (see ACTIVITY_DERIVATION) that never multiplies
 *     probabilities;
 *   - the only Choices are a 3-option temporal comparison and the highlight
 *     line, whose options are the supplied evidence itself;
 *   - the highlight Choice carries an explicit NONE, because always naming a
 *     line pins scrollback as a live ask;
 *   - the temporal comparison carries an explicit `insufficient_evidence` and
 *     declares a supplied-evidence requirement, because asking a temporal
 *     question without temporal evidence produced a false "repetition yes" on
 *     two seats.
 *
 * Also measured, and the reason the concerns are separate narrow Nouls rather
 * than one "needs the operator" label: a live permission dialog scored 0.97
 * while the same dialog scrolled into history scored 0.07; a fresh failure
 * scored 0.97 while an already-fixed failure scored 0.10; instruction text
 * inside terminal output moved no answer; a composer draft chip raised
 * nothing; and two identical failing windows read as repetition while two
 * different attempts did not.
 */

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Bump on ANY change to a question id, prompt, option, requirement, or
 * threshold. The version travels in every request and every assessment, so a
 * stored answer can always be traced to the pack that produced it.
 */
export const AWARENESS_PACK_VERSION = "awareness-pack/1";

// ---------------------------------------------------------------------------
// Read-only axes (orthogonal to the canonical control states)
// ---------------------------------------------------------------------------

/** What the agent appears to be doing. Advisory; never a control state. */
export type AiActivityValue =
  | "investigating"
  | "editing"
  | "running_command"
  | "testing"
  | "reviewing"
  | "reporting"
  | "indeterminate";

/** Something the operator may want to look at. Advisory; never a flag. */
export type AiConcernValue =
  | "approval_requested"
  | "answer_requested"
  | "access_problem"
  | "execution_error"
  | "repetition";

/**
 * Whether an assessment exists, is fresh, or was declined.
 * `unavailable` is "we could not obtain a usable answer" (transport, model, or
 * malformed answers); `abstained` is "the model answered and nothing met the
 * bar, or the evidence a question needs was not supplied". They are different
 * facts and the display must not merge them.
 */
export type AssessmentAvailability =
  | "not_assessed"
  | "current"
  | "stale"
  | "abstained"
  | "unavailable";

export const AI_ACTIVITY_VALUES: readonly AiActivityValue[] = [
  "investigating",
  "editing",
  "running_command",
  "testing",
  "reviewing",
  "reporting",
  "indeterminate",
] as const;

export const AI_CONCERN_VALUES: readonly AiConcernValue[] = [
  "approval_requested",
  "answer_requested",
  "access_problem",
  "execution_error",
  "repetition",
] as const;

export const ASSESSMENT_AVAILABILITY_VALUES: readonly AssessmentAvailability[] = [
  "not_assessed",
  "current",
  "stale",
  "abstained",
  "unavailable",
] as const;

/**
 * Advisory display phrases. A concern is NEVER rendered as the canonical
 * control state or as a flag: the operator sees a suggestion to look, and the
 * control state keeps its own authority.
 */
export const CONCERN_DISPLAY: Readonly<Record<AiConcernValue, string>> = {
  approval_requested: "AI suggests checking approval",
  answer_requested: "AI suggests checking a question",
  access_problem: "AI suggests checking access",
  execution_error: "AI suggests checking a failure",
  repetition: "AI suggests checking a repeat",
};

/**
 * Advisory display phrases for an ACCEPTED absence: the model looked at this
 * concern and found nothing. Display only; nothing is cleared.
 */
export const CONCERN_ABSENT_DISPLAY: Readonly<Record<AiConcernValue, string>> = {
  approval_requested: "AI found no approval prompt",
  answer_requested: "AI found no question",
  access_problem: "AI found no access problem",
  execution_error: "AI found no failure",
  repetition: "AI found no repeat",
};

// ---------------------------------------------------------------------------
// Acceptance thresholds — the one place a human calibrates this pack
// ---------------------------------------------------------------------------

/**
 * Starting acceptance policy, to calibrate rather than to trust:
 *
 *   - a Choice is accepted at confidence >= 0.8 AND top probability >= 0.8;
 *   - a Noul is accepted at probability >= 0.9 (the measured narrow-Noul bar:
 *     9/10 raw agreement, 7/10 accepted);
 *   - anything else abstains and the abstention is reported, never silently
 *     dropped and never rounded up into a concern.
 *
 * Independently evaluated questions are NOT independent evidence: never
 * multiply their probabilities. Combination is a fixed precedence in code
 * (ACTIVITY_DERIVATION), and every reported probability is the model's own
 * number for that one question.
 */
export const AWARENESS_ACCEPTANCE = {
  /** Noul acceptance bar. */
  noulProbability: 0.9,
  /** Choice acceptance bar: model confidence in the selection. */
  choiceConfidence: 0.8,
  /** Choice acceptance bar: probability mass on the selected option. */
  choiceTopProbability: 0.8,
} as const;

/** Which acceptance policy a question uses. */
export type AcceptancePolicy = "noul" | "choice" | "concern_choice";

export type AcceptanceThresholds = {
  /** Minimum Noul probability. Absent for Choices. */
  readonly minNoulProbability?: number;
  /** Minimum Choice confidence. Absent for Nouls. */
  readonly minConfidence?: number;
  /** Minimum probability on the selected Choice option. Absent for Nouls. */
  readonly minTopProbability?: number;
};

/** Resolved thresholds per policy. Derived from AWARENESS_ACCEPTANCE. */
export const ACCEPTANCE_POLICIES: Readonly<Record<AcceptancePolicy, AcceptanceThresholds>> = {
  noul: { minNoulProbability: AWARENESS_ACCEPTANCE.noulProbability },
  choice: {
    minConfidence: AWARENESS_ACCEPTANCE.choiceConfidence,
    minTopProbability: AWARENESS_ACCEPTANCE.choiceTopProbability,
  },
  concern_choice: {
    // A concern is held to the Noul bar even when it is expressed as a Choice:
    // "is this repeating" is the same kind of snap judgment as "is a failure
    // live", and the measured false positive came from answering it cheaply.
    minConfidence: AWARENESS_ACCEPTANCE.noulProbability,
    minTopProbability: AWARENESS_ACCEPTANCE.noulProbability,
  },
};

/** How long an accepted assessment stays `current` before it reads `stale`. */
export const AWARENESS_FRESHNESS_BUDGET_MS = 30_000;

// ---------------------------------------------------------------------------
// Evidence contract (format shared with the projection)
// ---------------------------------------------------------------------------

/**
 * Evidence line id format: `L000`, `L001`, … assigned by the projection to the
 * lines actually sent, bottom-anchored (the newest line carries the highest
 * id). The id is scoped to ONE observation: a later screen has its own ids,
 * and an id from a later screen must never resolve against an earlier mapping.
 */
export const EVIDENCE_LINE_ID_PREFIX = "L";

export const formatEvidenceLineId = (index: number): string =>
  `${EVIDENCE_LINE_ID_PREFIX}${Math.trunc(index).toString().padStart(3, "0")}`;

/** Maximum candidate lines the projection may consider for one request. */
export const MAX_EVIDENCE_CANDIDATE_LINES = 128;

/** Evidence bytes (the rendered `L000| text` block) for one request. */
export const MAX_EVIDENCE_BYTES = 32 * 1024;

/** Total serialized-request bytes, a separate cap above the evidence cap. */
export const MAX_REQUEST_BYTES = 64 * 1024;

/** Decline option for the highlight Choice: no line stands out. */
export const HIGHLIGHT_NONE_OPTION_ID = "NONE";

/** Decline option for a temporal Choice: the evidence cannot settle it. */
export const INSUFFICIENT_EVIDENCE_OPTION_ID = "insufficient_evidence";

/**
 * Extra evidence a question needs beyond a non-empty window. A question whose
 * requirement is not met is NOT asked, and its axis reports the gap instead of
 * a guess.
 */
export type EvidenceRequirement =
  /** The projection found two comparable attempt blocks in the window. */
  | "temporal_pair";

// ---------------------------------------------------------------------------
// Question shapes
// ---------------------------------------------------------------------------

export type ChoiceOption = {
  readonly id: string;
  /** Operator-readable meaning; also the model's label for the option. */
  readonly label: string;
  /**
   * Selecting this option is a DECLINE, not an answer: the axis reports an
   * abstention rather than a value.
   */
  readonly declines?: boolean;
};

type AwarenessQuestionBase = {
  readonly id: string;
  /** Higher survives a total-request-cap squeeze. */
  readonly priority: number;
  /** The exact text the model receives for this question. */
  readonly prompt: string;
  /** Evidence needed beyond a non-empty window. */
  readonly requires: readonly EvidenceRequirement[];
  /** Named acceptance policy; thresholds resolve through ACCEPTANCE_POLICIES. */
  readonly acceptance: AcceptancePolicy;
  /** The failure mode this question exists to catch (operator review). */
  readonly failureMode: string;
};

export type NoulQuestion = AwarenessQuestionBase & {
  readonly kind: "noul";
  /** Set when this Noul is a concern signal. */
  readonly concern?: AiConcernValue;
  /** Set when this Noul is an activity signal. */
  readonly activity?: AiActivityValue;
};

export type ChoiceQuestion = AwarenessQuestionBase & {
  readonly kind: "choice";
  /**
   * `static` — options are declared here. `evidence_lines` — options are the
   * evidence line ids of THIS observation plus the declared decline option.
   */
  readonly optionSource: "static" | "evidence_lines";
  /** Declared options. For `evidence_lines`, only decline options live here. */
  readonly options: readonly ChoiceOption[];
  /** Set when this Choice is a concern signal. */
  readonly concern?: AiConcernValue;
  /** `highlight` names one evidence line; `concern` answers a concern axis. */
  readonly role: "highlight" | "concern";
};

export type AwarenessQuestion = NoulQuestion | ChoiceQuestion;

// ---------------------------------------------------------------------------
// Code-side combination: activity is a precedence over narrow properties
// ---------------------------------------------------------------------------

/**
 * How the narrow activity Nouls become one activity value. This is a
 * PRECEDENCE, not a product: the first accepted question in this order wins,
 * and the reported probability is that question's own number, unchanged. That
 * is the documented way to combine a judgment that depends on several factors
 * when the questions are not independent evidence.
 *
 * Order rationale, most operator-relevant first:
 *   reporting        — the agent believes the turn is done and is waiting;
 *   reviewing        — a verdict is being formed about a specific change;
 *   testing          — a checkpoint the operator often wants to see;
 *   editing          — a mutation is in flight, so interrupting is costly;
 *   running_command  — work is executing;
 *   investigating    — read-only exploration, the least urgent to interrupt.
 */
export type ActivityDerivation = {
  readonly questionId: string;
  readonly value: AiActivityValue;
  readonly why: string;
};

export const ACTIVITY_DERIVATION: readonly ActivityDerivation[] = [
  {
    questionId: "activity.reporting_to_operator",
    value: "reporting",
    why: "the agent believes it is finished and is waiting on the operator",
  },
  {
    questionId: "activity.reviewing_a_change",
    value: "reviewing",
    why: "a specific change is under review, so a verdict is forming",
  },
  {
    questionId: "activity.tests_running",
    value: "testing",
    why: "a suite is the natural checkpoint before the next step",
  },
  {
    questionId: "activity.files_being_written",
    value: "editing",
    why: "a mutation is in flight, so interrupting is expensive",
  },
  {
    questionId: "activity.command_executing",
    value: "running_command",
    why: "work is executing but is not identifiable as a test run",
  },
  {
    questionId: "activity.reading_existing_material",
    value: "investigating",
    why: "read-only exploration, the cheapest state to interrupt",
  },
];

// ---------------------------------------------------------------------------
// The pack
// ---------------------------------------------------------------------------

/**
 * Activity properties — narrow Nouls, combined in code.
 *
 * This group replaces the measured failure: one 7-way "what is the agent
 * doing" Choice scored 0.46 to 0.60 on genuinely working screens and matched
 * screen truth 3/10. Each entry below asks ONE visible property, which is the
 * shape that agreed 9/10.
 */
const ACTIVITY_QUESTIONS: readonly NoulQuestion[] = [
  {
    id: "activity.command_executing",
    kind: "noul",
    activity: "running_command",
    priority: 50,
    acceptance: "noul",
    requires: [],
    prompt:
      "Right now, is a command, tool call, or subprocess visibly executing in the evidence " +
      "(streaming output, a progress or spinner line, or a running step indicator), rather than " +
      "the agent thinking, or the turn being finished? Answer with your probability that this is true.",
    // Failure mode: the taxonomy collapse (see the file header) and both
    // directions of the busy/idle lie. A stale working title with an idle
    // progress flag is NOT visible execution; a live spinner over an empty
    // composer IS. Asking about visible execution, not about title chrome, is
    // what keeps those apart.
    failureMode:
      "the measured 7-way activity taxonomy (0.46 to 0.60 on working screens); also the false-busy receipt (stale title, no live execution) and the false-idle receipt (live spinner over an empty composer)",
  },
  {
    id: "activity.tests_running",
    kind: "noul",
    activity: "testing",
    priority: 52,
    acceptance: "noul",
    requires: [],
    prompt:
      "Does the evidence show a test runner or test suite being invoked or reporting results " +
      "(for example a test command line, a per-test pass or fail list, or a test summary), " +
      "rather than ordinary command output? Answer with your probability that this is true.",
    // Failure mode: a test run is the checkpoint the operator most often wants
    // to catch, but a generic "running a command" label hides it. Without this
    // question the axis cannot tell a build log from a suite that is about to
    // need a decision.
    failureMode:
      "a test run read as generic command execution, so the operator misses the checkpoint the suite marks",
  },
  {
    id: "activity.files_being_written",
    kind: "noul",
    activity: "editing",
    priority: 54,
    acceptance: "noul",
    requires: [],
    prompt:
      "Does the evidence show the agent writing or modifying files (a diff or patch being " +
      "applied, an edit tool result, a file write confirmation), rather than only reading or " +
      "searching? Answer with your probability that this is true.",
    // Failure mode: conflating read-only exploration with mutation. The
    // operator can interrupt a search cheaply and cannot interrupt a write
    // cheaply. This is also the signal that separates editing from
    // investigating without a taxonomy call.
    failureMode:
      "read-only exploration read as mutation (and the reverse), so the operator misjudges whether interrupting is safe",
  },
  {
    id: "activity.reading_existing_material",
    kind: "noul",
    activity: "investigating",
    priority: 56,
    acceptance: "noul",
    requires: [],
    prompt:
      "Does the evidence show the agent reading, searching, or listing existing material " +
      "(file reads, grep or search results, directory listings) with no sign of writing? " +
      "Answer with your probability that this is true.",
    // Failure mode: the read-only half of the axis. Alone it is ambiguous, so
    // it is the LOWEST precedence entry and only speaks when no write or
    // execution signal was accepted. It exists because a thin slice almost
    // never contains a self-describing label such as "investigating".
    failureMode:
      "a read-only turn reported as no activity at all, because no visible line self-describes as investigation",
  },
  {
    id: "activity.reviewing_a_change",
    kind: "noul",
    activity: "reviewing",
    priority: 58,
    acceptance: "noul",
    requires: [],
    prompt:
      "Does the evidence show the agent reviewing a specific change (reading a diff, patch, " +
      "pull request, or review comment) rather than exploring a codebase or writing code? " +
      "Answer with your probability that this is true.",
    // Failure mode: a code review is a distinct operator checkpoint (a verdict
    // is being formed), and folding it into investigating hides that. Narrow by
    // construction: it asks about a change under review, not about review as a
    // general activity.
    failureMode:
      "a review of a specific change reported as generic exploration, so the operator does not know a verdict is being formed",
  },
  {
    id: "activity.reporting_to_operator",
    kind: "noul",
    activity: "reporting",
    priority: 60,
    acceptance: "noul",
    requires: [],
    prompt:
      "Is the agent producing a final summary, report, or handoff for the operator (a " +
      "conclusion, a list of what changed, a done or blocked statement), rather than mid-task " +
      "work? Answer with your probability that this is true.",
    // Failure mode: the end of a turn looks like any other output. Without this
    // the operator cannot tell "still working" from "believes it is finished
    // and is waiting", which is the moment advisory display is most useful.
    failureMode:
      "a finished turn read as continuing work, so the operator does not notice the agent is waiting",
  },
];

/**
 * Concern properties — narrow Nouls, each with the scrolled-away or
 * already-addressed case named in the prompt, because those are the two
 * measured ways a stale line becomes a false concern.
 */
const CONCERN_QUESTIONS: readonly NoulQuestion[] = [
  {
    id: "concern.approval_requested",
    kind: "noul",
    concern: "approval_requested",
    priority: 100,
    acceptance: "noul",
    requires: [],
    prompt:
      "Does the bottom of the evidence currently show a live approval or permission prompt " +
      "that the agent is blocked on and that no one has answered yet? A prompt that has " +
      "scrolled into history, or that already shows an answer, is not live. Answer with your " +
      "probability that a live unanswered approval prompt is present.",
    // Failure mode: measured — the live permission dialog scored 0.97 while the
    // same dialog scrolled into history scored 0.07. Naming the scrolled-away
    // case in the prompt is what keeps history from being shown as a live ask.
    failureMode:
      "a permission dialog scrolled into history (or already answered) presented as a live approval request",
  },
  {
    id: "concern.answer_requested",
    kind: "noul",
    concern: "answer_requested",
    priority: 95,
    acceptance: "noul",
    requires: [],
    prompt:
      "Is the agent asking the operator a question that needs a typed or free-form answer, as " +
      "opposed to offering a menu of options to select? Answer with your probability that an " +
      "open question to the operator is present.",
    // Failure mode: a menu approval and an open question have different
    // operator affordances. Collapsing them into one "needs you" signal sends
    // the operator looking for a key to press when the agent wants prose.
    failureMode:
      "a menu selection and an open question collapsed into one signal, so the operator looks for the wrong response",
  },
  {
    id: "concern.access_problem",
    kind: "noul",
    concern: "access_problem",
    priority: 95,
    acceptance: "noul",
    requires: [],
    prompt:
      "Does the evidence currently show an access failure that blocks progress " +
      "(authentication required, login expired, permission denied, credentials missing, a 401 " +
      "or 403), as opposed to an ordinary command failure? Answer with your probability that " +
      "such an access failure is present.",
    // Failure mode: the corpus records a real "blocked: auth: login required"
    // capture. An access problem needs the operator's credentials and will
    // never clear on its own, so reading it as an ordinary error leaves a seat
    // stalled with no visible reason.
    failureMode:
      "an access failure read as an ordinary error, so a seat stalls with no visible reason and no way for the agent to recover",
  },
  {
    id: "concern.execution_error",
    kind: "noul",
    concern: "execution_error",
    priority: 90,
    acceptance: "noul",
    requires: [],
    prompt:
      "Does the bottom of the evidence currently show a failure from a command, build, or test " +
      "that is still unaddressed (the failing output is the most recent relevant result, with " +
      "no later successful run or fix below it)? A failure that a later success or fix has " +
      "already addressed is not live. Answer with your probability that a live unaddressed " +
      "failure is present.",
    // Failure mode: measured — a fresh failure scored 0.97 while an
    // already-fixed failure scored 0.10. The evidence window is bottom-anchored,
    // so any fix is newer than the failure and therefore inside the window
    // whenever the failure is; that is what makes this freshness judgment
    // answerable without extra temporal evidence. The prompt names the fixed
    // case so the model does not read scrollback as live.
    failureMode:
      "an already-fixed failure presented as a live error, or a live failure missed because a later line looked like a fix",
  },
];

/**
 * Temporal concern — a small Choice, because the judgment is a comparison of
 * two supplied attempts and a probability alone cannot say "the evidence
 * cannot settle this".
 */
const TEMPORAL_QUESTIONS: readonly ChoiceQuestion[] = [
  {
    id: "concern.repetition",
    kind: "choice",
    role: "concern",
    concern: "repetition",
    priority: 85,
    acceptance: "concern_choice",
    // The measured false positive: this question asked without temporal
    // evidence produced a false "repetition yes" on two seats. The requirement
    // is enforced in the projection: without two comparable attempt blocks the
    // question is not asked and the axis reports insufficient_evidence.
    requires: ["temporal_pair"],
    optionSource: "static",
    options: [
      { id: "repeats", label: "the second attempt repeats the first in the same way" },
      { id: "different", label: "the second attempt is a different attempt" },
      {
        id: INSUFFICIENT_EVIDENCE_OPTION_ID,
        label: "the supplied evidence cannot settle this",
        declines: true,
      },
    ],
    prompt:
      "Two comparable attempts from the evidence are named in the note below it. Comparing " +
      "only those two attempts, does the second repeat the first in the same way (the same " +
      "failure, the same error, the same stuck step), rather than being a different attempt? " +
      "Choose the option that fits best, and choose insufficient_evidence if the supplied " +
      "evidence cannot settle it.",
    // Failure mode: a seat looping on the same failing action looks busy and
    // healthy, so nothing else in the product says "this is stuck". The cost of
    // a false positive is high (the operator is pulled to a seat that is fine),
    // which is why this is the one concern held to the temporal-evidence
    // requirement and why the decline option is explicit.
    failureMode:
      "a seat looping on the same failing action read as ordinary work; and the measured false positive where a temporal question asked without temporal evidence answered yes",
  },
];

/**
 * Highlight — one evidence line, or an explicit NONE.
 *
 * This is the only wide option set in the pack. It is a selection over the
 * supplied evidence, not a taxonomy over a thin slice: the options are the
 * lines the model can see, and the judgment is a single "which one". Choice
 * supports up to 255 options and the candidate cap keeps this at 129.
 */
const HIGHLIGHT_QUESTIONS: readonly ChoiceQuestion[] = [
  {
    id: "highlight.line",
    kind: "choice",
    role: "highlight",
    priority: 80,
    acceptance: "choice",
    requires: [],
    optionSource: "evidence_lines",
    options: [
      {
        id: HIGHLIGHT_NONE_OPTION_ID,
        label: "no line stands out",
      },
    ],
    prompt:
      "The evidence above is a bottom-anchored window of one agent's terminal, one entry per " +
      "line, tagged `L000| text`. Which single line, if any, shows the live thing the operator " +
      "should look at first right now (a question, prompt, error, or decision the agent is " +
      "waiting on)? Choose NONE if no line stands out, or if the important thing is not in the " +
      "evidence.",
    // Failure mode: a model asked to name a line will name one, and scrollback
    // history then reads as a live ask. The explicit NONE is the escape hatch
    // that makes declining representable, which is what the measured
    // adversarial cases show the model uses when it exists.
    failureMode:
      "scrollback history pinned as the live ask because no way to decline was offered",
  },
];

/** The pack, in review order. */
export const AWARENESS_QUESTIONS: readonly AwarenessQuestion[] = [
  ...CONCERN_QUESTIONS,
  ...TEMPORAL_QUESTIONS,
  ...HIGHLIGHT_QUESTIONS,
  ...ACTIVITY_QUESTIONS,
];

export const AWARENESS_QUESTION_IDS: readonly string[] = AWARENESS_QUESTIONS.map((q) => q.id);

const QUESTION_BY_ID = new Map(AWARENESS_QUESTIONS.map((q) => [q.id, q]));

export const awarenessQuestion = (id: string): AwarenessQuestion | undefined =>
  QUESTION_BY_ID.get(id);

/** Resolved acceptance thresholds for one question. */
export const acceptanceThresholdsFor = (
  question: AwarenessQuestion,
): AcceptanceThresholds => ACCEPTANCE_POLICIES[question.acceptance];

// ---------------------------------------------------------------------------
// Evidence availability — what the projection must certify before asking
// ---------------------------------------------------------------------------

/** What the projection could certify about the evidence for one observation. */
export type EvidenceAvailability = {
  /** Evidence lines actually sent. Zero means nothing to judge. */
  readonly evidenceLines: number;
  /** The projection found two comparable attempt blocks in the window. */
  readonly temporalPair: boolean;
};

/**
 * Whether a question may be asked at all. An unaskable question is reported as
 * an abstention with reason `evidence_unavailable`, never asked with the
 * evidence missing, and never answered by inference.
 */
export const isQuestionAskable = (
  question: AwarenessQuestion,
  availability: EvidenceAvailability,
): boolean => {
  if (availability.evidenceLines <= 0) return false;
  for (const requirement of question.requires) {
    if (requirement === "temporal_pair" && !availability.temporalPair) return false;
  }
  return true;
};

/**
 * The prompt the model receives for one observation: the pack prompt plus the
 * option list when the options are built from the evidence. Keeping the
 * rendered text here means the operator reviews exactly what is sent.
 */
export const renderQuestionPrompt = (
  question: AwarenessQuestion,
  evidenceLineIds: readonly string[],
): string => {
  if (question.kind !== "choice") return question.prompt;
  if (question.optionSource === "static") {
    const lines = question.options.map((o) => `- ${o.id}: ${o.label}`);
    return `${question.prompt}\nOptions:\n${lines.join("\n")}`;
  }
  const ids = [...evidenceLineIds, HIGHLIGHT_NONE_OPTION_ID];
  return `${question.prompt}\nOptions: ${ids.join(", ")}`;
};

/**
 * Option ids permitted for one question in one observation. The comparison
 * question offers its declared options; the highlight offers the evidence line
 * ids of THIS observation plus the explicit decline.
 */
export const permittedOptionIds = (
  question: AwarenessQuestion,
  evidenceLineIds: readonly string[],
): readonly string[] => {
  if (question.kind !== "choice") return [];
  if (question.optionSource === "static") return question.options.map((option) => option.id);
  return [...evidenceLineIds, ...question.options.map((option) => option.id)];
};
