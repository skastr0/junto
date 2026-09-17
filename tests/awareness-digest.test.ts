/**
 * Awareness window digest — the coarse material screen revision.
 *
 * The frozen contract (docs/seat-awareness-plan.md §4) says the evidence
 * digest, the scheduler's cache key, and the renderer's staleness comparison
 * are the SAME normalization, exported once by this projection. These tests pin
 * that normalization from both sides:
 *
 *   1. every volatile class the contract names normalizes to one digest, and
 *      material text differences do not;
 *   2. over real corpus captures replayed through the real observer, two cuts
 *      that differ only by volatile chrome share a digest, while the previous
 *      exact-line hash moved on every single burst.
 *
 * The second half also cross-checks the digest against an independent
 * measurement: stripping volatile matches entirely (rather than replacing them
 * with the digest's placeholders) must agree that the difference was chrome and
 * not material.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@shared/work-canonical-json";
import { SessionObserver } from "../src/main/junto/term/observer";
import {
  VOLATILE_CHROME_RULES,
  WINDOW_DIGEST_VERSION,
  computeWindowDigest,
  normalizeVolatileChrome,
  selectAwarenessInput,
  windowDigestMaterial,
  type AwarenessEvidenceWindow,
  type AwarenessRequestState,
} from "../src/main/junto/term/awareness/select-input";
import { capturePath, chunkEvents, loadP1Fixture } from "./pty-e2e/runner";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const digestOf = (text: string): string =>
  computeWindowDigest({ bindingId: "seat-1", epoch: "e1", lines: [{ text }] });

/** Strip volatile matches ENTIRELY — an independent reading of the same idea. */
const stripVolatileChrome = (text: string): string => {
  let current = text;
  for (const rule of VOLATILE_CHROME_RULES) {
    current = current.replace(new RegExp(rule.pattern, rule.flags), "");
  }
  return current.replace(/[ \t]+$/u, "");
};

const stripBlock = (block: string): string =>
  block.split("\n").map(stripVolatileChrome).join("\n");

/** The previous contract: sha256 over the exact lines and the PTY sequence. */
const exactLineHash = (state: AwarenessRequestState): string =>
  createHash("sha256")
    .update(
      canonicalJson({
        bindingId: state.bindingId,
        epoch: state.epoch,
        sourceSeq: state.sourceSeq,
        lines: state.evidenceLines.map((line) => [line.id, line.text]),
      }),
      "utf8",
    )
    .digest("hex");

const windowOf = (
  lines: readonly string[],
  overrides: Partial<AwarenessEvidenceWindow> = {},
): AwarenessEvidenceWindow => ({
  bindingId: "seat-1",
  epoch: "e1",
  cols: 120,
  rows: 32,
  seq: 42n,
  lines,
  totalLines: lines.length,
  truncated: false,
  observedAt: 1_700_000_000_000,
  ...overrides,
});

type Cut = {
  readonly raw: string;
  readonly digest: string;
  readonly exact: string;
  readonly lineCount: number;
};

/** Replay one real capture in fixed byte cuts, projecting the window at each. */
const cutsOf = async (
  harness: string,
  scenario: string,
  chunkBytes: number,
): Promise<readonly Cut[]> => {
  const fixture = loadP1Fixture(harness, scenario);
  if (fixture === null) {
    throw new Error(`real capture missing: ${harness}/${scenario} (${capturePath(harness, scenario)})`);
  }
  const manifest = JSON.parse(
    readFileSync(join(dirname(capturePath(harness, "x")), "manifest.json"), "utf8"),
  ) as { pty: { cols: number; rows: number } };
  const observer = new SessionObserver({
    bindingId: "seat-1",
    epoch: "e1",
    cols: manifest.pty.cols,
    rows: manifest.pty.rows,
  });
  const cuts: Cut[] = [];
  let seq = 0n;
  try {
    for (const event of chunkEvents(fixture.events, "whole")) {
      for (let i = 0; i < event.data.length; i += chunkBytes) {
        seq += 1n;
        observer.feed(event.data.slice(i, i + chunkBytes), seq);
        const window = await observer.readWindow(256);
        const state = selectAwarenessInput({ ...window, observedAt: 0 });
        cuts.push({
          raw: state.evidenceBlock,
          digest: state.evidenceHash,
          exact: exactLineHash(state),
          lineCount: state.evidenceLines.length,
        });
      }
    }
  } finally {
    observer.dispose();
  }
  return cuts;
};

// ---------------------------------------------------------------------------
// The contract's volatile classes
// ---------------------------------------------------------------------------

describe("awareness window digest — volatile chrome normalizes to one digest", () => {
  const volatileCases: ReadonlyArray<{ readonly klass: string; readonly a: string; readonly b: string }> = [
    {
      klass: "spinner and animation frames (braille)",
      a: "⠂ Thinking…",
      b: "⠐ Thinking…",
    },
    {
      klass: "spinner and animation frames (braille run)",
      a: "⢠⡀ Thinking · 0s (esc twice to interrupt)",
      b: "⠀⠙ Thinking · 1s (esc twice to interrupt)",
    },
    {
      klass: "spinner and animation frames (status glyph)",
      a: "✳ Hashing…",
      b: "✻ Hashing…",
    },
    {
      klass: "elapsed-time counter",
      a: "✻ Churned for 2s",
      b: "✻ Churned for 47s",
    },
    {
      klass: "elapsed-time counter (status paren)",
      a: "✢ Imagining… (2s · ↓ 102 tokens · thinking)",
      b: "✢ Imagining… (31s · ↓ 4.2k tokens · thinking)",
    },
    {
      klass: "elapsed-time counter (turn footer)",
      a: "⠇ Thinking 0s (esc twice to interrupt)",
      b: "⠇ Thinking 12s (esc twice to interrupt)",
    },
    {
      klass: "token counters",
      a: "↓ 102 tokens",
      b: "↓ 900 tokens",
    },
    {
      klass: "token counters (context meter)",
      a: "Context: 44k / 200k tokens (21%)",
      b: "Context: 88k / 200k tokens (44%)",
    },
    {
      klass: "percent meter of a limit",
      a: "context: 0.0%/400k (auto)",
      b: "context: 12.5%/400k (auto)",
    },
    {
      klass: "cost meter",
      a: "$0.0021 · low",
      b: "$0.0413 · low",
    },
    {
      klass: "relative age and usage multiplier",
      a: "Prior capture session (5m ago) · synth-model-1 (1x usage)",
      b: "Prior capture session (2m ago) · synth-model-1 (3x usage)",
    },
    {
      klass: "byte counter",
      a: "wrote 45687 bytes",
      b: "wrote 12 bytes",
    },
    {
      klass: "sequence counter",
      a: "seq: 1234",
      b: "seq: 9999",
    },
    {
      klass: "cursor position (cell moved inside the line)",
      a: "❯ hello█",
      b: "❯ hello █",
    },
    {
      klass: "cursor position (scrollbar column present or not)",
      a: " ┃ PASTE_LINE_30                     █",
      b: " ┃ PASTE_LINE_30",
    },
    {
      klass: "repaint that leaves the visible text identical",
      a: "work-done",
      b: `work-done${" ".repeat(80)}`,
    },
  ];

  for (const entry of volatileCases) {
    it(`treats ${entry.klass} as volatile`, () => {
      // The inputs really do differ: this is not a case of two equal strings.
      expect(entry.a).not.toBe(entry.b);
      expect(normalizeVolatileChrome(entry.a)).toBe(normalizeVolatileChrome(entry.b));
      expect(digestOf(entry.a)).toBe(digestOf(entry.b));
    });
  }

  const materialCases: ReadonlyArray<{ readonly why: string; readonly a: string; readonly b: string }> = [
    { why: "a test count", a: "Tests  2 failed | 8 passed", b: "Tests  3 failed | 7 passed" },
    { why: "a zero count", a: "Tests  0 failed | 12 passed", b: "Tests  2 failed | 10 passed" },
    { why: "a failing versus a passing run", a: "FAIL src/a.test.ts", b: "PASS src/a.test.ts" },
    { why: "an exit status", a: "exit code 1", b: "exit code 0" },
    { why: "an error message", a: "Error: cannot find module 'left-pad'", b: "Error: cannot find module 'right-pad'" },
    { why: "a file path", a: "src/main/junto/term/awareness/questions.ts", b: "src/main/junto/term/awareness/select-input.ts" },
    { why: "a payload line", a: "PASTE_LINE_00", b: "PASTE_LINE_01" },
    { why: "a question versus a statement", a: "Should I delete the branch?", b: "Deleted the branch." },
    { why: "a count that is not a counter", a: "error count: 3", b: "error count: 4" },
    { why: "which event took the time", a: "✓ Build finished in 2s", b: "✗ Build failed in 2s" },
    { why: "which menu option is highlighted", a: "❯ 1. Yes", b: "❯ 3. No" },
    { why: "the status verb", a: "✻ Churned for 2s", b: "✻ Imagining…" },
    { why: "a line added", a: "$ npm test\nFAIL src/a.test.ts", b: "$ npm test\nFAIL src/a.test.ts\nError: boom" },
    { why: "a byte count versus a sequence counter", a: "seq: 1234", b: "wrote 1234 bytes" },
    { why: "an age versus a usage multiplier", a: "Prior session (5m ago)", b: "Prior session (1x usage)" },
  ];

  for (const entry of materialCases) {
    it(`keeps ${entry.why} material`, () => {
      expect(entry.a).not.toBe(entry.b);
      expect(normalizeVolatileChrome(entry.a)).not.toBe(normalizeVolatileChrome(entry.b));
      expect(digestOf(entry.a)).not.toBe(digestOf(entry.b));
    });
  }

  it("is idempotent, line-preserving, and one rule per declared id", () => {
    const ids = VOLATILE_CHROME_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(10);
    for (const rule of VOLATILE_CHROME_RULES) {
      expect(rule.why.length).toBeGreaterThan(20);
    }
    const sample = [
      "⠇ Thinking · 0s (esc twice to interrupt)",
      "✢ Imagining… (2s · ↓ 102 tokens · thinking)",
      " ┃ PASTE_LINE_30                     █",
      "plain material text with no chrome",
    ];
    for (const line of sample) {
      const once = normalizeVolatileChrome(line);
      expect(normalizeVolatileChrome(once)).toBe(once);
      // A line-level rewrite can never change the line count.
      expect(once.includes("\n")).toBe(false);
    }
  });

  /**
   * The scheduler uses this digest as cache key material, so a change to the
   * normalization or to the digest input must be a deliberate, visible edit.
   * This pinned value fails the moment either moves, and the fix is to bump
   * `WINDOW_DIGEST_VERSION` in the same change, which is what invalidates every
   * cache entry computed under the old rules.
   *
   * The normalized forms are pinned beside the digest so a failure says WHICH
   * class moved, not just that the digest changed.
   */
  it("pins the digest of a fixed sample as cache-key cement", () => {
    const lines = [
      "⠂ Thinking…",
      "✢ Imagining… (2s · ↓ 102 tokens · thinking)",
      "Context: 44k / 200k tokens (21%)",
      " ┃ PASTE_LINE_30                     █",
      "Tests  2 failed | 8 passed",
      "seq: 1234",
      "wrote 45687 bytes",
      "Prior capture session (5m ago) · synth-model-1 (1x usage)",
    ];
    expect(WINDOW_DIGEST_VERSION).toBe(1);
    expect(lines.map(normalizeVolatileChrome)).toEqual([
      "* Thinking…",
      "* Imagining… (<t> · ↓ <tokens> · thinking)",
      "Context: <n>/<n> tokens (<pct>)",
      " ┃ PASTE_LINE_30",
      "Tests  2 failed | 8 passed",
      "seq: <n>",
      "wrote <bytes>",
      "Prior capture session (<ago>) · synth-model-1 (<usage>)",
    ]);
    expect(
      computeWindowDigest({
        bindingId: "seat-1",
        epoch: "e1",
        lines: lines.map((text) => ({ text })),
      }),
    ).toBe("783f835c52e0cd9aa8505321b1e69b66706be2177ee4d3b6302ec14e4f1b3155");
  });

  it("participates the rule-set version, so a rule change cannot reuse an old key", () => {
    const material = windowDigestMaterial({
      bindingId: "seat-1",
      epoch: "e1",
      lines: [{ text: "⠂ Thinking…" }],
    }) as { version: unknown; lines: unknown };
    expect(material.version).toBe(WINDOW_DIGEST_VERSION);
    expect(Number.isInteger(WINDOW_DIGEST_VERSION)).toBe(true);
    expect(material.lines).toEqual(["* Thinking…"]);
  });

  it("separates observations by binding and generation, and ignores the burst", () => {
    const lines = [{ text: "⠂ Thinking…" }];
    const base = computeWindowDigest({ bindingId: "seat-1", epoch: "e1", lines });
    expect(computeWindowDigest({ bindingId: "seat-2", epoch: "e1", lines })).not.toBe(base);
    expect(computeWindowDigest({ bindingId: "seat-1", epoch: "e2", lines })).not.toBe(base);
    expect(computeWindowDigest({ bindingId: "seat-1", epoch: "e1", lines })).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("does not move on a re-read of the same material screen", () => {
    const lines = ["⠂ Thinking…", "  still here", ""];
    const first = selectAwarenessInput(windowOf(lines, { seq: 10n }));
    // A later burst that changes only the PTY sequence and the wall clock.
    const later = selectAwarenessInput(
      windowOf(lines, { seq: 9_999n, observedAt: first.observedAt + 5_000 }),
    );
    expect(later.evidenceHash).toBe(first.evidenceHash);
    expect(later.sourceSeq).not.toBe(first.sourceSeq);
    expect(later.observedAt).not.toBe(first.observedAt);

    // A material change in the same window does move it.
    const changed = selectAwarenessInput(windowOf(["⠂ Thinking…", "  moved on", ""]));
    expect(changed.evidenceHash).not.toBe(first.evidenceHash);
  });
});

// ---------------------------------------------------------------------------
// Real corpus cuts
// ---------------------------------------------------------------------------

const CUT_CAPTURES: ReadonlyArray<{ readonly harness: string; readonly scenario: string }> = [
  { harness: "claude", scenario: "working-turn" },
  { harness: "claude", scenario: "type-echo" },
  { harness: "amp", scenario: "working-turn" },
  { harness: "devin", scenario: "working-turn" },
  { harness: "omp", scenario: "working-turn" },
  { harness: "grok", scenario: "working-turn" },
  { harness: "codex", scenario: "type-echo" },
  { harness: "muse", scenario: "paste-chip" },
];

describe("awareness window digest over real corpus cuts", () => {
  for (const { harness, scenario } of CUT_CAPTURES) {
    it(
      `${harness}/${scenario}: cuts differing only by volatile chrome share a digest`,
      async () => {
        const cuts = await cutsOf(harness, scenario, 400);
        expect(cuts.length).toBeGreaterThan(10);

        let differing = 0;
        let sameDigest = 0;
        let exactMoved = 0;

        for (let i = 1; i < cuts.length; i += 1) {
          const before = cuts[i - 1]!;
          const after = cuts[i]!;
          if (before.raw === after.raw) continue;
          differing += 1;
          if (before.exact !== after.exact) exactMoved += 1;

          const digestEqual = before.digest === after.digest;
          if (digestEqual) {
            sameDigest += 1;
            // Line-preserving normalization: a shared digest means the same
            // number of evidence lines, so an id resolves to the same position.
            expect(before.lineCount).toBe(after.lineCount);
            // Independent cross-check: with volatile matches removed entirely,
            // the two cuts are the same text. If this failed, the digest would
            // be hiding a material difference.
            expect(stripBlock(before.raw)).toBe(stripBlock(after.raw));
          }
        }

        // The measured shape: on a continuously printing seat the raw evidence
        // changes on nearly every burst, the material digest correctly holds on
        // the subset that differs only by chrome, and it still moves on the
        // rest. `exactMoved === differing` guards the BASELINE: the comparison
        // is only meaningful while `exactLineHash` really is the old
        // per-burst hash over the raw lines.
        expect(differing).toBeGreaterThan(0);
        expect(sameDigest).toBeGreaterThan(0);
        expect(sameDigest).toBeLessThan(differing);
        expect(exactMoved).toBe(differing);
      },
      60_000,
    );
  }

  it(
    "holds the same digest for two cuts of one capture that differ only in chrome",
    async () => {
      // A pinned, human-readable example from the real stream: Claude's status
      // glyph churns between frames while the status text stays put.
      const cuts = await cutsOf("claude", "working-turn", 400);
      const pair = cuts.find((cut, index) => {
        const next = cuts[index + 1];
        if (next === undefined || cut.raw === next.raw) return false;
        return cut.digest === next.digest && /[\u2722\u2733\u2736\u2737\u273b\u273d]/u.test(cut.raw);
      });
      expect(pair).toBeDefined();
      expect(pair!.digest).toMatch(/^[0-9a-f]{64}$/u);
    },
    60_000,
  );
});
