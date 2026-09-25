/**
 * Awareness authority boundary — the cement no type can hold.
 *
 * The binding rule: awareness output is advisory display only. It may never
 * feed `evaluate()`, the seat state machine, the composer verdict, or any
 * delivery decision, and it may never set or clear a flag, mark a seat seen, or
 * author canvas state. The canonical control states are exactly
 * `idle | working | attention | unknown | gone`; awareness adds orthogonal
 * READ-ONLY axes beside them and does not use that vocabulary at all.
 *
 * Three things cannot be typed, so they are asserted here:
 *
 *   1. the awareness sources import nothing from the state engine, the drive,
 *      the seat process, IPC, or the renderer;
 *   2. the awareness sources do not name the canonical control state, do not
 *      call a flag setter, and touch no network;
 *   3. no state-engine or drive module imports awareness, in either direction —
 *      the boundary is a wall, not a convention.
 *
 * The pack itself is asserted too, because it is the artifact the operator
 * reviews: one version, one place for thresholds, every question justified, and
 * the two explicit declines the measured failures demand.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_POLICIES,
  ACTIVITY_DERIVATION,
  AI_ACTIVITY_VALUES,
  AI_CONCERN_VALUES,
  ASSESSMENT_AVAILABILITY_VALUES,
  AWARENESS_ACCEPTANCE,
  AWARENESS_PACK_VERSION,
  AWARENESS_QUESTIONS,
  AWARENESS_QUESTION_IDS,
  CONCERN_ABSENT_DISPLAY,
  CONCERN_DISPLAY,
  HEALTH_DERIVATION,
  HEALTH_REQUIRES_ALSO,
  HIGHLIGHT_NONE_OPTION_ID,
  INSUFFICIENT_EVIDENCE_OPTION_ID,
  MAX_EVIDENCE_CANDIDATE_LINES,
  acceptanceThresholdsFor,
  formatEvidenceLineId,
  type NoulQuestion,
} from "../src/main/junto/term/awareness/questions";
import { UNAVAILABLE_REASONS } from "../src/main/junto/term/awareness/project-result";
import { THREAD_HEALTH_VALUES } from "../src/shared/thread-health";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const read = (path: string): string => readFileSync(join(root, path), "utf8");

const AWARENESS_SOURCES = [
  "src/main/junto/term/awareness/questions.ts",
  "src/main/junto/term/awareness/select-input.ts",
  "src/main/junto/term/awareness/project-result.ts",
] as const;

const sourceFilesUnder = (path: string): ReadonlyArray<string> => {
  const absolute = join(root, path);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(relative(root, child));
    return [".ts", ".tsx"].includes(extname(child)) ? [relative(root, child)] : [];
  });
};

describe("awareness authority boundary", () => {
  it("imports nothing from the state engine, the drive, the seat process, IPC, or the renderer", () => {
    const forbidden =
      /from\s+["'][^"']*(?:agent-state|term\/drive|seat-process|injection-supervisor|first-typed|factory-delivery|term\/ipc|renderer)[^"']*["']/u;
    const violations = AWARENESS_SOURCES.flatMap((path) => {
      const source = read(path);
      const match = forbidden.exec(source);
      return match === null ? [] : [`${path}: ${match[0]}`];
    });
    expect(violations).toEqual([]);
  });

  it("names no canonical control state and calls no flag setter", () => {
    // The vocabulary of the control plane: the awareness module must not use
    // it, so a concern can never be mistaken for canonical seat state.
    const banned: ReadonlyArray<readonly [RegExp, string]> = [
      [/\battention\b/iu, "the canonical control state word must not appear in awareness sources"],
      [/\bAgentSeatState\b/u, "awareness must not touch the seat state type"],
      [/\bSeatStateMachine\b/u, "awareness must not touch the seat state machine"],
      [/\bevaluate\s*\(/u, "awareness must not call the seat evaluator"],
      [/\bcomposerVerdict\w*/u, "awareness must not read the composer verdict"],
      [/\bsetFlag\b|\bset_flag\b/u, "awareness must never set a flag"],
      [/\bmarkSeen\b|\bmark_seen\b/u, "awareness must never mark a seat seen"],
      [/\bVellum\b/u, "the retired brand mark is banned from every surface"],
      [/\u00b7/u, "the middle dot is banned from every surface"],
    ];
    const violations: string[] = [];
    for (const path of AWARENESS_SOURCES) {
      const source = read(path);
      for (const [pattern, why] of banned) {
        if (pattern.test(source)) violations.push(`${path}: ${why}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("touches no network", () => {
    const network = /from\s+["'](?:node:)?(?:http|https|net|dgram|tls)["']|\bfetch\s*\(|\baxios\b|from\s+["']ws["']/u;
    const violations = AWARENESS_SOURCES.filter((path) => network.test(read(path)));
    expect(violations).toEqual([]);
  });

  it("is not imported by any state-engine, drive, or delivery module", () => {
    const boundary = [
      ...sourceFilesUnder("src/main/junto/term/agent-state"),
      ...sourceFilesUnder("src/main/junto/term/drive"),
      "src/main/junto/term/seat-process.ts",
      "src/main/junto/term/factory-delivery-composition.ts",
      "src/main/junto/term/injection-supervisor.ts",
    ];
    const violations = boundary.filter((path) => {
      if (!statSync(join(root, path)).isFile()) return false;
      return /from\s+["'][^"']*awareness[^"']*["']/u.test(read(path));
    });
    expect(violations).toEqual([]);
  });

  it("declares the read-only axes exactly, publishing only the three values the wire accepts", () => {
    expect([...AI_ACTIVITY_VALUES]).toEqual([
      "investigating",
      "editing",
      "running_command",
      "testing",
      "reviewing",
      "reporting",
      "indeterminate",
    ]);
    expect([...AI_CONCERN_VALUES]).toEqual([
      "approval_requested",
      "answer_requested",
      "access_problem",
      "execution_error",
      "repetition",
    ]);
    // `not_assessed` (nothing received) and `stale` (display freshness, or the
    // seat left the turn) are renderer derivations and never travel, so the
    // producer publishes exactly these three.
    expect([...ASSESSMENT_AVAILABILITY_VALUES]).toEqual(["current", "abstained", "unavailable"]);
  });

  it("pins the unavailable reasons the projection can report", () => {
    // The validation boundary's vocabulary. The scheduler maps these onto the
    // producer's four (`missing_key | provider_failure | budget_exhausted |
    // not_configured`); `not_configured` and `budget_exhausted` are shared
    // verbatim, so a cap or budget refusal travels as itself rather than as a
    // synthesized side channel.
    expect([...UNAVAILABLE_REASONS]).toEqual([
      "no_answers",
      "transport_error",
      "model_error",
      "malformed_answers",
      "answers_rejected",
      "pack_version_mismatch",
      "budget_exhausted",
      "not_configured",
    ]);
    expect(new Set(UNAVAILABLE_REASONS).size).toBe(UNAVAILABLE_REASONS.length);
  });

  it("phrases every concern as a suggestion, never as a control state", () => {
    for (const concern of AI_CONCERN_VALUES) {
      expect(CONCERN_DISPLAY[concern]).toMatch(/^AI /u);
      expect(CONCERN_ABSENT_DISPLAY[concern]).toMatch(/^AI /u);
      expect(CONCERN_DISPLAY[concern]).not.toMatch(/\battention\b/iu);
    }
    expect(CONCERN_DISPLAY.approval_requested).toBe("AI suggests checking approval");
  });
});

describe("awareness question pack", () => {
  it("is versioned in one place", () => {
    expect(AWARENESS_PACK_VERSION).toBe("awareness-pack/2");
  });

  it("keeps every threshold in the one acceptance block, with both Noul bars", () => {
    expect(AWARENESS_ACCEPTANCE).toEqual({
      noulPositiveProbability: 0.9,
      noulNegativeProbability: 0.1,
      choiceConfidence: 0.8,
      choiceTopProbability: 0.8,
    });
    // No question carries a literal bar of its own: each resolves through the
    // named policy, so recalibration is one edit.
    for (const question of AWARENESS_QUESTIONS) {
      expect(ACCEPTANCE_POLICIES[question.acceptance]).toBe(acceptanceThresholdsFor(question));
    }
    // A Noul is two-sided: present at or above the positive bar, absent at or
    // below the negative one, and only the band between abstains.
    expect(ACCEPTANCE_POLICIES.noul).toEqual({
      minNoulProbability: 0.9,
      maxNoulAbsenceProbability: 0.1,
    });
    expect(ACCEPTANCE_POLICIES.choice).toEqual({ minConfidence: 0.8, minTopProbability: 0.8 });
    // A concern expressed as a Choice is held to the Noul positive bar.
    expect(ACCEPTANCE_POLICIES.concern_choice).toEqual({
      minConfidence: 0.9,
      minTopProbability: 0.9,
    });
  });

  it("gives every question a unique id and a stated failure mode", () => {
    expect(new Set(AWARENESS_QUESTION_IDS).size).toBe(AWARENESS_QUESTION_IDS.length);
    for (const question of AWARENESS_QUESTIONS) {
      expect(question.id).toMatch(/^[a-z_]+\.[a-z_]+$/u);
      expect(question.prompt.length).toBeGreaterThan(40);
      // The justification is what the operator reviews: a real sentence about
      // the failure this question exists to catch.
      expect(question.failureMode.length).toBeGreaterThan(30);
      expect(Number.isFinite(question.priority)).toBe(true);
      expect(question.requires.every((r) => r === "temporal_pair")).toBe(true);
    }
  });

  it("asks narrow Nouls and small Choices, with the two explicit declines", () => {
    const choices = AWARENESS_QUESTIONS.filter((q) => q.kind === "choice");
    const staticChoices = choices.filter((q) => q.optionSource === "static");
    const evidenceChoices = choices.filter((q) => q.optionSource === "evidence_lines");

    // No taxonomy: a static Choice offers a handful of options, never a label
    // set over a thin slice.
    for (const question of staticChoices) {
      expect(question.options.length).toBeGreaterThan(1);
      expect(question.options.length).toBeLessThanOrEqual(4);
    }
    // Exactly one choice selects over the supplied evidence, and it carries an
    // explicit way to decline.
    expect(evidenceChoices.map((q) => q.id)).toEqual(["highlight.line"]);
    expect(
      evidenceChoices[0]!.options.some((option) => option.id === HIGHLIGHT_NONE_OPTION_ID),
    ).toBe(true);
    // The temporal comparison carries an explicit insufficient_evidence, and
    // selecting it is a decline rather than an answer.
    const temporal = staticChoices.find((q) => q.id === "concern.repetition");
    expect(temporal?.requires).toEqual(["temporal_pair"]);
    const decline = temporal?.options.find(
      (option) => option.id === INSUFFICIENT_EVIDENCE_OPTION_ID,
    );
    expect(decline?.declines).toBe(true);
    // The option cap stays inside what a Choice can carry.
    for (const question of choices) {
      expect(question.options.length).toBeLessThanOrEqual(255);
    }
  });

  it("keeps the highlight option set inside the candidate cap", () => {
    expect(MAX_EVIDENCE_CANDIDATE_LINES).toBe(128);
    // 128 lines plus NONE is 129 options, inside Choice's 255-option ceiling.
    expect(MAX_EVIDENCE_CANDIDATE_LINES + 1).toBeLessThanOrEqual(255);
    expect(formatEvidenceLineId(0)).toBe("L000");
    expect(formatEvidenceLineId(127)).toBe("L127");
  });

  it("classifies every Noul as exactly one concern, activity, or health property", () => {
    // A Noul's absence has to mean something: a concern's absence is the
    // surface's "checked and clear", an activity property's absence is a
    // control-plane cross-check, and a health absence is an audit fact. An
    // unclassified Noul would have no role; a doubly classified one two.
    for (const question of AWARENESS_QUESTIONS) {
      if (question.kind !== "noul") continue;
      const roles = [question.concern, question.activity, question.health].filter(
        (role) => role !== undefined,
      );
      expect(roles.length, question.id).toBe(1);
    }
  });

  it("derives thread health by a declared precedence that covers both ends", () => {
    const healthNouls = AWARENESS_QUESTIONS.filter(
      (q): q is NoulQuestion => q.kind === "noul" && q.health !== undefined,
    );
    // Every health Noul feeds the derivation, with the value it declares.
    for (const question of healthNouls) {
      const entry = HEALTH_DERIVATION.find((e) => e.questionId === question.id);
      expect(entry?.value, question.id).toBe(question.health);
    }
    // Every derivation source is a question the pack actually asks.
    for (const entry of HEALTH_DERIVATION) {
      expect(AWARENESS_QUESTION_IDS, entry.questionId).toContain(entry.questionId);
      expect(entry.why.length).toBeGreaterThan(20);
      expect("weight" in entry).toBe(false);
    }
    // Both ends of the spectrum are reachable, and waiting on the operator
    // outranks everything: it is the case the seat state cannot see.
    const reachable = new Set(HEALTH_DERIVATION.map((e) => e.value));
    expect([...reachable].sort()).toEqual([...THREAD_HEALTH_VALUES].sort());
    expect(HEALTH_DERIVATION[0]?.value).toBe("waiting_on_operator");
    const firstGood = HEALTH_DERIVATION.findIndex((e) => e.value === "exceeding");
    const lastTrouble = HEALTH_DERIVATION.findIndex((e) => e.value === "overwhelmed");
    expect(lastTrouble).toBeLessThan(firstGood);
    // The strongest good claim never stands alone.
    expect(HEALTH_REQUIRES_ALSO).toEqual({ exceeding: "succeeding" });
  });

  it("combines activity by a declared precedence over narrow properties", () => {
    const activityQuestions = AWARENESS_QUESTIONS.filter(
      (q): q is NoulQuestion => q.kind === "noul" && q.activity !== undefined,
    );
    expect(ACTIVITY_DERIVATION.map((entry) => entry.questionId).sort()).toEqual(
      activityQuestions.map((q) => q.id).sort(),
    );
    // Every derivation step maps to the value its question declares, and every
    // step says why it sits where it does.
    for (const entry of ACTIVITY_DERIVATION) {
      const question = activityQuestions.find((q) => q.id === entry.questionId);
      expect(question?.activity).toBe(entry.value);
      expect(entry.why.length).toBeGreaterThan(20);
    }
    // The derivation is a precedence, never a product: no step carries a weight.
    expect(ACTIVITY_DERIVATION.every((entry) => !("weight" in entry))).toBe(true);
  });

  it("justifies the two questions that exist because of a measured failure", () => {
    const repetition = AWARENESS_QUESTIONS.find((q) => q.id === "concern.repetition");
    expect(repetition?.failureMode).toContain("temporal");
    const highlight = AWARENESS_QUESTIONS.find((q) => q.id === "highlight.line");
    expect(highlight?.failureMode).toContain("scrollback");
  });
});
