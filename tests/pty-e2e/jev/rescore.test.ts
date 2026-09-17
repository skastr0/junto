/**
 * Re-score contract: coverage and errors per question, the two-sided Noul
 * boundary including its floating-point edge, and the control-plane
 * cross-check for `turn_in_progress`.
 *
 * All legs are zero-cost: the model answers are synthesised here, and the only
 * real work is a replay (no network).
 */

import { describe, expect, it } from "vitest";
import { applyAcceptance } from "./live-client";
import { loadManifest } from "./manifest-file";
import { NOUL_ACCEPT_MIN, NOUL_REJECT_MAX } from "./pack";
import {
  CONTRACT_POLICY,
  SINGLE_SIDED_POLICY,
  crossCheckTurnInProgress,
  rescore,
  rescoreRow,
  renderRescoreMarkdown,
  sweep,
  type StoredReport,
  type StoredRow,
} from "./rescore";
import type { Answer } from "./live-client";

const manifest = loadManifest();

const label = (value: string) => ({ value, basis: "test label, stated here" });

/** A row carrying only the labels and answers a leg needs. */
const row = (input: {
  readonly checkpointId: string;
  readonly harness: string;
  readonly scenario: string;
  readonly cls: string;
  readonly answers: Readonly<Record<string, Answer>>;
  readonly labels?: Readonly<Record<string, string>>;
}): StoredRow => ({
  checkpointId: input.checkpointId,
  harness: input.harness,
  scenario: input.scenario,
  class: input.cls,
  model: "jev-test",
  answers: input.answers,
  labels: {
    activity: label(input.labels?.activity ?? "indeterminate"),
    turn_in_progress: label(input.labels?.turn_in_progress ?? "no"),
    approval_requested: label(input.labels?.approval_requested ?? "no"),
    answer_requested: label(input.labels?.answer_requested ?? "no"),
    access_problem: label(input.labels?.access_problem ?? "no"),
    execution_error: label(input.labels?.execution_error ?? "no"),
    repetition: label(input.labels?.repetition ?? "no"),
    highlight_exists: label(input.labels?.highlight_exists ?? "yes"),
    highlight_line: label(input.labels?.highlight_line ?? "NONE"),
  },
  latencyMs: 1,
  inputTokens: 1,
  outputTokens: 1,
});

const report = (rows: readonly StoredRow[]): StoredReport => ({
  generatedAt: "2026-01-01T00:00:00.000Z",
  split: "holdout",
  model: "jev-test",
  rows,
  totals: {},
});

const noul = (value: number): Answer => ({ type: "noul", noul: value });
const choice = (value: string, confidence = 0.99): Answer => ({
  type: "choice",
  choice: value,
  confidence,
  probabilities: { [value]: confidence },
});

describe("JRS — the two-sided Noul boundary", () => {
  it("JRS-boundary: exactly 0.1 publishes a negative at the literal bar and abstains at the derived one", () => {
    // The contract's bar is the literal 0.1.
    const literal = applyAcceptance("turn_in_progress", noul(0.1));
    expect(literal.verdict).toBe("accepted");
    expect(literal.value).toBe("no");
    // `1 - 0.9` is 0.09999999999999998 in IEEE-754, so a derived bar makes a
    // Noul of exactly 0.1 abstain. The held-out run contained two such answers
    // and both were correct, so the derived bar hides real published negatives.
    const derived = applyAcceptance("turn_in_progress", noul(0.1), { negativeBar: 1 - NOUL_ACCEPT_MIN });
    expect(derived.verdict).toBe("abstained");
    expect(1 - NOUL_ACCEPT_MIN).toBeLessThan(NOUL_REJECT_MAX);
    // The bars are inclusive on both sides: only the open band abstains.
    expect(applyAcceptance("x", noul(NOUL_ACCEPT_MIN)).value).toBe("yes");
    expect(applyAcceptance("x", noul(NOUL_REJECT_MAX)).value).toBe("no");
    expect(applyAcceptance("x", noul(0.5)).verdict).toBe("abstained");
  });

  it("JRS-boundary: the single-sided policy publishes only the yes side", () => {
    for (const value of [0.05, 0.1]) {
      expect(applyAcceptance("access_problem", noul(value), { negativeBar: SINGLE_SIDED_POLICY.negativeBar }).verdict).toBe(
        "abstained",
      );
      expect(applyAcceptance("access_problem", noul(value)).value).toBe("no");
    }
    // 0.2 is inside the band on both policies: widening the negative bar is a
    // policy choice, not a free win, and the sweep is where that is measured.
    expect(applyAcceptance("access_problem", noul(0.2)).verdict).toBe("abstained");
  });
});

describe("JRS — coverage and error accounting", () => {
  const rows: readonly StoredRow[] = [
    // A discriminating yes that the model gets right.
    row({
      checkpointId: "a/b#1",
      harness: "a",
      scenario: "b",
      cls: "dialog",
      answers: { access_problem: noul(0.95), turn_in_progress: noul(0.05), activity: choice("indeterminate") },
      labels: { access_problem: "yes", turn_in_progress: "no" },
    }),
    // A discriminating no that the model gets right.
    row({
      checkpointId: "a/b#2",
      harness: "a",
      scenario: "b",
      cls: "dialog",
      answers: { access_problem: noul(0.03), turn_in_progress: noul(0.95), activity: choice("editing") },
      labels: { access_problem: "no", turn_in_progress: "yes" },
    }),
    // A wrong answer on a discriminating label.
    row({
      checkpointId: "a/b#3",
      harness: "a",
      scenario: "b",
      cls: "dialog",
      answers: { access_problem: noul(0.97) },
      labels: { access_problem: "no" },
    }),
    // A published answer on a label the corpus cannot ground.
    row({
      checkpointId: "a/b#4",
      harness: "a",
      scenario: "b",
      cls: "dialog",
      answers: { access_problem: noul(0.97) },
      labels: { access_problem: "insufficient_evidence" },
    }),
    // Agreement on the pack's own no-signal option: vacuous, never "correct".
    row({
      checkpointId: "a/b#5",
      harness: "a",
      scenario: "b",
      cls: "dialog",
      answers: { activity: choice("indeterminate") },
      labels: { activity: "indeterminate" },
    }),
    // Abstention.
    row({
      checkpointId: "a/b#6",
      harness: "a",
      scenario: "b",
      cls: "dialog",
      answers: { access_problem: noul(0.5) },
    }),
  ];

  it("JRS-coverage: every published answer lands in exactly one bucket", () => {
    const { outcomes } = rescore(report(rows));
    const access = outcomes.find((entry) => entry.id === "access_problem");
    expect(access).toBeDefined();
    expect(access?.published).toBe(4);
    expect(access?.abstained).toBe(2);
    expect(access?.correct).toBe(2);
    expect(access?.wrong).toBe(1);
    expect(access?.unfalsifiable).toBe(1);
    expect(access?.vacuous).toBe(0);
    expect(access?.coveragePct).toBe(66.7);
    expect(access?.accuracyPct).toBe(66.7);
    expect(
      (access?.correct ?? 0) + (access?.wrong ?? 0) + (access?.unfalsifiable ?? 0) + (access?.vacuous ?? 0),
      "buckets must partition the published answers",
    ).toBe(access?.published);

    const activity = outcomes.find((entry) => entry.id === "activity");
    // One indeterminate (vacuous) plus one non-indeterminate on an
    // indeterminate label (wrong). The 34 vacuous agreements in the held-out
    // run are this bucket, which is why a bare agreement count was misleading.
    expect(activity?.published).toBe(3);
    expect(activity?.vacuous).toBe(2);
    expect(activity?.wrong).toBe(1);
    expect(activity?.correct).toBe(0);
  });

  it("JRS-coverage: the label join prefers the current manifest over the frozen report", () => {
    const checkpoint = manifest.checkpoints[0]!;
    const stale = row({
      checkpointId: checkpoint.id,
      harness: checkpoint.harness,
      scenario: checkpoint.scenario,
      cls: checkpoint.class,
      answers: { turn_in_progress: noul(0.95) },
      // A deliberately wrong frozen label: the join must ignore it.
      labels: { turn_in_progress: "no" },
    });
    const { outcomes, labelJoin } = rescore(report([stale]));
    expect(labelJoin.joined).toBe(1);
    expect(labelJoin.storedOnly).toBe(0);
    const turn = outcomes.find((entry) => entry.id === "turn_in_progress");
    // The manifest's label for this checkpoint decides, not the frozen one.
    expect(turn?.correct).toBe(checkpoint.labels.turn_in_progress.value === "yes" ? 1 : 0);
    expect(turn?.wrong).toBe(checkpoint.labels.turn_in_progress.value === "yes" ? 0 : 1);

    const orphan = row({
      checkpointId: "no/such#1",
      harness: "no",
      scenario: "such",
      cls: "dialog",
      answers: { turn_in_progress: noul(0.95) },
      labels: { turn_in_progress: "yes" },
    });
    const orphaned = rescore(report([orphan]));
    expect(orphaned.labelJoin.storedOnly).toBe(1);
    expect(orphaned.labelJoin.storedOnlyIds).toEqual(["no/such#1"]);
  });

  it("JRS-coverage: highlight_line may only answer inside the window, and NONE counts", () => {
    const checkpoint = manifest.checkpoints.find((entry) => entry.window.candidateLines > 3)!;
    const verdicts = rescoreRow(
      row({
        checkpointId: checkpoint.id,
        harness: checkpoint.harness,
        scenario: checkpoint.scenario,
        cls: checkpoint.class,
        answers: { highlight_line: choice("L900") },
      }),
      CONTRACT_POLICY,
    );
    expect(verdicts.highlight_line?.verdict).toBe("abstained");
    const none = rescoreRow(
      row({
        checkpointId: checkpoint.id,
        harness: checkpoint.harness,
        scenario: checkpoint.scenario,
        cls: checkpoint.class,
        answers: { highlight_line: choice("NONE") },
      }),
      CONTRACT_POLICY,
    );
    expect(none.highlight_line?.value).toBe("NONE");
  });
});

describe("JRS — bar sweep", () => {
  it("JRS-sweep: a wider negative bar publishes more negatives, and the sweep is pure", () => {
    const rows: readonly StoredRow[] = [0.05, 0.1, 0.15, 0.25].map((value, index) =>
      row({
        checkpointId: `a/b#${index}`,
        harness: "a",
        scenario: "b",
        cls: "dialog",
        answers: { turn_in_progress: noul(value) },
        labels: { turn_in_progress: "no" },
      }),
    );
    const swept = sweep(report(rows), [
      { positiveBar: 0.9, negativeBar: 0.1 },
      { positiveBar: 0.9, negativeBar: 0.2 },
      { positiveBar: 0.9, negativeBar: 0.3 },
    ]);
    const points = swept.turn_in_progress ?? [];
    expect(points.map((point) => point.published)).toEqual([2, 3, 4]);
    expect(points.every((point) => point.wrong === 0)).toBe(true);
    // Re-running the sweep changes nothing: it never calls the service.
    expect(sweep(report(rows), [{ positiveBar: 0.9, negativeBar: 0.1 }])).toEqual(
      sweep(report(rows), [{ positiveBar: 0.9, negativeBar: 0.1 }]),
    );
  });
});

describe("JRS — control-plane cross-check", () => {
  it("JRS-cross: a published turn_in_progress is compared with the real seat state at the same cut", async () => {
    const sample = manifest.checkpoints
      .filter((checkpoint) => checkpoint.harness === "claude" && checkpoint.scenario === "working-turn")
      .slice(0, 3);
    expect(sample.length).toBeGreaterThan(0);
    const rows = sample.map((checkpoint) =>
      row({
        checkpointId: checkpoint.id,
        harness: checkpoint.harness,
        scenario: checkpoint.scenario,
        cls: checkpoint.class,
        answers: { turn_in_progress: noul(0.02) },
      }),
    );
    const check = await crossCheckTurnInProgress(report(rows), { fractionSteps: manifest.steps.fraction });
    expect(check.rows.length).toBe(rows.length);
    for (const entry of check.rows) {
      expect(entry.published).toBe("no");
      // The control state is the real runtime's, read from the replay.
      expect(["idle", "working", "attention", "unknown", "gone"]).toContain(entry.controlState);
      expect(entry.agreesWithControl).not.toBeNull();
    }
    expect(check.summary.publishedNo).toBe(rows.length);
    expect(check.summary.compared + check.summary.ungrounded).toBe(rows.length);
    expect(check.summary.agreed + check.summary.disagreed).toBe(check.summary.compared);
  });

  it("JRS-cross: an abstention is not counted as a comparison", async () => {
    const checkpoint = manifest.checkpoints.find(
      (entry) => entry.harness === "claude" && entry.scenario === "working-turn",
    )!;
    const check = await crossCheckTurnInProgress(
      report([
        row({
          checkpointId: checkpoint.id,
          harness: checkpoint.harness,
          scenario: checkpoint.scenario,
          cls: checkpoint.class,
          answers: { turn_in_progress: noul(0.5) },
        }),
      ]),
      { fractionSteps: manifest.steps.fraction },
    );
    expect(check.rows[0]?.published).toBe("abstain");
    expect(check.rows[0]?.agreesWithControl).toBeNull();
    expect(check.summary.compared).toBe(0);
  });
});

describe("JRS — rendering", () => {
  it("JRS-render: the report names the source digest and the policy it applied", () => {
    const { outcomes, labelJoin } = rescore(report([]));
    const markdown = renderRescoreMarkdown({
      source: { path: "somewhere.json", sha256: "deadbeef", generatedAt: "2026-01-01T00:00:00.000Z", model: "jev-test" },
      policy: CONTRACT_POLICY,
      outcomes,
      labelJoin,
      crossCheck: undefined,
    });
    expect(markdown).toContain("deadbeef");
    expect(markdown).toContain(`>= ${CONTRACT_POLICY.positiveBar} and <= ${CONTRACT_POLICY.negativeBar}`);
    expect(markdown).toContain("## Coverage and errors per question");
    expect(markdown).toContain("vacuous");
  });
});
