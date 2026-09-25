/**
 * Awareness evidence projection — unit tests and real-corpus replay.
 *
 * The corpus half replays `tests/pty-e2e/corpus` through a REAL SessionObserver
 * (the same read side production uses) and then reads a bounded window with
 * `readWindow`, so the input to the projection is production-shaped rather than
 * a hand-built snapshot. A missing capture throws; it is never a skip.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionObserver } from "../src/main/junto/term/observer";
import type { ObserverGridWindow } from "../src/main/junto/term/observer/types";
import {
  MAX_EVIDENCE_BYTES,
  MAX_EVIDENCE_CANDIDATE_LINES,
  MAX_REQUEST_BYTES,
  formatEvidenceLineId,
} from "../src/main/junto/term/awareness/questions";
import {
  FAILURE_MARKERS,
  REDACTION_DISCLAIMER,
  REDACTION_RULES,
  detectComposerExclusion,
  detectTemporalEvidence,
  redactEvidenceText,
  selectAwarenessInput,
  type AwarenessEvidenceWindow,
} from "../src/main/junto/term/awareness/select-input";
import { capturePath, chunkEvents, gateFixture, loadP1Fixture } from "./pty-e2e/runner";

// ---------------------------------------------------------------------------
// Corpus replay (real bytes, real observer)
// ---------------------------------------------------------------------------

const OBSERVED_AT = 1_700_000_000_000;

const manifestFor = (harness: string): {
  pty?: { cols?: number; rows?: number };
} => JSON.parse(readFileSync(join(dirname(capturePath(harness, "x")), "manifest.json"), "utf8"));

/**
 * Replay one committed P1 capture through a real observer at the capture's own
 * geometry, then read a bounded window.
 *
 * `gate` applies the corpus canonicality gate (`gateFixture`), which asserts
 * the manifest's RECORDED screen truth. It is requested only for fixtures whose
 * manifest recorded the SETTLED end-of-stream screen. A shared-session capture
 * keeps the whole byte stream, so a manifest that recorded a mid-turn spinner
 * title (claude/type-echo, claude/paste-chip, codex/*, muse/paste-chip,
 * hermes/paste-chip) cannot reproduce that title at the end of the stream;
 * those fixtures are used only for claims that do not rest on the title.
 */
const replayCorpus = async (
  harness: string,
  scenario: string,
  lines: number,
  opts: { readonly gate?: boolean } = {},
): Promise<{ window: AwarenessEvidenceWindow; fixture: NonNullable<ReturnType<typeof loadP1Fixture>> }> => {
  const fixture = loadP1Fixture(harness, scenario);
  if (fixture === null) {
    throw new Error(
      `real capture missing: ${harness}/${scenario} (${capturePath(harness, scenario)}) — a missing corpus is a red suite, never a skip`,
    );
  }
  expect(fixture.source).toBe("P1");
  const dims = manifestFor(harness).pty ?? {};
  const observer = new SessionObserver({
    bindingId: "seat-awareness",
    epoch: "e1",
    cols: dims.cols ?? 120,
    rows: dims.rows ?? 32,
  });
  try {
    for (const chunk of chunkEvents(fixture.events, "whole")) {
      observer.feed(chunk.data, chunk.seq);
    }
    const window = await observer.readWindow(lines);
    if (opts.gate === true) gateFixture(observer.snapshotNow(), fixture);
    return { window: { ...window, observedAt: OBSERVED_AT }, fixture };
  } finally {
    observer.dispose();
  }
};

/** Every complete corpus scenario that has a committed capture. */
const completeScenarios = (): ReadonlyArray<{ harness: string; scenario: string }> => {
  const out: Array<{ harness: string; scenario: string }> = [];
  for (const harness of ["amp", "claude", "codex", "devin", "grok", "hermes", "kimi", "muse", "omp", "pi"]) {
    const manifest = manifestFor(harness) as unknown as {
      scenarios?: ReadonlyArray<{ scenario: string; status: string }>;
    };
    for (const entry of manifest.scenarios ?? []) {
      if (entry.status !== "complete") continue;
      out.push({ harness, scenario: entry.scenario });
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Synthetic windows (for cap and redaction control)
// ---------------------------------------------------------------------------

const windowOf = (
  lines: readonly string[],
  overrides: Partial<ObserverGridWindow> = {},
): AwarenessEvidenceWindow => ({
  bindingId: "seat-1",
  epoch: "e1",
  cols: 120,
  rows: 32,
  seq: 42n,
  lines,
  totalLines: lines.length,
  truncated: false,
  observedAt: OBSERVED_AT,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Real corpus: composer chrome, ids, determinism, honesty
// ---------------------------------------------------------------------------

describe("awareness evidence projection over real corpus windows", () => {
  it("excludes Claude's composer box so a draft chip is never evidence", async () => {
    const { window } = await replayCorpus("claude", "paste-chip", 256);
    const state = selectAwarenessInput(window);
    const composer = detectComposerExclusion(window.lines);

    expect(composer.rule).toBe("prompt_box_body");
    expect(state.drops.composerLines).toBe(composer.to - composer.from);
    expect(state.drops.composerLines).toBeGreaterThan(0);
    // Nothing that survives came from the excluded range.
    for (const line of state.evidenceLines) {
      expect(line.sourceIndex < composer.from || line.sourceIndex >= composer.to).toBe(true);
    }
    // Composer chrome must not appear in the evidence block.
    expect(state.evidenceBlock).not.toContain("[Pasted text");
    expect(state.evidenceBlock).not.toContain("paste again to expand");
  });

  it("excludes Amp's rounded composer box but keeps the agent's answer", async () => {
    const { window } = await replayCorpus("amp", "type-echo", 256, { gate: true });
    const composer = detectComposerExclusion(window.lines);
    const state = selectAwarenessInput(window);

    expect(composer.rule).toBe("rounded_bottom_box");
    expect(state.drops.composerLines).toBe(5);
    // The composer body rows (`│ … │`) are chrome; the answer above is not.
    expect(state.evidenceBlock).not.toMatch(/^L\d+\| {2}│/mu);
    expect(state.evidenceBlock).toContain("Hello! I'm ready to work");
  });

  it("excludes a known injected prompt body when the caller can ground the needle", async () => {
    const { window } = await replayCorpus("claude", "paste-chip", 256);
    const without = selectAwarenessInput(window);
    const with_ = selectAwarenessInput(window, { injectedPromptNeedles: ["PASTE_LINE_00"] });

    expect(without.drops.injectedPromptLines).toBe(0);
    expect(with_.drops.injectedPromptLines).toBeGreaterThan(0);
    expect(with_.evidenceLines.length).toBe(
      without.evidenceLines.length - with_.drops.injectedPromptLines,
    );
    expect(with_.evidenceBlock).not.toContain("PASTE_LINE_00");
    // Excluding evidence changes the evidence, so the hash must change with it.
    expect(with_.evidenceHash).not.toBe(without.evidenceHash);
  });

  it("leaves a queued steering payload to the grounded needle, not to geometry", async () => {
    const { window } = await replayCorpus("amp", "paste-chip", 256);
    const composer = detectComposerExclusion(window.lines);
    const without = selectAwarenessInput(window);
    const with_ = selectAwarenessInput(window, { injectedPromptNeedles: ["steering:"] });

    // The rounded-box rule excludes the composer box (its top border is the
    // `╭┴` steering attachment); the queued panel above it is operator text
    // that only a grounded needle can name. That layering is the contract:
    // geometry for chrome, caller knowledge for what this app pasted.
    expect(composer.rule).toBe("rounded_bottom_box");
    expect(without.evidenceBlock).toContain("steering: PASTE_LINE_00");
    expect(with_.drops.injectedPromptLines).toBe(1);
    expect(with_.evidenceBlock).not.toContain("steering:");
    expect(with_.evidenceLines.length).toBe(without.evidenceLines.length - 1);
  });

  it("tags exactly the lines it sends, contiguously and bottom-anchored", async () => {
    const { window } = await replayCorpus("omp", "working-turn", 256, { gate: true });
    const state = selectAwarenessInput(window);

    expect(state.evidenceLines.length).toBeGreaterThan(0);
    state.evidenceLines.forEach((line, index) => {
      expect(line.id).toBe(formatEvidenceLineId(index));
      expect(state.evidenceBlock.split("\n")[index]).toBe(`${line.id}| ${line.text}`);
      // Every id resolves to the window line it came from, unchanged.
      expect(window.lines[line.sourceIndex]).toBe(line.text);
    });
    // Order-preserving: ids grow downward through the screen.
    const indices = state.evidenceLines.map((line) => line.sourceIndex);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
    // Bottom-anchored: nothing but the composer chrome below the last evidence
    // line was dropped. The 128-line candidate cap drops from the TOP, so it
    // never affects the bottom; the other caps do not bind on this window.
    expect(state.drops.byteCapLines).toBe(0);
    expect(state.drops.injectedPromptLines).toBe(0);
    expect(state.drops.requestCapLines).toBe(0);
    const last = state.evidenceLines[state.evidenceLines.length - 1]!;
    expect(last.sourceIndex).toBe(window.lines.length - 1 - state.drops.composerLines);
  });

  it("is deterministic: same window, same bytes, same hash", async () => {
    const { window } = await replayCorpus("grok", "permission-returns-idle", 256, { gate: true });
    const first = selectAwarenessInput(window);
    const second = selectAwarenessInput(window);
    // A later read of the SAME settled grid is the same evidence: the hash
    // covers the observation identity and the lines, not the wall clock.
    const later = selectAwarenessInput({ ...window, observedAt: window.observedAt + 60_000 });

    expect(second.evidenceHash).toBe(first.evidenceHash);
    expect(second.evidenceBlock).toBe(first.evidenceBlock);
    expect(second.serializedBytes).toBe(first.serializedBytes);
    expect(second.wire).toEqual(first.wire);
    expect(later.evidenceHash).toBe(first.evidenceHash);
    expect(later.observedAt).not.toBe(first.observedAt);
  });

  it("reports the observer's own truncation instead of pretending it saw everything", async () => {
    const { window } = await replayCorpus("omp", "working-turn", 256, { gate: true });
    const state = selectAwarenessInput(window);

    expect(window.totalLines).toBeGreaterThan(MAX_EVIDENCE_CANDIDATE_LINES);
    expect(window.truncated).toBe(true);
    expect(state.drops.windowTruncated).toBe(true);
    expect(state.drops.windowTotalLines).toBe(window.totalLines);
    expect(state.drops.windowLines).toBe(window.lines.length);
    expect(state.drops.candidateLines).toBe(window.lines.length - MAX_EVIDENCE_CANDIDATE_LINES);
    expect(state.evidenceLines.length).toBeLessThanOrEqual(MAX_EVIDENCE_CANDIDATE_LINES);
  });

  // The measured finding this test exists to keep true.
  it("never certifies a temporal pair on any real corpus capture", async () => {
    const scenarios = completeScenarios();
    expect(scenarios.length).toBeGreaterThan(30);

    const pairFixtures: string[] = [];
    const reasons = new Map<string, number>();
    let lineCapBinds = 0;
    let byteCapBinds = 0;
    let maxEvidenceBytes = 0;

    for (const { harness, scenario } of scenarios) {
      const { window } = await replayCorpus(harness, scenario, 256);
      const state = selectAwarenessInput(window);
      if (state.temporal.kind === "pair") pairFixtures.push(`${harness}/${scenario}`);
      else reasons.set(state.temporal.reason, (reasons.get(state.temporal.reason) ?? 0) + 1);
      if (state.drops.candidateLines > 0) lineCapBinds += 1;
      if (state.drops.byteCapLines > 0) byteCapBinds += 1;
      maxEvidenceBytes = Math.max(maxEvidenceBytes, state.evidenceBytes);
      // Invariants that must hold on every real screen.
      expect(state.evidenceBytes).toBeLessThanOrEqual(MAX_EVIDENCE_BYTES);
      expect(state.serializedBytes).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
      expect(state.requestCapHonored).toBe(true);
      expect(state.questions.some((q) => q.id === "concern.repetition")).toBe(false);
      expect(state.skipped.map((s) => s.questionId)).toContain("concern.repetition");
      // Accounting invariant: every window line is either sent, or counted as
      // exactly one kind of drop. Nothing vanishes silently.
      expect(
        state.drops.candidateLines +
          state.drops.composerLines +
          state.drops.injectedPromptLines +
          state.drops.byteCapLines +
          state.drops.requestCapLines +
          state.evidenceLines.length,
      ).toBe(state.drops.windowLines);
    }

    // Measured over the 38 complete captures with committed fixtures: 36
    // windows carry no failure output at all and 2 carry exactly one failure
    // block, so the comparison question is never asked and the axis reports the
    // gap. This is the measured false-positive path ("repetition yes" without
    // temporal evidence) closed by construction on every real screen in the
    // corpus.
    expect(pairFixtures).toEqual([]);
    expect([...reasons.keys()].sort()).toEqual(["fewer_than_two_attempts", "no_failure_visible"]);
    // The caps do real work: the line cap binds on 7 of the 38 captures, and at
    // 120 columns the largest evidence block measured 16038 bytes against the
    // 32 KiB cap, so the byte cap binds on none of them.
    expect(lineCapBinds).toBeGreaterThan(0);
    expect(byteCapBinds).toBe(0);
    expect(maxEvidenceBytes).toBeLessThan(MAX_EVIDENCE_BYTES);
  });
});

// ---------------------------------------------------------------------------
// Caps: line, byte, and the separate total request cap
// ---------------------------------------------------------------------------

describe("awareness evidence caps", () => {
  it("drops the OLDEST candidate lines and keeps the newest", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const state = selectAwarenessInput(windowOf(lines));

    expect(state.evidenceLines.length).toBe(MAX_EVIDENCE_CANDIDATE_LINES);
    expect(state.drops.candidateLines).toBe(200 - MAX_EVIDENCE_CANDIDATE_LINES);
    expect(state.evidenceLines[0]!.text).toBe(`line ${200 - MAX_EVIDENCE_CANDIDATE_LINES}`);
    expect(state.evidenceLines[state.evidenceLines.length - 1]!.text).toBe("line 199");
  });

  it("reports dropped lines and dropped bytes when the byte cap binds", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `row ${i} ${"x".repeat(60)}`);
    const state = selectAwarenessInput(windowOf(lines), { caps: { evidenceBytes: 600 } });

    expect(state.drops.byteCapLines).toBeGreaterThan(0);
    expect(state.drops.byteCapBytes).toBeGreaterThan(0);
    expect(state.evidenceBytes).toBeLessThanOrEqual(600);
    // Whole lines only, and the newest line always survives.
    expect(state.drops.lineClipped).toBe(false);
    expect(state.evidenceLines[state.evidenceLines.length - 1]!.text).toBe("row 39 " + "x".repeat(60));
    expect(state.evidenceLines.length).toBe(40 - state.drops.byteCapLines);
  });

  it("clips a single line that cannot fit rather than dropping the newest evidence", () => {
    const lines = ["older line that will not fit", "x".repeat(200)];
    const state = selectAwarenessInput(windowOf(lines), { caps: { evidenceBytes: 40 } });

    expect(state.evidenceLines.length).toBe(1);
    expect(state.drops.lineClipped).toBe(true);
    expect(state.evidenceLines[0]!.clipped).toBe(true);
    expect(state.evidenceLines[0]!.text.endsWith("…[clipped]")).toBe(true);
    expect(state.evidenceBytes).toBeLessThanOrEqual(40);
    expect(state.drops.byteCapLines).toBe(1);
  });

  it("squeezes questions under the total request cap, lowest priority first, and says so", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `row ${i} ${"y".repeat(80)}`);
    const full = selectAwarenessInput(windowOf(lines));
    const squeezed = selectAwarenessInput(windowOf(lines), {
      caps: { requestBytes: full.serializedBytes - 600 },
    });

    expect(squeezed.requestCapHonored).toBe(true);
    expect(squeezed.requestTruncated).toBe(true);
    expect(squeezed.serializedBytes).toBeLessThanOrEqual(squeezed.caps.requestBytes);
    // The lowest-priority activity property goes first; the highest-priority
    // concern survives.
    expect(squeezed.drops.questions[0]).toBe("activity.command_executing");
    expect(squeezed.questions.map((q) => q.id)).toContain("concern.approval_requested");
    expect(squeezed.questions.length).toBe(full.questions.length - squeezed.drops.questions.length);
    // Evidence is untouched while questions remain to drop.
    expect(squeezed.drops.requestCapLines).toBe(0);
    expect(squeezed.evidenceBlock).toBe(full.evidenceBlock);
  });

  it("drops evidence under the request cap only after every question is gone", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `row ${i} ${"z".repeat(80)}`);
    const full = selectAwarenessInput(windowOf(lines));
    const state = selectAwarenessInput(windowOf(lines), { caps: { requestBytes: 2_000 } });

    expect(state.requestCapHonored).toBe(true);
    expect(state.drops.questions.length).toBe(full.questions.length);
    expect(state.questions).toEqual([]);
    expect(state.drops.requestCapLines).toBeGreaterThan(0);
    // Still bottom-anchored after the squeeze.
    expect(state.evidenceLines[state.evidenceLines.length - 1]!.text).toBe("row 29 " + "z".repeat(80));
  });

  it("reports the cap as NOT honored when it is below the request's floor", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `row ${i}`);
    const state = selectAwarenessInput(windowOf(lines), { caps: { requestBytes: 40 } });

    expect(state.requestCapHonored).toBe(false);
    expect(state.requestTruncated).toBe(true);
    expect(state.questions).toEqual([]);
    expect(state.evidenceLines).toEqual([]);
    // The report is still complete: nothing was silently hidden.
    expect(state.drops.questions.length).toBeGreaterThan(0);
    expect(state.drops.requestCapLines).toBe(lines.length);
  });

  it("accounts for every window line as either sent or counted as a drop", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `row ${i} ${"x".repeat(60)}`);
    const cases = [
      selectAwarenessInput(windowOf(lines)),
      selectAwarenessInput(windowOf(lines), { caps: { evidenceBytes: 600 } }),
      selectAwarenessInput(windowOf(lines), { caps: { requestBytes: 2_000 } }),
      selectAwarenessInput(windowOf(lines), { caps: { requestBytes: 40 } }),
      selectAwarenessInput(windowOf(lines), { injectedPromptNeedles: ["row 7 "] }),
      selectAwarenessInput(windowOf([...lines, "─────", "❯ draft"])),
    ];
    for (const state of cases) {
      expect(
        state.drops.candidateLines +
          state.drops.composerLines +
          state.drops.injectedPromptLines +
          state.drops.byteCapLines +
          state.drops.requestCapLines +
          state.evidenceLines.length,
      ).toBe(state.drops.windowLines);
    }
  });

  it("skips every question when the window has no lines at all", () => {
    const state = selectAwarenessInput(windowOf([]));

    expect(state.evidenceLines).toEqual([]);
    expect(state.evidenceBlock).toBe("");
    expect(state.evidenceBytes).toBe(0);
    expect(state.questions).toEqual([]);
    expect(state.skipped.length).toBe(21);
    expect(state.skipped.every((s) => s.reason === "evidence_unavailable")).toBe(true);
    // The note states the gap rather than implying an answer.
    expect(state.temporalNote).toContain("not possible");
  });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe("awareness redaction", () => {
  const cases: ReadonlyArray<{ line: string; must: string; rule: string }> = [
    { line: "-----BEGIN RSA PRIVATE KEY-----", must: "[redacted private key]", rule: "private_key_block" },
    { line: "Authorization: Bearer abcdefghijklmnop", must: "[redacted]", rule: "bearer_token" },
    { line: "export GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789", must: "GH_TOKEN=[redacted]", rule: "secret_env_assignment" },
    { line: "OPENAI_API_KEY=sk-live-abcdefghijklmnop", must: "OPENAI_API_KEY=[redacted]", rule: "secret_env_assignment" },
    { line: "using sk-live-abcdefghijklmnop now", must: "[redacted secret]", rule: "provider_api_key" },
    { line: "push with ghp_abcdefghijklmnopqrstuvwxyz0123456789", must: "[redacted secret]", rule: "provider_api_key" },
    {
      line: "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      must: "[redacted token]",
      rule: "jwt",
    },
    { line: "git clone https://user:hunter2@example.com/repo.git", must: "https://[redacted]@", rule: "url_credentials" },
    { line: "contact alice@example.com for access", must: "[redacted email]", rule: "email_address" },
    { line: "at /Users/alice/projects/junto", must: "/<home>/projects/junto", rule: "posix_home_path" },
    { line: "C:\\Users\\alice\\repo", must: "<home>", rule: "windows_home_path" },
  ];

  it("removes each known secret and identifying path shape", () => {
    for (const entry of cases) {
      const result = redactEvidenceText(entry.line);
      expect(result.text, entry.line).toContain(entry.must);
      expect(result.ruleIds, entry.line).toContain(entry.rule);
      expect(result.replacements, entry.line).toBeGreaterThan(0);
    }
  });

  it("keeps the env var NAME while removing its value", () => {
    expect(redactEvidenceText("MY_TOKEN=supersecret").text).toBe("MY_TOKEN=[redacted]");
    expect(redactEvidenceText("TOKEN=supersecret").text).toBe("TOKEN=[redacted]");
    expect(redactEvidenceText("DB_PASSWORD=hunter2").text).toBe("DB_PASSWORD=[redacted]");
    expect(redactEvidenceText("OPENAI_API_KEY=sk-live-abcdefghijklmnop").text).toBe(
      "OPENAI_API_KEY=[redacted]",
    );
  });

  it("leaves ordinary output and ordinary assignments untouched", () => {
    const untouched = [
      "src/main/junto/term/awareness/questions.ts:120  const packVersion = 1",
      "PATH=/usr/bin:/bin",
      "NODE_ENV=production",
      "CI=true",
      "  FAIL src/main/junto/term/awareness/select-input.test.ts",
    ];
    for (const line of untouched) {
      const result = redactEvidenceText(line);
      expect(result.text, line).toBe(line);
      expect(result.replacements, line).toBe(0);
    }
  });

  it("carries the report and the disclaimer into every request", () => {
    const state = selectAwarenessInput(windowOf(["API_TOKEN=abcdef123456", "no secret here"]));

    expect(state.redaction.applied).toBe(true);
    expect(state.redaction.ruleIds).toContain("secret_env_assignment");
    expect(state.redaction.disclaimer).toBe(REDACTION_DISCLAIMER);
    // The disclaimer states the limit plainly: this is not a guarantee.
    expect(state.redaction.disclaimer).toContain("not a confidentiality guarantee");
    expect(state.evidenceBlock).not.toContain("abcdef123456");
    expect(state.evidenceBlock).toContain("API_TOKEN=[redacted]");
  });

  it("declares one entry per rule and is deterministic", () => {
    const ids = REDACTION_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    const line = "Bearer abcdefghijklmnop /Users/bob/x alice@example.com";
    expect(redactEvidenceText(line)).toEqual(redactEvidenceText(line));
  });
});

// ---------------------------------------------------------------------------
// Temporal evidence
// ---------------------------------------------------------------------------

describe("awareness temporal evidence", () => {
  const ids = (texts: readonly string[]) =>
    texts.map((text, index) => ({ id: formatEvidenceLineId(index), text }));

  it("certifies two failure-bearing blocks and names their line ranges", () => {
    const evidence = ids([
      "$ npm test",
      "Tests  2 failed | 8 passed",
      "  FAIL src/a.test.ts",
      "",
      "❯ fix it",
      "",
      "$ npm test",
      "Tests  2 failed | 8 passed",
      "  FAIL src/a.test.ts",
    ]);
    const temporal = detectTemporalEvidence(evidence);
    expect(temporal.kind).toBe("pair");
    if (temporal.kind !== "pair") return;
    expect(temporal.firstLineIds).toEqual(["L000", "L001", "L002"]);
    expect(temporal.secondLineIds).toEqual(["L006", "L007", "L008"]);
  });

  it("refuses to certify a pair from one contiguous failing run", () => {
    const evidence = ids([
      "$ npm test",
      "Error: boom",
      "FAIL src/a.test.ts",
      "  another error line",
    ]);
    expect(detectTemporalEvidence(evidence)).toEqual({
      kind: "absent",
      reason: "fewer_than_two_attempts",
    });
  });

  it("does not read a zero count as a failure", () => {
    // "0 failed" and "exit code 0" are success lines; certifying a pair from
    // them would invite a false repetition answer.
    expect(detectTemporalEvidence(ids(["$ npm test", "Tests  0 failed | 12 passed"]))).toEqual({
      kind: "absent",
      reason: "no_failure_visible",
    });
    expect(detectTemporalEvidence(ids(["$ make", "exit code 0"]))).toEqual({
      kind: "absent",
      reason: "no_failure_visible",
    });
    expect(detectTemporalEvidence(ids(["$ make", "exit code 1"]))).toEqual({
      kind: "absent",
      reason: "fewer_than_two_attempts",
    });
    expect(FAILURE_MARKERS.length).toBeGreaterThan(0);
  });

  it("reports no_failure_visible when nothing failed", () => {
    expect(detectTemporalEvidence(ids(["$ ls", "src  package.json", "done"]))).toEqual({
      kind: "absent",
      reason: "no_failure_visible",
    });
  });

  it("states the gap in the request note and never asks the comparison question", () => {
    const state = selectAwarenessInput(windowOf(["$ ls", "src  package.json", "done"]));

    expect(state.temporal.kind).toBe("absent");
    expect(state.temporalNote).toContain("not possible");
    expect(state.questions.map((q) => q.id)).not.toContain("concern.repetition");
    expect(state.skipped).toEqual([
      { questionId: "concern.repetition", reason: "temporal_pair_missing" },
    ]);
  });

  it("asks the comparison question and names both attempts when a pair exists", () => {
    const state = selectAwarenessInput(
      windowOf([
        "$ npm test",
        "Tests  2 failed",
        "FAIL src/a.test.ts",
        "",
        "$ npm test",
        "Tests  2 failed",
        "FAIL src/a.test.ts",
      ]),
    );
    const repetition = state.questions.find((q) => q.id === "concern.repetition");

    expect(state.temporal.kind).toBe("pair");
    expect(repetition).toBeDefined();
    expect(repetition?.optionIds).toEqual(["repeats", "different", "insufficient_evidence"]);
    expect(state.temporalNote).toContain("Attempt 1 is lines L000 to L002");
    expect(state.temporalNote).toContain("Attempt 2 is lines L004 to L006");
    expect(state.wire.note).toBe(state.temporalNote);
  });
});

// ---------------------------------------------------------------------------
// Request state shape
// ---------------------------------------------------------------------------

describe("awareness request state", () => {
  it("carries the observation identity and one acceptance policy per question", () => {
    const state = selectAwarenessInput(windowOf(["one", "two"]));

    expect(state.packVersion).toBe("awareness-pack/2");
    expect(state.bindingId).toBe("seat-1");
    expect(state.epoch).toBe("e1");
    expect(state.sourceSeq).toBe("42");
    expect(state.observedAt).toBe(OBSERVED_AT);
    expect(state.evidenceHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(state.caps).toEqual({
      candidateLines: MAX_EVIDENCE_CANDIDATE_LINES,
      evidenceBytes: MAX_EVIDENCE_BYTES,
      requestBytes: MAX_REQUEST_BYTES,
    });
    // 21 questions in the pack; the comparison question is skipped without a
    // temporal pair.
    expect(state.questions.length).toBe(20);
    const noul = state.questions.find((q) => q.kind === "noul");
    expect(noul?.acceptance).toEqual({
      minNoulProbability: 0.9,
      maxNoulAbsenceProbability: 0.1,
    });
    const highlight = state.questions.find((q) => q.id === "highlight.line");
    expect(highlight?.optionIds).toEqual(["L000", "L001", "NONE"]);
    expect(highlight?.acceptance).toEqual({ minConfidence: 0.8, minTopProbability: 0.8 });
    expect(highlight?.prompt).toContain("NONE");
  });

  it("orders questions by priority, highest first", () => {
    const state = selectAwarenessInput(windowOf(["one", "two"]));
    const priorities = state.questions.map((q) => q.priority);

    expect([...priorities].sort((a, b) => b - a)).toEqual(priorities);
    expect(state.questions[0]!.id).toBe("concern.approval_requested");
  });

  it("sends exactly the evidence block and question prompts it reports", () => {
    const state = selectAwarenessInput(windowOf(["one", "two"]));

    expect(state.wire.packVersion).toBe(state.packVersion);
    expect(state.wire.evidence).toBe(state.evidenceBlock);
    expect(state.wire.questions).toEqual(
      state.questions.map((question) => ({ id: question.id, prompt: question.prompt })),
    );
    expect(state.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(state.wire), "utf8"));
  });
});
