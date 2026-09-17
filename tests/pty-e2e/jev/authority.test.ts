/**
 * Authority boundary — Jev is advisory display only.
 *
 * The binding contract says that for identical inputs, enabling Jev, changing
 * its answers, or making it unavailable must not change deterministic seat
 * events, managed write decisions, submitted bytes, delivery receipts,
 * occupancy, or `needsLook`. This file holds the parts of that boundary the
 * evaluation harness can hold itself:
 *
 *  1. STATIC: the files that derive labels and states never import the control
 *     path (seat-state machine, rule engine, composer verdict, drive,
 *     injection/intervention). A future edit that reaches for a rule verdict
 *     to label a checkpoint fails red here.
 *  2. PURE: label derivation is a pure function of rendered lines, signals,
 *     chrome matches, and capture metadata. Same input, same labels.
 *  3. TRACE: a paid run leaves the deterministic trace digest unchanged. The
 *     report's `authority.changed` list must stay empty, and this leg proves it
 *     end to end with a fake model response.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadManifest } from "./manifest-file";
import { labelCheckpoint } from "./labels";
import { replayCapture } from "./replay";
import { runLiveComparison, stateForCheckpoints, traceDigestFor } from "./report";
import { windowFor } from "./evidence";
import { matchChrome } from "./checkpoints";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Files whose whole job is to turn a screen into a label or a model request.
 * None of them may read a control-path verdict.
 */
const AWARENESS_FILES = [
  "chrome.ts",
  "checkpoints.ts",
  "evidence.ts",
  "holdout.ts",
  "labels.ts",
  "live-client.ts",
  "manifest-file.ts",
  "pack.ts",
  "report.ts",
  "run-live.ts",
  "types.ts",
];

/**
 * Modules that own the deterministic control path. `replay.ts` is the one file
 * allowed to observe them — it produces the trace the boundary is measured
 * against — and it is deliberately absent from AWARENESS_FILES.
 */
const FORBIDDEN_IMPORTS = [
  "seat-state-machine",
  "agent-state/engine",
  "agent-state/match",
  "agent-state/composer",
  "term/drive",
  "managed-drive",
  "injection-supervisor",
  "term/intervention",
  "needs-look",
  "agent-state/rules",
];

/** Remove block comments and whole-line `//` comments, leaving code and strings. */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//u.test(line))
    .join("\n");

const importLines = (source: string): readonly string[] =>
  source
    .split("\n")
    .filter((line) => /^\s*(?:import|export)\b.*from\s+["']/u.test(line) || /^\s*import\s*\(/u.test(line));

describe("JA — static boundary", () => {
  it("JA-imports: no awareness file imports the deterministic control path", () => {
    const offenders: string[] = [];
    for (const file of AWARENESS_FILES) {
      const source = readFileSync(join(HERE, file), "utf8");
      for (const line of importLines(source)) {
        for (const forbidden of FORBIDDEN_IMPORTS) {
          if (line.includes(forbidden)) offenders.push(`${file}: ${line.trim()} (${forbidden})`);
        }
      }
    }
    expect(offenders, `awareness code reached into the control path:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("JA-imports: the label path cannot reach the replay/runtime module at all", () => {
    for (const file of ["labels.ts", "chrome.ts", "pack.ts", "evidence.ts"]) {
      const source = readFileSync(join(HERE, file), "utf8");
      expect(source.includes("./replay"), `${file} imports the runtime-backed replay module`).toBe(false);
      expect(source.includes("SeatStateRuntime"), `${file} names the runtime`).toBe(false);
    }
  });

  it("JA-vocabulary: the pack and label vocabulary contain no control state", () => {
    // Comments are stripped: prose ABOUT the boundary may name `needsLook`, but
    // no code or string literal in these files may carry it.
    const source = ["labels.ts", "pack.ts", "types.ts", "chrome.ts"]
      .map((file) => stripComments(readFileSync(join(HERE, file), "utf8")))
      .join("\n");
    // `gone` and `unknown` are control states; a label must never be one.
    for (const forbidden of ['"gone"', "AGENT_SEAT_STATES", "isAgentSeatState", "needsLook"]) {
      expect(source.includes(forbidden), `${forbidden} appears in the awareness vocabulary`).toBe(false);
    }
  });
});

describe("JA — label purity", () => {
  it("JA-pure: the same screen yields the same labels, every time", () => {
    const lines = [
      "╭──────────────────────────────╮",
      "│ 1 (●) Yes, and don't ask again for everything (always-approve mode)",
      "│ 2 (○) Yes, proceed",
      "╰──────────────────────────────╯",
    ];
    const matches = matchChrome("grok", { lines, title: "grok", osc9: "" });
    const input = {
      class: "dialog" as const,
      matches,
      lines,
      window: windowFor(lines.join("\n")),
      earlierLines: lines,
    };
    const first = labelCheckpoint(input);
    const second = labelCheckpoint(input);
    expect(second).toEqual(first);
    expect(first.approval_requested.value).toBe("yes");
    expect(first.turn_in_progress.value).toBe("no");
    // Identical observations cannot ground `repetition`: the pack's own third
    // option covers exactly that, and the label abstains rather than guessing.
    expect(first.repetition.value).toBe("insufficient_evidence");
  });

  it("JA-pure: labels are a function of the screen, not of any prior label", () => {
    const base = {
      class: "settled_idle" as const,
      window: windowFor("❯ \n⏸ manual mode on · ? for shortcuts · ← for agents"),
      earlierLines: undefined,
    };
    const lines = ["❯ ", "⏸ manual mode on · ? for shortcuts · ← for agents"];
    const matches = matchChrome("claude", { lines, title: "✳ Claude Code", osc9: "" });
    const a = labelCheckpoint({ ...base, matches, lines });
    const b = labelCheckpoint({ ...base, matches: [...matches], lines: [...lines] });
    expect(b).toEqual(a);
    expect(a.turn_in_progress.value).toBe("no");
    expect(a.approval_requested.value).toBe("no");
    expect(a.highlight_exists.value).toBe("no");
    expect(a.highlight_line.value).toBe("NONE");
  });
});

describe("JA — trace boundary", () => {
  const manifest = loadManifest();
  // The replay grid must be the one the manifest was built on: a coarser grid
  // does not sample the manifest's cuts, and re-deriving from a nearby cut
  // would mean the state no longer belongs to the label.
  const GRID = manifest.steps.fraction;
  const sample = manifest.checkpoints
    .filter((checkpoint) => checkpoint.harness === "claude" && checkpoint.scenario === "working-turn")
    .slice(0, 3);

  it("JA-trace: the deterministic trace is a function of the bytes alone", async () => {
    expect(sample.length).toBeGreaterThan(0);
    const before = await replayCapture({ harness: "claude", scenario: "working-turn", fractionSteps: GRID });
    // Deriving states and labels is the awareness path. It must not move the trace.
    const states = await stateForCheckpoints(sample, { fractionSteps: GRID });
    expect(states.length).toBe(sample.length);
    const after = await replayCapture({ harness: "claude", scenario: "working-turn", fractionSteps: GRID });
    expect(after.traceDigest).toBe(before.traceDigest);
    expect(JSON.stringify(after.trace)).toBe(JSON.stringify(before.trace));
  });

  it("JA-trace: a paid run leaves every trace digest unchanged", async () => {
    const states = await stateForCheckpoints(sample, { fractionSteps: GRID });
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            turn_in_progress: { type: "noul", noul: 0.99 },
            activity: { type: "choice", choice: "editing", probabilities: { editing: 0.99 }, confidence: 0.99 },
            approval_requested: { type: "noul", noul: 0.99 },
            answer_requested: { type: "noul", noul: 0.99 },
            access_problem: { type: "noul", noul: 0.99 },
            execution_error: { type: "noul", noul: 0.99 },
            repetition: { type: "choice", choice: "yes", probabilities: { yes: 0.99 }, confidence: 0.99 },
            highlight_exists: { type: "noul", noul: 0.99 },
            highlight_line: { type: "choice", choice: "NONE", probabilities: { NONE: 0.99 }, confidence: 0.99 },
          },
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const report = await runLiveComparison(states, {
      split: "holdout",
      fractionSteps: GRID,
      apiKey: "test-key",
      fetchImpl,
      sleepImpl: async () => {},
      concurrency: 2,
    });

    expect(report.totals.errors).toBe(0);
    expect(report.totals.calls).toBe(sample.length);
    // The whole point: the paid answers changed nothing deterministic.
    expect(report.authority.changed).toEqual([]);
    expect(report.authority.unchanged).toBe(report.authority.captures);
    expect(report.traces.length).toBe(1);
    const fresh = await traceDigestFor("claude", "working-turn", GRID);
    expect(report.traces[0]?.digest).toBe(fresh.digest);
  });

  it("JA-trace: the report is renderable and carries the pack's nine questions", async () => {
    const states = await stateForCheckpoints(sample.slice(0, 1), { fractionSteps: GRID });
    const report = await runLiveComparison(states, {
      split: "holdout",
      fractionSteps: GRID,
      apiKey: "k",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ model: "jev-1.13.0", answers: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
      sleepImpl: async () => {},
    });
    expect(report.agreement.map((entry) => entry.id)).toEqual([
      "activity",
      "turn_in_progress",
      "approval_requested",
      "answer_requested",
      "access_problem",
      "execution_error",
      "repetition",
      "highlight_exists",
      "highlight_line",
    ]);
    // An answer-less response means every question abstains; nothing is invented.
    for (const entry of report.agreement) expect(entry.modelAbstained).toBe(1);
  });
});

describe("JA — no stray awareness artefacts", () => {
  it("JA-files: the directory contains only the harness, the manifest, and its tests", () => {
    const files = readdirSync(HERE).sort();
    for (const file of files) {
      expect(
        /\.(?:ts|json|md)$/u.test(file),
        `${file} is not a source, manifest, or report file`,
      ).toBe(true);
    }
    expect(files).toContain("checkpoints.json");
    expect(files).toContain("README.md");
  });
});
