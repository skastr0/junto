/**
 * Zero-cost re-scoring of a stored comparison report.
 *
 * The paid run's raw answers are the expensive part; the acceptance policy is
 * free to re-apply. This module reads a report written by `run-live.ts`, re-derives
 * every verdict under a given policy, and reports COVERAGE and ERRORS per
 * question rather than a single agreement count — because a pack that publishes
 * nothing is not accurate, it is silent.
 *
 * It also answers the contract's one control-plane question: for
 * `turn_in_progress`, a published negative is a cross-check against the
 * deterministic engine, not a displayed state, so the re-score compares the
 * published value with the seat state the real `SeatStateRuntime` held at the
 * same cut. That needs a replay, not a model call.
 *
 * Run:
 *   bun tests/pty-e2e/jev/rescore.ts --report <compare-*.json> [--sweep] [--cross-check]
 */

import { loadManifest } from "./manifest-file";
import type { Answer } from "./live-client";
import { applyAcceptance, type Verdict } from "./live-client";
import {
  CHOICE_CONFIDENCE_MIN,
  CHOICE_TOP_PROBABILITY_MIN,
  NOUL_ACCEPT_MIN,
  NOUL_REJECT_MAX,
  PACK_IDS,
  type PackId,
} from "./pack";
import { replayCapture } from "./replay";
import type { LabelVector } from "./types";

/** The subset of `run-live.ts`'s report the re-score needs. */
export type StoredRow = {
  readonly checkpointId: string;
  readonly harness: string;
  readonly scenario: string;
  readonly class: string;
  readonly model: string;
  readonly answers: Readonly<Record<string, Answer>>;
  readonly labels: LabelVector;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly error?: string;
};

export type StoredReport = {
  readonly generatedAt: string;
  readonly split: string;
  readonly model: string;
  readonly rows: readonly StoredRow[];
  readonly totals: Readonly<Record<string, number>>;
};

export type RescorePolicy = {
  readonly positiveBar: number;
  readonly negativeBar: number;
  readonly choiceConfidence: number;
  readonly choiceTop: number;
};

/** The contract's policy: two-sided Noul, choice at 0.8 and 0.8. */
export const CONTRACT_POLICY: RescorePolicy = {
  positiveBar: NOUL_ACCEPT_MIN,
  negativeBar: NOUL_REJECT_MAX,
  choiceConfidence: CHOICE_CONFIDENCE_MIN,
  choiceTop: CHOICE_TOP_PROBABILITY_MIN,
};

/** The single-sided policy the parent's first sweep replaced. */
export const SINGLE_SIDED_POLICY: RescorePolicy = {
  positiveBar: NOUL_ACCEPT_MIN,
  negativeBar: -1,
  choiceConfidence: CHOICE_CONFIDENCE_MIN,
  choiceTop: CHOICE_TOP_PROBABILITY_MIN,
};

export type LabelJoin = {
  readonly joined: number;
  /** Rows whose checkpoint the current manifest no longer lists. */
  readonly storedOnly: number;
  readonly storedOnlyIds: readonly string[];
};

export type QuestionOutcome = {
  readonly id: PackId;
  readonly total: number;
  /** Rows where the model published a verdict. */
  readonly published: number;
  readonly abstained: number;
  /** Published and equal to a discriminating label. */
  readonly correct: number;
  /** Published and different from a discriminating label. */
  readonly wrong: number;
  /** Published on a label that is `insufficient_evidence`. */
  readonly unfalsifiable: number;
  /**
   * Published the pack's own "no signal" option where the label says the same
   * thing (`activity = indeterminate`, `repetition = insufficient_evidence`).
   * Agreement here is agreement on having nothing to say, never evidence of
   * classification.
   */
  readonly vacuous: number;
  /** Rows whose label is `insufficient_evidence` (grounded or not). */
  readonly labelInsufficient: number;
  /** published / total, as a percentage of the rows in the report. */
  readonly coveragePct: number;
  /** correct / (correct + wrong), or null when nothing discriminating published. */
  readonly accuracyPct: number | null;
  /** The per-row published values, for review. */
  readonly publishedValues: Readonly<Record<string, number>>;
};

/** Labels that carry a discriminating claim, versus the pack's "no signal" ones. */
const NO_SIGNAL: Readonly<Partial<Record<PackId, string>>> = {
  activity: "indeterminate",
  repetition: "insufficient_evidence",
};

/**
 * The label a row is scored against.
 *
 * The paid report froze the labels as they were when it ran. A re-score must use
 * the CURRENT manifest, or a label correction could never take effect and the
 * report would keep comparing against a ground truth that has since moved. Rows
 * whose checkpoint is no longer in the manifest fall back to the stored label
 * and are counted in `labelJoin.storedOnly`, so a stale join is visible rather
 * than silent.
 */
let manifestLabels: Map<string, LabelVector> | undefined;

const labelsOf = (row: StoredRow): LabelVector => {
  if (manifestLabels === undefined) {
    manifestLabels = new Map(loadManifest().checkpoints.map((checkpoint) => [checkpoint.id, checkpoint.labels]));
  }
  return manifestLabels.get(row.checkpointId) ?? row.labels;
};

const labelJoinOf = (rows: readonly StoredRow[]): LabelJoin => {
  if (manifestLabels === undefined) {
    manifestLabels = new Map(loadManifest().checkpoints.map((checkpoint) => [checkpoint.id, checkpoint.labels]));
  }
  const storedOnlyIds = rows
    .filter((row) => !manifestLabels!.has(row.checkpointId))
    .map((row) => row.checkpointId);
  return {
    joined: rows.length - storedOnlyIds.length,
    storedOnly: storedOnlyIds.length,
    storedOnlyIds,
  };
};

export const rescoreRow = (
  row: StoredRow,
  policy: RescorePolicy,
): Readonly<Record<string, Verdict>> => {
  const verdicts: Record<string, Verdict> = {};
  for (const id of PACK_IDS) {
    const answer = row.answers[id];
    if (answer === undefined) continue;
    verdicts[id] = applyAcceptance(id, answer, {
      positiveBar: policy.positiveBar,
      negativeBar: policy.negativeBar,
      ...(id === "highlight_line" ? { allowedChoices: [...idsOf(row), "NONE"] } : {}),
    });
  }
  return verdicts;
};

/**
 * The window ids a `highlight_line` answer may point at. The stored report does
 * not carry the id list, so it is read from the committed manifest's window
 * metadata for the same checkpoint — the same 128-cap rule that produced it.
 */
let windowCache: Map<string, readonly string[]> | undefined;

const idsOf = (row: StoredRow): readonly string[] => {
  if (windowCache === undefined) {
    windowCache = new Map(
      loadManifest().checkpoints.map((checkpoint) => [
        checkpoint.id,
        Array.from(
          { length: checkpoint.window.candidateLines },
          (_, i) => `L${String(i).padStart(3, "0")}`,
        ),
      ]),
    );
  }
  return windowCache.get(row.checkpointId) ?? [];
};

export const rescore = (
  report: StoredReport,
  policy: RescorePolicy = CONTRACT_POLICY,
): { readonly outcomes: readonly QuestionOutcome[]; readonly labelJoin: LabelJoin } => {
  const rows = report.rows.filter((row) => row.error === undefined);
  const labelJoin = labelJoinOf(rows);
  const outcomes = PACK_IDS.map((id) => {
    let published = 0;
    let abstained = 0;
    let correct = 0;
    let wrong = 0;
    let unfalsifiable = 0;
    let vacuous = 0;
    let labelInsufficient = 0;
    const publishedValues: Record<string, number> = {};
    for (const row of rows) {
      const label = labelsOf(row)[id];
      if (label === undefined) continue;
      if (label.value === "insufficient_evidence") labelInsufficient += 1;
      const verdict = rescoreRow(row, policy)[id];
      if (verdict === undefined || verdict.verdict !== "accepted" || verdict.value === undefined) {
        abstained += 1;
        continue;
      }
      published += 1;
      publishedValues[verdict.value] = (publishedValues[verdict.value] ?? 0) + 1;
      if (label.value === "insufficient_evidence") {
        unfalsifiable += 1;
        continue;
      }
      if (NO_SIGNAL[id] === label.value && verdict.value === label.value) {
        vacuous += 1;
        continue;
      }
      if (verdict.value === label.value) correct += 1;
      else wrong += 1;
    }
    const total = rows.length;
    return {
      id,
      total,
      published,
      abstained,
      correct,
      wrong,
      unfalsifiable,
      vacuous,
      labelInsufficient,
      coveragePct: total === 0 ? 0 : Number(((published / total) * 100).toFixed(1)),
      accuracyPct: correct + wrong === 0 ? null : Number(((correct / (correct + wrong)) * 100).toFixed(1)),
      publishedValues,
    };
  });
  return { outcomes, labelJoin };
};

export type SweepPoint = {
  readonly positiveBar: number;
  readonly negativeBar: number;
  readonly published: number;
  readonly correct: number;
  readonly wrong: number;
  readonly unfalsifiable: number;
  readonly vacuous: number;
};

/** Sweep the two Noul bars over the stored answers, at zero cost. */
export const sweep = (
  report: StoredReport,
  bars: readonly { readonly positiveBar: number; readonly negativeBar: number }[],
): Readonly<Record<string, readonly SweepPoint[]>> => {
  const rows = report.rows.filter((row) => row.error === undefined);
  const noulQuestions = PACK_IDS.filter((id) => rows.some((row) => row.answers[id]?.type === "noul"));
  const out: Record<string, SweepPoint[]> = {};
  for (const id of noulQuestions) {
    out[id] = bars.map((bar) => {
      const policy: RescorePolicy = {
        positiveBar: bar.positiveBar,
        negativeBar: bar.negativeBar,
        choiceConfidence: CHOICE_CONFIDENCE_MIN,
        choiceTop: CHOICE_TOP_PROBABILITY_MIN,
      };
      let published = 0;
      let correct = 0;
      let wrong = 0;
      let unfalsifiable = 0;
      let vacuous = 0;
      for (const row of rows) {
        const label = labelsOf(row)[id];
        const verdict = rescoreRow(row, policy)[id];
        if (verdict === undefined || verdict.verdict !== "accepted" || verdict.value === undefined) continue;
        published += 1;
        if (label.value === "insufficient_evidence") {
          unfalsifiable += 1;
          continue;
        }
        if (NO_SIGNAL[id] === label.value && verdict.value === label.value) {
          vacuous += 1;
          continue;
        }
        if (verdict.value === label.value) correct += 1;
        else wrong += 1;
      }
      return {
        positiveBar: bar.positiveBar,
        negativeBar: bar.negativeBar,
        published,
        correct,
        wrong,
        unfalsifiable,
        vacuous,
      };
    });
  }
  return out;
};

export type ControlPlaneRow = {
  readonly checkpointId: string;
  readonly controlState: string;
  readonly controlReason: string;
  readonly published: "yes" | "no" | "abstain";
  readonly noul: number | undefined;
  readonly agreesWithControl: boolean | null;
};

export type ControlPlaneCrossCheck = {
  readonly rows: readonly ControlPlaneRow[];
  readonly summary: {
    readonly compared: number;
    readonly publishedYes: number;
    readonly publishedNo: number;
    readonly agreed: number;
    readonly disagreed: number;
    /** Rows where the model published and the control plane had no state. */
    readonly ungrounded: number;
  };
};

const cutOf = (checkpointId: string): number => {
  const index = checkpointId.lastIndexOf("#");
  return Number(checkpointId.slice(index + 1));
};

/**
 * Cross-check the published `turn_in_progress` against the control plane.
 *
 * `turn_in_progress` is the one question the contract gives a non-display
 * disposition: the deterministic engine owns idle versus working, so an
 * advisory negative is a cross-check, and a disagreement is the interesting
 * measurement. One replay per capture, no model calls.
 */
export const crossCheckTurnInProgress = async (
  report: StoredReport,
  opts: { readonly fractionSteps: number; readonly policy?: RescorePolicy } = { fractionSteps: 400 },
): Promise<ControlPlaneCrossCheck> => {
  const policy = opts.policy ?? CONTRACT_POLICY;
  const rows = report.rows.filter((row) => row.error === undefined);
  const byCapture = new Map<string, StoredRow[]>();
  for (const row of rows) {
    const key = `${row.harness}/${row.scenario}`;
    const list = byCapture.get(key);
    if (list) list.push(row);
    else byCapture.set(key, [row]);
  }

  const states = new Map<string, { state: string; reason: string }>();
  for (const [key, group] of byCapture) {
    const [harness, scenario] = key.split("/") as [string, string];
    const wanted = new Set(group.map((row) => cutOf(row.checkpointId)));
    await replayCapture({
      harness,
      scenario,
      fractionSteps: opts.fractionSteps,
      onStep: (step) => {
        if (wanted.has(step.cut)) {
          states.set(`${key}#${step.cut}`, {
            state: step.seatState ?? "unknown",
            reason: step.seatReason ?? "",
          });
        }
      },
    });
  }

  const out: ControlPlaneRow[] = [];
  let publishedYes = 0;
  let publishedNo = 0;
  let agreed = 0;
  let disagreed = 0;
  let ungrounded = 0;
  for (const row of rows) {
    const verdict = rescoreRow(row, policy).turn_in_progress;
    const published = verdict?.verdict === "accepted" ? (verdict.value as "yes" | "no") : "abstain";
    if (published === "yes") publishedYes += 1;
    if (published === "no") publishedNo += 1;
    const control = states.get(row.checkpointId);
    const controlWorking = control?.state === "working";
    let agrees: boolean | null = null;
    if (published === "abstain") agrees = null;
    else if (control === undefined) {
      ungrounded += 1;
      agrees = null;
    } else {
      agrees = published === (controlWorking ? "yes" : "no");
      if (agrees) agreed += 1;
      else disagreed += 1;
    }
    out.push({
      checkpointId: row.checkpointId,
      controlState: control?.state ?? "unknown",
      controlReason: control?.reason ?? "",
      published,
      noul: row.answers.turn_in_progress?.type === "noul" ? row.answers.turn_in_progress.noul : undefined,
      agreesWithControl: agrees,
    });
  }
  return {
    rows: out,
    summary: {
      compared: out.filter((row) => row.agreesWithControl !== null).length,
      publishedYes,
      publishedNo,
      agreed,
      disagreed,
      ungrounded,
    },
  };
};

export const renderRescoreMarkdown = (input: {
  readonly source: { readonly path: string; readonly sha256: string; readonly generatedAt: string; readonly model: string };
  readonly policy: RescorePolicy;
  readonly outcomes: readonly QuestionOutcome[];
  readonly labelJoin: LabelJoin;
  readonly crossCheck: ControlPlaneCrossCheck | undefined;
}): string => {
  const lines: string[] = [];
  lines.push("# Held-out re-score from the stored answers");
  lines.push("");
  lines.push("No model calls: every number below is re-derived from the raw answers in");
  lines.push(`\`${input.source.path}\``);
  lines.push(`(sha256 \`${input.source.sha256}\`, generated ${input.source.generatedAt}, service model \`${input.source.model}\`).`);
  lines.push("");
  lines.push(
    `Policy: Noul two-sided at >= ${input.policy.positiveBar} and <= ${input.policy.negativeBar}; ` +
      `Choice at confidence >= ${input.policy.choiceConfidence} and top probability >= ${input.policy.choiceTop}.`,
  );
  lines.push("");
  lines.push(
    `Labels joined against the current manifest: ${input.labelJoin.joined} of ` +
      `${input.labelJoin.joined + input.labelJoin.storedOnly} rows` +
      (input.labelJoin.storedOnly > 0
        ? `; ${input.labelJoin.storedOnly} row(s) fell back to the labels frozen in the paid report: ${input.labelJoin.storedOnlyIds.join(", ")}`
        : " (no fallback needed)") +
      ".",
  );
  lines.push("");
  lines.push("## Coverage and errors per question");
  lines.push("");
  lines.push("| question | published | abstained | coverage | correct | wrong | accuracy | unfalsifiable | vacuous | label insufficient_evidence |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const entry of input.outcomes) {
    lines.push(
      `| ${entry.id} | ${entry.published} | ${entry.abstained} | ${entry.coveragePct}% | ${entry.correct} | ${entry.wrong} | ` +
        `${entry.accuracyPct === null ? "n/a" : `${entry.accuracyPct}%`} | ${entry.unfalsifiable} | ${entry.vacuous} | ${entry.labelInsufficient} |`,
    );
  }
  lines.push("");
  lines.push("`vacuous` is agreement on the pack's own no-signal option (`activity = indeterminate`,");
  lines.push("`repetition = insufficient_evidence`): agreement on having nothing to say, not evidence");
  lines.push("of classification. `unfalsifiable` is a published answer on a label the corpus cannot");
  lines.push("ground. `coverage` is published / rows.");
  lines.push("");
  if (input.crossCheck) {
    const summary = input.crossCheck.summary;
    lines.push("## turn_in_progress against the control plane");
    lines.push("");
    lines.push(
      `Compared ${summary.compared} published rows (yes ${summary.publishedYes}, no ${summary.publishedNo}): ` +
        `${summary.agreed} agreed, ${summary.disagreed} disagreed, ${summary.ungrounded} published with no control state at that cut.`,
    );
    lines.push("");
    lines.push("| checkpoint | control state | control reason | published | noul | agrees |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const row of input.crossCheck.rows) {
      if (row.published === "abstain") continue;
      lines.push(
        `| ${row.checkpointId} | ${row.controlState} | ${row.controlReason} | ${row.published} | ${row.noul ?? ""} | ` +
          `${row.agreesWithControl === null ? "n/a" : row.agreesWithControl ? "yes" : "NO"} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// CLI — `bun tests/pty-e2e/jev/rescore.ts --report <compare-*.json>`
// ---------------------------------------------------------------------------

const arg = (name: string, fallback?: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1]! : fallback;
};

const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const main = async (): Promise<void> => {
  const reportPath = arg("report");
  if (reportPath === undefined) {
    process.stderr.write(
      "usage: bun tests/pty-e2e/jev/rescore.ts --report <compare-*.json> " +
        "[--policy two-sided|single-sided] [--sweep] [--cross-check] [--out <path>] [--fraction-steps n]\n",
    );
    process.exitCode = 2;
    return;
  }
  const { createHash } = await import("node:crypto");
  const { readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const raw = readFileSync(reportPath, "utf8");
  const report = JSON.parse(raw) as StoredReport;
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const policy = arg("policy", "two-sided") === "single-sided" ? SINGLE_SIDED_POLICY : CONTRACT_POLICY;

  const { outcomes, labelJoin } = rescore(report, policy);
  const crossCheck = flag("cross-check")
    ? await crossCheckTurnInProgress(report, {
        fractionSteps: Number(arg("fraction-steps", "400")),
        policy,
      })
    : undefined;

  const markdown = renderRescoreMarkdown({
    source: { path: reportPath, sha256, generatedAt: report.generatedAt, model: report.model },
    policy,
    outcomes,
    labelJoin,
    crossCheck,
  });

  if (flag("sweep")) {
    const bars = [0.1, 0.2, 0.3, 0.5].flatMap((negativeBar) => [
      { positiveBar: 0.9, negativeBar },
      { positiveBar: 0.8, negativeBar },
    ]);
    const swept = sweep(report, bars);
    const sweepLines: string[] = ["", "## Bar sweep (Noul questions)", ""];
    sweepLines.push("| question | positive bar | negative bar | published | correct | wrong | unfalsifiable | vacuous |");
    sweepLines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const [id, points] of Object.entries(swept)) {
      for (const point of points) {
        sweepLines.push(
          `| ${id} | ${point.positiveBar} | ${point.negativeBar < 0 ? "none" : point.negativeBar} | ${point.published} | ` +
            `${point.correct} | ${point.wrong} | ${point.unfalsifiable} | ${point.vacuous} |`,
        );
      }
    }
    sweepLines.push("");
    process.stdout.write(`${markdown}${sweepLines.join("\n")}\n`);
  } else {
    process.stdout.write(`${markdown}\n`);
  }

  const out = arg("out");
  if (out !== undefined) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      `${JSON.stringify({ source: { path: reportPath, sha256, generatedAt: report.generatedAt, model: report.model }, policy, labelJoin, outcomes, crossCheck }, null, 2)}\n`,
    );
    process.stderr.write(`[jev] wrote ${out}\n`);
  }
};

if (process.argv[1]?.endsWith("rescore.ts") === true) {
  await main();
}
