/**
 * Live comparison report: deterministic labels vs. a paid model run.
 *
 * Split into two halves so the harness is testable without a key:
 *  - `stateForCheckpoints` derives the exact state object the frozen pack
 *    expects for every selected checkpoint, by replaying the capture once per
 *    capture and reading the window at the checkpoint's cut. Nothing is
 *    reconstructed from the manifest's summary fields.
 *  - `runLiveComparison` calls the model and compares its accepted answers
 *    against the deterministic labels, question by question.
 *
 * The report also carries a full deterministic trace per capture, read before
 * and after the paid calls. Equal digests are the authority boundary being
 * CHECKED rather than asserted: the awareness path is read-only with respect
 * to the deterministic trace, and a future change that couples them moves the
 * digest and fails the run.
 */

import type { AgentSeatStateEvent } from "../../../src/shared/agent-seat-state";
import { earlierFor, walkCapture, type StepRecord } from "./checkpoints";
import { windowFor } from "./evidence";
import { applyAcceptance, askSystemOne, type Answer, type AskOptions, type Verdict } from "./live-client";
import {
  buildState,
  checkpointName,
  PACK_IDS,
  questionPack,
  USD_PER_INPUT_TOKEN,
  type AwarenessState,
  type QuestionMap,
} from "./pack";
import { replayCapture } from "./replay";
import type { Checkpoint, CheckpointManifest, LabelVector } from "./types";

export type CheckpointState = {
  readonly checkpoint: Checkpoint;
  readonly state: AwarenessState;
  readonly ids: readonly string[];
};

/** Derive the state object for every checkpoint, one replay per capture. */
export const stateForCheckpoints = async (
  checkpoints: readonly Checkpoint[],
  opts: { readonly fractionSteps: number; readonly onProgress?: (message: string) => void },
): Promise<readonly CheckpointState[]> => {
  const byCapture = new Map<string, Checkpoint[]>();
  for (const checkpoint of checkpoints) {
    const key = `${checkpoint.harness}/${checkpoint.scenario}`;
    const list = byCapture.get(key);
    if (list) list.push(checkpoint);
    else byCapture.set(key, [checkpoint]);
  }

  const out: CheckpointState[] = [];
  for (const [key, group] of byCapture) {
    const [harness, scenario] = key.split("/") as [string, string];
    opts.onProgress?.(`deriving state for ${key} (${group.length} checkpoints)`);
    const walked = await walkCapture(harness, scenario, opts.fractionSteps);
    const steps: readonly StepRecord[] = walked.steps;
    const byCut = new Map<number, StepRecord>();
    for (const step of steps) byCut.set(step.cut, step);
    for (const checkpoint of group) {
      const step = byCut.get(checkpoint.cut);
      if (!step) {
        throw new Error(
          `checkpoint ${checkpoint.id} names cut ${checkpoint.cut}, which the replay did not sample at ` +
            `${opts.fractionSteps} fraction steps. The grid must match the one the manifest was built with ` +
            `(manifest.steps.fraction), or the state would be re-derived from a different cut than the label.`,
        );
      }
      const window = windowFor(step.lines.join("\n"));
      const earlier = earlierFor(steps, step.cut, walked.decodedLength);
      out.push({
        checkpoint,
        state: buildState({
          harness,
          scenario,
          checkpoint: checkpointName(step.cut, walked.decodedLength),
          signals: { title: step.title, osc9: step.osc9 },
          screen: window,
          ...(earlier ? { earlier: windowFor(earlier.lines.join("\n")) } : {}),
        }),
        ids: window.ids,
      });
    }
  }
  return out;
};

export type LiveRow = {
  readonly checkpointId: string;
  readonly harness: string;
  readonly scenario: string;
  readonly class: Checkpoint["class"];
  readonly state: AwarenessState;
  readonly model: string;
  readonly answers: Readonly<Record<string, Answer>>;
  readonly verdicts: Readonly<Record<string, Verdict>>;
  readonly labels: LabelVector;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly error?: string;
};

export type QuestionAgreement = {
  readonly id: string;
  readonly matched: number;
  readonly mismatched: number;
  readonly modelAbstained: number;
  readonly labelInsufficient: number;
  readonly unfalsifiable: number;
  readonly total: number;
};

export type TraceDigest = {
  readonly capture: string;
  readonly digest: string;
  readonly events: number;
  readonly stalls: number;
  readonly finalState: string;
  readonly currentEvents: number;
};

export type ComparisonReport = {
  readonly generatedAt: string;
  readonly split: string;
  readonly model: string;
  readonly rows: readonly LiveRow[];
  readonly agreement: readonly QuestionAgreement[];
  readonly traces: readonly TraceDigest[];
  readonly authority: {
    readonly captures: number;
    readonly unchanged: number;
    readonly changed: readonly string[];
  };
  readonly totals: {
    readonly calls: number;
    readonly errors: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimatedUsd: number;
    readonly latencyP50Ms: number;
    readonly latencyMaxMs: number;
  };
};

const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[index] ?? 0;
};

export const compareRows = (rows: readonly LiveRow[]): readonly QuestionAgreement[] =>
  PACK_IDS.map((id) => {
    let matched = 0;
    let mismatched = 0;
    let modelAbstained = 0;
    let labelInsufficient = 0;
    let unfalsifiable = 0;
    let total = 0;
    for (const row of rows) {
      if (row.error !== undefined) continue;
      total += 1;
      const verdict = row.verdicts[id];
      const label = row.labels[id as keyof LabelVector];
      if (label === undefined) continue;
      const labelIsInsufficient = label.value === "insufficient_evidence";
      if (labelIsInsufficient) labelInsufficient += 1;
      if (verdict === undefined || verdict.verdict === "abstained") {
        modelAbstained += 1;
        continue;
      }
      if (labelIsInsufficient) {
        unfalsifiable += 1;
        continue;
      }
      if (verdict.value === label.value) matched += 1;
      else mismatched += 1;
    }
    return { id, matched, mismatched, modelAbstained, labelInsufficient, unfalsifiable, total };
  });

/** First index at which two traces disagree, or -1 when identical. */
export const firstTraceDivergence = (
  a: readonly AgentSeatStateEvent[],
  b: readonly AgentSeatStateEvent[],
): number => {
  const limit = Math.max(a.length, b.length);
  for (let i = 0; i < limit; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined || right === undefined) return i;
    if (JSON.stringify(left) !== JSON.stringify(right)) return i;
  }
  return -1;
};

export const traceDigestFor = async (
  harness: string,
  scenario: string,
  fractionSteps: number,
): Promise<TraceDigest> => {
  const trace = await replayCapture({ harness, scenario, fractionSteps });
  return {
    capture: `${harness}/${scenario}`,
    digest: trace.traceDigest,
    events: trace.trace.length,
    stalls: trace.stalls.length,
    finalState: trace.finalSlot?.state ?? "unknown",
    currentEvents: trace.currentEvents.length,
  };
};

export type RunLiveOptions = AskOptions & {
  readonly split: string;
  readonly fractionSteps: number;
  readonly concurrency?: number;
  readonly limit?: number;
  readonly onProgress?: (message: string) => void;
};

const pool = async <T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<readonly R[]> => {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
};

export const runLiveComparison = async (
  states: readonly CheckpointState[],
  opts: RunLiveOptions,
): Promise<ComparisonReport> => {
  const selected = opts.limit === undefined ? states : states.slice(0, opts.limit);
  const captures = [
    ...new Set(selected.map((entry) => `${entry.checkpoint.harness}/${entry.checkpoint.scenario}`)),
  ].sort();

  // BEFORE: the deterministic trace of every capture in the split.
  const before: TraceDigest[] = [];
  for (const capture of captures) {
    const [harness, scenario] = capture.split("/") as [string, string];
    before.push(await traceDigestFor(harness, scenario, opts.fractionSteps));
  }

  const rows = await pool(selected, opts.concurrency ?? 4, async (entry) => {
    const questions: QuestionMap = questionPack(entry.ids);
    const started = Date.now();
    try {
      const result = await askSystemOne({ state: entry.state, questions }, opts);
      const verdicts: Record<string, Verdict> = {};
      for (const id of PACK_IDS) {
        const answer = result.answers[id];
        if (answer === undefined) continue;
        verdicts[id] = applyAcceptance(id, answer, {
          ...(id === "highlight_line" ? { allowedChoices: [...entry.ids, "NONE"] } : {}),
        });
      }
      opts.onProgress?.(`${entry.checkpoint.id} -> ${result.model} (${Date.now() - started}ms)`);
      return {
        checkpointId: entry.checkpoint.id,
        harness: entry.checkpoint.harness,
        scenario: entry.checkpoint.scenario,
        class: entry.checkpoint.class,
        state: entry.state,
        model: result.model,
        answers: result.answers,
        verdicts,
        labels: entry.checkpoint.labels,
        latencyMs: Date.now() - started,
        inputTokens: result.usage?.input_tokens ?? 0,
        outputTokens: result.usage?.output_tokens ?? 0,
      } satisfies LiveRow;
    } catch (error) {
      opts.onProgress?.(`${entry.checkpoint.id} -> ERROR ${String(error)}`);
      return {
        checkpointId: entry.checkpoint.id,
        harness: entry.checkpoint.harness,
        scenario: entry.checkpoint.scenario,
        class: entry.checkpoint.class,
        state: entry.state,
        model: opts.model ?? "jev-latest",
        answers: {},
        verdicts: {},
        labels: entry.checkpoint.labels,
        latencyMs: Date.now() - started,
        inputTokens: 0,
        outputTokens: 0,
        error: error instanceof Error ? error.message : String(error),
      } satisfies LiveRow;
    }
  });

  // AFTER: the same read again. Identical digests are the authority boundary.
  const after: TraceDigest[] = [];
  for (const capture of captures) {
    const [harness, scenario] = capture.split("/") as [string, string];
    after.push(await traceDigestFor(harness, scenario, opts.fractionSteps));
  }
  const changed = before
    .filter((entry, index) => entry.digest !== after[index]?.digest)
    .map((entry) => entry.capture);

  const inputTokens = rows.reduce((sum, row) => sum + row.inputTokens, 0);
  return {
    generatedAt: new Date().toISOString(),
    split: opts.split,
    model: rows.find((row) => row.error === undefined)?.model ?? opts.model ?? "jev-latest",
    rows,
    agreement: compareRows(rows),
    traces: after,
    authority: { captures: captures.length, unchanged: captures.length - changed.length, changed },
    totals: {
      calls: rows.length,
      errors: rows.filter((row) => row.error !== undefined).length,
      inputTokens,
      outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
      estimatedUsd: inputTokens * USD_PER_INPUT_TOKEN,
      latencyP50Ms: percentile(rows.map((row) => row.latencyMs), 0.5),
      latencyMaxMs: Math.max(0, ...rows.map((row) => row.latencyMs)),
    },
  };
};

export const renderMarkdown = (report: ComparisonReport): string => {
  const lines: string[] = [];
  lines.push("# Jev x PTY seat-awareness comparison");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Model reported by the service: \`${report.model}\``);
  lines.push(`Split: \`${report.split}\``);
  lines.push(
    `Calls: ${report.totals.calls} (${report.totals.errors} errors), input tokens ${report.totals.inputTokens}, ` +
      `output tokens ${report.totals.outputTokens}, estimated input cost $${report.totals.estimatedUsd.toFixed(6)}, ` +
      `p50 ${report.totals.latencyP50Ms}ms, max ${report.totals.latencyMaxMs}ms`,
  );
  lines.push("");
  lines.push("## Agreement by question");
  lines.push("");
  lines.push("| question | matched | mismatched | model abstained | label insufficient_evidence | unfalsifiable | total |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const entry of report.agreement) {
    lines.push(
      `| ${entry.id} | ${entry.matched} | ${entry.mismatched} | ${entry.modelAbstained} | ${entry.labelInsufficient} | ${entry.unfalsifiable} | ${entry.total} |`,
    );
  }
  lines.push("");
  lines.push("`unfalsifiable` counts accepted answers on checkpoints whose label is");
  lines.push("`insufficient_evidence`: the corpus cannot say whether the model was right.");
  lines.push("");
  lines.push("## Deterministic trace (authority check)");
  lines.push("");
  lines.push(
    `Captures read before and after the paid calls: ${report.authority.captures}; ` +
      `trace digests unchanged: ${report.authority.unchanged}.`,
  );
  if (report.authority.changed.length > 0) {
    lines.push("");
    lines.push(`CHANGED (awareness reached the control path): ${report.authority.changed.join(", ")}`);
  }
  lines.push("");
  lines.push("| capture | trace digest | events | stalls | final state | currentEvents |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const trace of report.traces) {
    lines.push(
      `| ${trace.capture} | \`${trace.digest}\` | ${trace.events} | ${trace.stalls} | ${trace.finalState} | ${trace.currentEvents} |`,
    );
  }
  lines.push("");
  lines.push("## Per checkpoint");
  lines.push("");
  lines.push(
    "| checkpoint | class | turn_in_progress | activity | approval | answer | access | error | repetition | highlight_exists | highlight_line |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of report.rows) {
    const cell = (id: string): string => {
      const verdict = row.verdicts[id];
      const label = row.labels[id as keyof LabelVector]?.value ?? "?";
      if (verdict === undefined || verdict.verdict === "abstained") return `abstain (label ${label})`;
      return `${verdict.value}${verdict.value === label ? " =" : " !="} label ${label}`;
    };
    lines.push(
      `| ${row.checkpointId} | ${row.class} | ${cell("turn_in_progress")} | ${cell("activity")} | ${cell("approval_requested")} | ${cell("answer_requested")} | ${cell("access_problem")} | ${cell("execution_error")} | ${cell("repetition")} | ${cell("highlight_exists")} | ${cell("highlight_line")} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
};
