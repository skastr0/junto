/**
 * Checkpoint + label manifest generator.
 *
 * Walk every committed capture, replay it through the real `SessionObserver`
 * (see `replay.ts`), and keep the cuts whose RENDERED screen carries the
 * harness's own live-turn chrome or dialog chrome. A cut is never selected
 * because a model, a rule, or the seat-state machine said something — the
 * selection input is the grid and the observer's own title/OSC signals.
 *
 * Three checkpoint classes come out of the walk:
 *   live_turn    — the harness's own mid-turn paint (spinner, working footer,
 *                  braille OSC title, elapsed-time line)
 *   dialog       — a pending-human frame (permission, trust, login, error)
 *   settled_idle — the harness's own settled-ready chrome, kept as a negative
 *                  control: without grounded `no` screens a comparison report
 *                  can only measure false positives, never false negatives.
 *
 * Run `bun tests/pty-e2e/jev/generate.ts` to rewrite `checkpoints.json`.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { capturePath, corpusRoot } from "../runner";
import { compileProbe, HARNESSES, probesFor } from "./chrome";
import { windowFor } from "./evidence";
import { MAX_CANDIDATE_LINES } from "./evidence";
import { labelCheckpoint } from "./labels";
import { DEFAULT_FRACTION_STEPS, replayCapture, type ReplayStep } from "./replay";
import { REQUESTED_MODEL, RETURNED_MODEL_IN_PARENT_RUNS } from "./pack";
import { PACK_IDS } from "./pack";
import type {
  Checkpoint,
  CheckpointClass,
  CheckpointManifest,
  ChromeMatch,
  CoverageGap,
  HarnessCoverage,
  LabelVector,
} from "./types";

const MAX_MATCHED_TEXT = 240;

type ProbeCompiled = {
  readonly probe: ReturnType<typeof probesFor>[number];
  readonly re: RegExp;
};

const compiledByHarness = new Map<string, readonly ProbeCompiled[]>();

const compiledFor = (harness: string): readonly ProbeCompiled[] => {
  const cached = compiledByHarness.get(harness);
  if (cached) return cached;
  const built = probesFor(harness).map((probe) => ({ probe, re: compileProbe(probe) }));
  compiledByHarness.set(harness, built);
  return built;
};

/** Every probe that matches this rendered screen, in probe declaration order. */
export const matchChrome = (
  harness: string,
  input: {
    readonly lines: readonly string[];
    readonly title: string;
    readonly osc9: string;
  },
): readonly ChromeMatch[] => {
  const out: ChromeMatch[] = [];
  for (const { probe, re } of compiledFor(harness)) {
    if (probe.where === "screen") {
      const line = input.lines.find((candidate) => candidate.trim().length > 0 && re.test(candidate));
      if (line === undefined) continue;
      out.push({
        probeId: probe.id,
        kind: probe.kind,
        role: probe.role,
        ...(probe.concern ? { concern: probe.concern } : {}),
        where: "screen",
        matchedText: line.trimEnd().slice(0, MAX_MATCHED_TEXT),
      });
    } else {
      const value = probe.where === "title" ? input.title : input.osc9;
      if (value.length === 0 || !re.test(value)) continue;
      out.push({
        probeId: probe.id,
        kind: probe.kind,
        role: probe.role,
        ...(probe.concern ? { concern: probe.concern } : {}),
        where: probe.where,
        matchedText: value.slice(0, MAX_MATCHED_TEXT),
      });
    }
  }
  return out;
};

const CLASS_RANK: Record<CheckpointClass, number> = { dialog: 0, live_turn: 1, settled_idle: 2 };

export const classOf = (matches: readonly ChromeMatch[]): CheckpointClass | undefined =>
  [...matches].sort((a, b) => CLASS_RANK[a.role] - CLASS_RANK[b.role])[0]?.role;

const selectingMatch = (matches: readonly ChromeMatch[]): ChromeMatch | undefined =>
  [...matches].sort((a, b) => CLASS_RANK[a.role] - CLASS_RANK[b.role])[0];

export type StepRecord = {
  readonly grid: ReplayStep["grid"];
  readonly step: number;
  readonly steps: number;
  readonly cut: number;
  readonly atMs: number;
  readonly lines: readonly string[];
  readonly title: string;
  readonly osc9: string;
  readonly matches: readonly ChromeMatch[];
  readonly cls: CheckpointClass | undefined;
};

/** Walk one capture and return every sampled step, in order. */
export const walkCapture = async (
  harness: string,
  scenario: string,
  fractionSteps: number,
): Promise<{ readonly steps: readonly StepRecord[]; readonly decodedLength: number; readonly rawBytes: number }> => {
  const steps: StepRecord[] = [];
  const trace = await replayCapture({
    harness,
    scenario,
    fractionSteps,
    onStep: (step) => {
      const lines = step.snapshot.lines;
      const matches = matchChrome(harness, {
        lines,
        title: step.snapshot.signals.title,
        osc9: step.snapshot.signals.osc9,
      });
      steps.push({
        grid: step.grid,
        step: step.step,
        steps: step.steps,
        cut: step.cut,
        atMs: step.atMs,
        lines: [...lines],
        title: step.snapshot.signals.title,
        osc9: step.snapshot.signals.osc9,
        matches,
        cls: classOf(matches),
      });
    },
  });
  return { steps, decodedLength: trace.decodedLength, rawBytes: trace.rawBytes };
};

/** The observation the pack's `{ earlier, now }` pair would use. */
export const earlierFor = (
  steps: readonly StepRecord[],
  cut: number,
  decodedLength: number,
): StepRecord | undefined => {
  const target = cut - Math.floor(decodedLength / 20);
  if (target <= 0) return undefined;
  let best: StepRecord | undefined;
  for (const step of steps) {
    if (step.cut <= target) best = step;
    else break;
  }
  return best;
};

/**
 * Select checkpoints from one capture's walked steps.
 *
 * Dedupe is by SEMANTIC SIGNATURE — the checkpoint class, the selecting probe,
 * and the label values — not by screen text. A repainting footer produces
 * hundreds of distinct grids that all label identically, and a comparison
 * report gains nothing from sending the same labelled situation 300 times. The
 * first and last cut of each distinct situation are kept so its temporal span
 * is visible, and `occurrences` records how many cuts shared it.
 */

/** The label axes that define a distinct labelled situation. */
const SEMANTIC_KEYS = [
  "turn_in_progress",
  "activity",
  "approval_requested",
  "answer_requested",
  "access_problem",
  "execution_error",
  "repetition",
  "highlight_exists",
] as const;

const semanticSignature = (labels: LabelVector): string =>
  SEMANTIC_KEYS.map((key) => labels[key].value).join("|");

const selectCheckpoints = (
  harness: string,
  scenario: string,
  walked: { readonly steps: readonly StepRecord[]; readonly decodedLength: number; readonly rawBytes: number },
): readonly Checkpoint[] => {
  const labelFor = (
    step: StepRecord,
    cls: CheckpointClass,
  ): { readonly earlier: StepRecord | undefined; readonly window: ReturnType<typeof windowFor>; readonly labels: LabelVector } => {
    const earlier = earlierFor(walked.steps, step.cut, walked.decodedLength);
    const window = windowFor(step.lines.join("\n"));
    return {
      earlier,
      window,
      labels: labelCheckpoint({
        class: cls,
        matches: step.matches,
        lines: step.lines,
        window,
        earlierLines: earlier?.lines,
      }),
    };
  };

  const seen = new Map<
    string,
    { first: StepRecord; last: StepRecord; cls: CheckpointClass; probeId: string; occurrences: number }
  >();
  for (const step of walked.steps) {
    const cls = step.cls;
    if (cls === undefined) continue;
    const selecting = selectingMatch(step.matches);
    if (selecting === undefined) continue;
    const signature = `${cls}|${selecting.probeId}|${semanticSignature(labelFor(step, cls).labels)}`;
    const prior = seen.get(signature);
    if (prior) {
      prior.last = step;
      prior.occurrences += 1;
    } else {
      seen.set(signature, { first: step, last: step, cls, probeId: selecting.probeId, occurrences: 1 });
    }
  }

  const ordered = [...seen.values()].sort((a, b) => a.first.cut - b.first.cut);
  const out: Checkpoint[] = [];
  for (const entry of ordered) {
    const cuts = entry.cls === "settled_idle" ? [entry.first] : [entry.first, entry.last];
    const unique = cuts.filter((step, i, all) => all.findIndex((s) => s.cut === step.cut) === i);
    for (const step of unique) {
      const { window, labels } = labelFor(step, entry.cls);
      out.push({
        id: `${harness}/${scenario}#${step.cut}`,
        harness,
        scenario,
        class: entry.cls,
        grid: step.grid,
        step: step.step,
        steps: step.steps,
        cut: step.cut,
        cutFraction: Number((step.cut / walked.decodedLength).toFixed(6)),
        decodedLength: walked.decodedLength,
        rawBytes: walked.rawBytes,
        occurrences: entry.occurrences,
        geometry: { cols: 0, rows: 0, source: "" },
        signals: { title: step.title, osc9: step.osc9 },
        matches: step.matches,
        window: {
          totalLines: step.lines.length,
          candidateLines: window.ids.length,
          firstId: window.ids[0] ?? "",
          lastId: window.ids[window.ids.length - 1] ?? "",
        },
        labels,
      });
    }
  }
  return out;
};

/** What each missing scenario would have unblocked, keyed by scenario name. */
const UNBLOCKS: Readonly<Record<string, readonly string[]>> = {
  "permission-returns-idle": ["approval_requested", "turn_in_progress", "highlight_line"],
  "working-turn": ["turn_in_progress", "activity", "repetition"],
  "paste-chip": ["turn_in_progress", "highlight_exists"],
  "osc9-empty-composer": ["turn_in_progress"],
  "mail-notice": ["answer_requested", "access_problem", "highlight_line"],
  "startup-idle": ["highlight_exists", "access_problem"],
  "startup-trust": ["approval_requested", "answer_requested"],
  "type-echo": ["turn_in_progress"],
};

const unblocksFor = (scenario: string): readonly string[] =>
  UNBLOCKS[scenario] ?? ["turn_in_progress", "highlight_exists"];

type ManifestFile = {
  readonly scenarios?: ReadonlyArray<{
    readonly scenario?: string;
    readonly status?: string;
    readonly reason?: string | null;
  }>;
};

const readManifest = (harness: string): ManifestFile => {
  const path = join(corpusRoot(), harness, "manifest.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as ManifestFile;
};

/** Committed scenario names for a harness, sorted. */
export const scenariosOf = (harness: string): readonly string[] =>
  readdirSync(join(corpusRoot(), harness))
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => file.replace(/\.jsonl$/u, ""))
    .sort();

export type BuildOptions = {
  readonly fractionSteps?: number;
  readonly harnesses?: readonly string[];
  readonly onProgress?: (message: string) => void;
};

export const buildManifest = async (opts: BuildOptions = {}): Promise<CheckpointManifest> => {
  const fractionSteps = opts.fractionSteps ?? DEFAULT_FRACTION_STEPS;
  const harnesses = opts.harnesses ?? HARNESSES;
  const checkpoints: Checkpoint[] = [];
  const byHarness: HarnessCoverage[] = [];
  const gaps: CoverageGap[] = [];
  const unobserved = new Set<string>();
  let captures = 0;

  for (const harness of harnesses) {
    const scenarios = scenariosOf(harness);
    const declared = readManifest(harness);
    const declaredNames = new Set(
      (declared.scenarios ?? []).map((entry) => entry.scenario ?? "").filter((name) => name.length > 0),
    );
    const matchedProbes = new Set<string>();
    let harnessCheckpoints = 0;
    const byClass: Record<CheckpointClass, number> = { live_turn: 0, dialog: 0, settled_idle: 0 };

    for (const scenario of scenarios) {
      captures += 1;
      opts.onProgress?.(`walking ${harness}/${scenario}`);
      const walked = await walkCapture(harness, scenario, fractionSteps);
      const selected = selectCheckpoints(harness, scenario, walked);
      for (const checkpoint of selected) {
        for (const match of checkpoint.matches) matchedProbes.add(match.probeId);
        byClass[checkpoint.class] += 1;
        harnessCheckpoints += 1;
      }
      checkpoints.push(...selected);
    }

    for (const probe of probesFor(harness)) {
      if (!matchedProbes.has(probe.id)) unobserved.add(probe.id);
    }

    for (const entry of declared.scenarios ?? []) {
      const scenario = entry.scenario;
      if (!scenario) continue;
      const hasBytes = existsSync(capturePath(harness, scenario));
      if (hasBytes) continue;
      gaps.push({
        harness,
        scenario,
        kind: entry.status === "skip" ? "declared-skip" : "absent",
        reason: (entry.reason ?? entry.status ?? "no reason declared").toString(),
        unblocks: unblocksFor(scenario),
      });
    }
    for (const scenario of scenarios) {
      if (!declaredNames.has(scenario)) {
        gaps.push({
          harness,
          scenario,
          kind: "undeclared-capture",
          reason: "fixture exists but the harness manifest declares no such scenario",
          unblocks: unblocksFor(scenario),
        });
      }
    }

    byHarness.push({
      harness,
      captures: scenarios.length,
      scenarios,
      checkpoints: harnessCheckpoints,
      byClass,
      unobservedProbes: probesFor(harness)
        .map((probe) => probe.id)
        .filter((id) => unobserved.has(id)),
    });
  }

  return {
    version: 1,
    generatedBy: "tests/pty-e2e/jev/generate.ts",
    corpusRoot: "tests/pty-e2e/corpus",
    harnesses,
    captures,
    steps: { fraction: fractionSteps },
    modelContract: {
      packIds: [...PACK_IDS],
      evidenceCap: MAX_CANDIDATE_LINES,
      evidenceShape: "{ harness, scenario, checkpoint, signals, evidence: { earlier, now }, screen }",
      requestedModel: REQUESTED_MODEL,
      returnedModelInParentRuns: RETURNED_MODEL_IN_PARENT_RUNS,
    },
    checkpoints,
    coverage: {
      byHarness,
      gaps: gaps.sort((a, b) => `${a.harness}/${a.scenario}`.localeCompare(`${b.harness}/${b.scenario}`)),
      unobservedProbes: [...unobserved].sort(),
    },
  };
};

/**
 * Fill in geometry from each capture's own manifest. Done after the walk so a
 * missing `pty.cols/rows` fails loudly (see `captureGeometry`) instead of
 * being papered over with a default mid-walk.
 */
export const withGeometry = (
  manifest: CheckpointManifest,
  geometryFor: (harness: string) => { readonly cols: number; readonly rows: number; readonly source: string },
): CheckpointManifest => ({
  ...manifest,
  checkpoints: manifest.checkpoints.map((checkpoint) => ({
    ...checkpoint,
    geometry: geometryFor(checkpoint.harness),
  })),
});

export const serializeManifest = (manifest: CheckpointManifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`;
