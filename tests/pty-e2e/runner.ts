/**
 * pty-e2e runner (Agent B) — fixture loading, chunking, canonicality gate,
 * golden-grid capture, seat-state assertion helpers.
 *
 * Pipeline per scenario (spec §anti-hacking):
 *   1. loadFixture: try P1 real captures under /tmp/vellum-pty-fixtures first;
 *      fall back to the built-in P2/P3 receipt tables below (every byte
 *      sequence is grounded in the 2026-08 managed-terminal probe reports
 *      and the agent-CLI sweep — no invented streams).
 *   2. Chunk the byte stream in three modes (whole / split-at-escapes /
 *      split-mid-sequence) and feed EVERY mode through a REAL SessionObserver
 *      (same read side as production) — never hand-built snapshots.
 *   3. Canonicality gate: assert the expected screen truth (title, osc9,
 *      prompt glyph) on the observer output BEFORE any behavior assertion.
 *      Unvalidated fixture = no test.
 *   4. Feed the gated snapshots through a FRESH SeatStateRuntime per mode and
 *      assert golden grid + event-stream equality across chunk modes.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { SessionObserver } from "../../src/main/vellum-command/term/observer";
import { SeatStateRuntime } from "../../src/main/vellum-command/term/agent-state/runtime";
import type { AgentSeatStateEvent } from "../../src/shared/agent-seat-state";
import type { ObserverGridSnapshot } from "../../src/main/vellum-command/term/observer/types";

// ---------------------------------------------------------------------------
// Corpus / fixture types
// ---------------------------------------------------------------------------

export type FixtureSource = "P1" | "P2" | "P3";

/** One captured/synthesized PTY write. */
export interface FixtureEvent {
  /** ms since stream start (P1: wall-clock epoch ms; informational). */
  readonly t: number;
  /** base64 of the raw bytes for that write. */
  readonly b64: string;
}

/** Screen truth the canonicality gate must observe before a test may run. */
export interface ExpectedScreen {
  readonly description: string;
  /** Exact sanitized OSC 0/2 title expected after feeding. */
  readonly title?: string;
  /** Exact OSC 9 payload (after "9;") expected after feeding. */
  readonly osc9?: string;
  /** A line whose trimmed form starts with this glyph must be present. */
  readonly promptGlyph?: string;
  /** When true, no line may start with a composer glyph (❯ > ❭ › …). */
  readonly noPromptGlyph?: boolean;
}

export interface Fixture {
  readonly harness: string;
  readonly scenario: string;
  readonly source: FixtureSource;
  readonly title: string;
  readonly events: readonly FixtureEvent[];
  readonly expectedScreen: ExpectedScreen;
  /** Grounding: probe doc + section that supplied the receipts. */
  readonly provenance: string;
}

// ---------------------------------------------------------------------------
// Byte receipts (P2/P3) — grounded in the managed-terminal probes
// ---------------------------------------------------------------------------

export const b64 = (s: string): string =>
  Buffer.from(s, "utf8").toString("base64");

/**
 * P2/P3 receipt tables. Every stream is composed from VERIFIED byte receipts:
 *  - K9 (claude-code-tui.md): `ESC]0;<glyph> <title>BEL`, `ESC]9;4;3BEL` /
 *    `ESC]9;4;0BEL`; idle title prefix ✳ (U+2733), working braille frames
 *    ⠂/⠐ (U+2802/U+2810); empty title on exit; `ESC[?2004h` at startup.
 *  - K3 (claude-code-tui.md): grid layout — prompt box between ─── rules,
 *    composer line starts with ❯ (U+276F); ctrl+c clears the buffer.
 *  - C1 (codex-tui-probe.md): `ESC]0;⠇ p1BEL` working spinner title; idle
 *    title is the cwd basename (`ESC]0;p1`); `ESC[?2004h` at startup.
 *  - G11 (grok-tui-probe.md): idle titles `grok` / `<session title> - grok`;
 *    OSC 9;4;1;-1 working / 9;4;0;0 idle; idle footer
 *    `Shift+Tab:mode │ Ctrl+;:queue │ Ctrl+.:shortcuts`.
 *  - kimi.md: static `ESC]0;Kimi CodeBEL`; idle = prompt `> ` + footer
 *    `context: 0% (0/1M)`.
 *  - pi.md: static title `π - <name> - <cwd>`; OSC 9;4 off by default.
 *  - prime-agent.md: `ESC]9;4;3BEL` working keepalive / `ESC]9;4;0BEL` on
 *    agent_end; static title `prime-agent - <name> - <cwd>`.
 * P3 compositions splice receipts across probes (e.g. real idle grid + real
 * braille title OSC) exactly as the spec allows.
 */
export const BUILTIN_FIXTURES: ReadonlyArray<Fixture> = [
  // ---- R1: claude empty prompt box (❯) + braille OSC title ----------------
  {
    harness: "claude",
    scenario: "r1-empty-prompt-box-braille-title",
    source: "P3",
    title: "R1 claude empty prompt box (❯) + braille title → idle",
    provenance:
      "P3: K9 receipts (braille title `ESC]0;⠂ Claude Code BEL`, OSC 9;4;0 idle flag, `ESC[?2004h`) + K3 grid layout (prompt box between ─── rules, empty composer `❯`)",
    events: [
      { t: 0, b64: b64("\x1b[?2004h\r\n") },
      { t: 50, b64: b64("welcome to Claude Code\r\n") },
      { t: 100, b64: b64("────────────────\r\n") },
      { t: 150, b64: b64("❯ \r\n") },
      { t: 200, b64: b64("────────────────\r\n") },
      { t: 250, b64: b64("\x1b]9;4;0\x07") },
      { t: 300, b64: b64("\x1b]0;⠂ Claude Code\x07") },
    ],
    expectedScreen: {
      description: "empty composer box with ❯ glyph + STALE braille working title + osc9 4;0 (false-busy receipt)",
      title: "⠂ Claude Code",
      osc9: "4;0",
      promptGlyph: "❯",
    },
  },
  // ---- R1c: claude REAL-WORKING receipt (live-test regression) -------------
  {
    harness: "claude",
    scenario: "r1c-real-working-receipt",
    source: "P3",
    title: "R1c claude genuinely working: braille title + OSC 9;4;3 + empty composer → working",
    provenance:
      "P3: K9 working receipts — braille title `ESC]0;⠂ Claude Code BEL` + `ESC]9;4;3BEL` + K3 grid (Claude keeps an EMPTY `❯` composer on screen while streaming). Identical to r1's original bytes; the deterministic 4;3 flag is what separates real working from the stale-title false busy (r1, 4;0).",
    events: [
      { t: 0, b64: b64("\x1b[?2004h\r\n") },
      { t: 50, b64: b64("welcome to Claude Code\r\n") },
      { t: 100, b64: b64("────────────────\r\n") },
      { t: 150, b64: b64("❯ \r\n") },
      { t: 200, b64: b64("────────────────\r\n") },
      { t: 250, b64: b64("\x1b]9;4;3\x07") },
      { t: 300, b64: b64("\x1b]0;⠂ Claude Code\x07") },
    ],
    expectedScreen: {
      description: "empty composer box with ❯ glyph + braille working title + osc9 4;3",
      title: "⠂ Claude Code",
      osc9: "4;3",
      promptGlyph: "❯",
    },
  },
  // ---- R1b: claude empty prompt box (ASCII >) + braille OSC title ----------
  {
    harness: "claude",
    scenario: "r1b-empty-prompt-box-ascii-gt-braille-title",
    source: "P3",
    title: "R1 claude empty prompt box (>) + braille title → idle",
    provenance:
      "P3: same K9 receipts as r1; composer line uses ASCII `> ` (claude.ts live_prompt_box explicitly matches both ❯ and > across versions)",
    events: [
      { t: 0, b64: b64("\x1b[?2004h\r\n") },
      { t: 50, b64: b64("welcome to Claude Code\r\n") },
      { t: 100, b64: b64("────────────────\r\n") },
      { t: 150, b64: b64("> \r\n") },
      { t: 200, b64: b64("────────────────\r\n") },
      // Law-aligned (live test): 4;3 + braille + empty composer is the
      // REAL-WORKING receipt (covered by r1c); the ASCII-> false-busy case
      // carries the idle flag 4;0 with the stale braille title.
      { t: 250, b64: b64("\x1b]9;4;0\x07") },
      { t: 300, b64: b64("\x1b]0;⠐ Claude Code\x07") },
    ],
    expectedScreen: {
      description: "empty composer box with ASCII > glyph + stale braille title + osc9 4;0",
      title: "⠐ Claude Code",
      osc9: "4;0",
      promptGlyph: ">",
    },
  },
  // ---- R2: claude draft chip + braille title (sanity) ----------------------
  {
    harness: "claude",
    scenario: "r2-draft-chip-braille-title",
    source: "P3",
    title: "R2 claude draft chip ([Pasted text …]) + braille title → idle",
    provenance:
      "P3: K9 braille-title receipt + draft-chip composer line (parent-specified literal `[Pasted text #3 +12 lines]`, matching K3's multi-line paste-in-composer behavior)",
    events: [
      { t: 0, b64: b64("\x1b[?2004h\r\n") },
      { t: 50, b64: b64("welcome to Claude Code\r\n") },
      { t: 100, b64: b64("────────────────\r\n") },
      { t: 150, b64: b64("❯ [Pasted text #3 +12 lines]\r\n") },
      { t: 200, b64: b64("────────────────\r\n") },
      { t: 250, b64: b64("\x1b]9;4;0\x07") },
      { t: 300, b64: b64("\x1b]0;⠂ Claude Code\x07") },
    ],
    expectedScreen: {
      description: "draft chip in composer + stale braille title + osc9 4;0 (chip is composer chrome → idle)",
      title: "⠂ Claude Code",
      osc9: "4;0",
      promptGlyph: "❯",
    },
  },
  // ---- R3: claude osc9 4;0 idle, empty title -------------------------------
  {
    harness: "claude",
    scenario: "r3-osc9-idle-empty-title",
    source: "P3",
    title: "R3 claude osc9 4;0 + empty title → isSeatIdle true",
    provenance:
      "P3: K9 exit/clear receipt (title emptied + `ESC]9;4;0BEL`) with a neutral grid (no composer glyph) so the OSC-idle rule is the only idle evidence — exactly the state where osc9_idle's missing visibleIdle decides paste auth",
    events: [
      { t: 0, b64: b64("\x1b[?2004h\r\n") },
      { t: 50, b64: b64("transcript line\r\n") },
      { t: 100, b64: b64("another line\r\n") },
      { t: 150, b64: b64("\x1b]9;4;0\x07") },
      { t: 200, b64: b64("\x1b]0;\x07") },
    ],
    expectedScreen: {
      description: "empty title + osc9 4;0 + no composer glyph",
      title: "",
      osc9: "4;0",
      noPromptGlyph: true,
    },
  },
  // ---- OBS-4: paste chip + STALE permission text in the scrollback tail ----
  // P3: K2 control-arm dialog receipts ("Do you want to proceed?" / "❯ 1. Yes" /
  // "Esc to cancel - Tab to amend - ctrl+e to explain") + K3 chip composer box.
  // D4: legacy_permission_blocker (1150) and composer_draft_idle (1150) tie and
  // array order gives the stale scrollback permission text the win.
  {
    harness: "claude",
    scenario: "obs4-chip-stale-permission",
    source: "P3",
    title: "OBS-4 claude paste chip + stale permission text in scrollback tail → idle",
    provenance:
      "P3: K2 control-arm dialog (claude-code-tui.md res-k2 grid: `Bash command` / `ls -la /tmp` / `Do you want to proceed?` / `❯ 1. Yes` / `Esc to cancel - Tab to amend - ctrl+e to explain`) + K3 chip composer box (`❯ [Pasted text #3 +12 lines]` between ─── rules)",
    events: [
      { t: 0, b64: b64("\x1b[?2004h\r\n") },
      {
        t: 50,
        b64: b64(
          "Bash command\r\n" +
            "  ls -la /tmp\r\n" +
            "  List files in /tmp directory\r\n" +
            "Do you want to proceed?\r\n" +
            "❯ 1. Yes\r\n" +
            "  2. Yes, allow reading from tmp/ from this project\r\n" +
            "  3. No\r\n" +
            "Esc to cancel - Tab to amend - ctrl+e to explain\r\n",
        ),
      },
      {
        t: 100,
        b64: b64(
          "────────────────────────────────────────────────────────────\r\n" +
            "❯ [Pasted text #3 +12 lines]\r\n" +
            "────────────────────────────────────────────────────────────\r\n" +
            "esc to interrupt\r\n",
        ),
      },
      { t: 150, b64: b64("\x1b]0;✳ Claude Code\x07") },
      { t: 200, b64: b64("\x1b]9;4;0\x07") },
    ],
    expectedScreen: {
      description: "paste chip in composer + stale permission dialog in scrollback + ✳ title",
      title: "✳ Claude Code",
      osc9: "4;0",
      promptGlyph: "❯",
    },
  },
  // ---- OBS-5a: idle empty prompt + STALE permission text (claude) ----------
  // P3: same K2 dialog receipts; composer is the bare `❯ ` idle glyph. The
  // legacy_permission_blocker not-gate `(?m)^\s*❯\s*$` is an INVALID regex
  // under the `u` flag (silently never blocks), so the stale scrollback text
  // still pins attention today.
  {
    harness: "claude",
    scenario: "obs5-idle-stale-permission",
    source: "P3",
    title: "OBS-5 claude idle prompt + stale permission text → idle",
    provenance:
      "P3: K2 control-arm dialog receipts + K3 bare `❯ ` composer (same grid as obs4 with an EMPTY composer)",
    events: [
      { t: 0, b64: b64("\x1b[?2004h\r\n") },
      {
        t: 50,
        b64: b64(
          "Bash command\r\n" +
            "  ls -la /tmp\r\n" +
            "  List files in /tmp directory\r\n" +
            "Do you want to proceed?\r\n" +
            "❯ 1. Yes\r\n" +
            "  2. Yes, allow reading from tmp/ from this project\r\n" +
            "  3. No\r\n" +
            "Esc to cancel - Tab to amend - ctrl+e to explain\r\n",
        ),
      },
      {
        t: 100,
        b64: b64(
          "────────────────────────────────────────────────────────────\r\n" +
            "❯ \r\n" +
            "────────────────────────────────────────────────────────────\r\n" +
            "esc to interrupt\r\n",
        ),
      },
      { t: 150, b64: b64("\x1b]0;✳ Claude Code\x07") },
      { t: 200, b64: b64("\x1b]9;4;0\x07") },
    ],
    expectedScreen: {
      description: "bare ❯ composer + stale permission dialog + ✳ title",
      title: "✳ Claude Code",
      osc9: "4;0",
      promptGlyph: "❯",
    },
  },
  // ---- OBS-5b: codex idle prompt + STALE permission text -------------------
  // P3: codex idle chrome (cwd-basename title, `› ` prompt, model footer) +
  // P13 approval-modal receipts (codex-tui-probe.md: `Would you like to run the
  // following command?` / `$ printenv HOME` / `› 1. Yes, proceed (y)`).
  // codex weak_attention (600, whole_recent) pins attention from scrollback.
  {
    harness: "codex",
    scenario: "obs5-codex-idle-stale-permission",
    source: "P3",
    title: "OBS-5 codex idle prompt + stale approval text → idle",
    provenance:
      "P3: codex idle receipts (C1: `ESC]0;codex BEL` title + `› ` prompt + model footer from the capture) + P13 approval-modal receipts (codex-tui-probe.md)",
    events: [
      { t: 0, b64: b64("\x1b[?2004h\r\n") },
      {
        t: 50,
        b64: b64(
          "Would you like to run the following command?\r\n" +
            "Environment: local\r\n" +
            "$ printenv HOME\r\n" +
            "› 1. Yes, proceed (y)\r\n" +
            "2. Yes, and don't ask again for commands that start with `printenv HOME` (p)\r\n" +
            "3. No, and tell Codex what to do differently (esc)\r\n",
        ),
      },
      { t: 100, b64: b64("› \r\nImprove documentation in @filename\r\ngpt-5.4-mini low \u00b7 cwd\r\n") },
      { t: 150, b64: b64("\x1b]0;codex\x07") },
    ],
    expectedScreen: {
      description: "codex idle prompt + stale approval modal in scrollback + codex title",
      title: "codex",
      promptGlyph: "›",
    },
  },
  // ---- OBS-18: braille title then idle-screen redraw WITHOUT a new title ----
  // P3: K9 braille-title receipt fed FIRST, then the K3 idle redraw (prompt
  // box) with NO title OSC — the observer never expires the title, so the
  // stale braille frame keeps osc_title_working (1100) above live_prompt_box
  // (950) forever.
  {
    harness: "claude",
    scenario: "obs18-stale-braille-title-redraw",
    source: "P3",
    title: "OBS-18 stale braille title + idle prompt redraw (no new title) → idle",
    provenance:
      "P3: K9 braille-title receipt (`ESC]0;⠂ Claude Code BEL` + OSC 9;4;0 idle flag) BEFORE the K3 idle grid redraw (`───` box + `❯ ` + footer) with no title OSC after it — the false-busy receipt (turn ended, title stale). The 4;3 + fresh-redraw shape is REAL working and is covered by r1c.",
    events: [
      { t: 0, b64: b64("\x1b[?2004h\r\n") },
      { t: 50, b64: b64("\x1b]0;⠂ Claude Code\x07\x1b]9;4;0\x07") },
      { t: 100, b64: b64("some output\r\n") },
      {
        t: 150,
        b64: b64(
          "────────────────────────────────────────────────────────────\r\n" +
            "❯ \r\n" +
            "────────────────────────────────────────────────────────────\r\n" +
            "esc to interrupt\r\n",
        ),
      },
    ],
    expectedScreen: {
      description: "stale braille title + osc9 4;0 + fresh idle prompt box redraw",
      title: "⠂ Claude Code",
      osc9: "4;0",
      promptGlyph: "❯",
    },
  },

  // ---- R5: claude braille churn frames (progressFingerprint) --------------
  {
    harness: "claude",
    scenario: "r5-braille-churn-frames",
    source: "P3",
    title: "R5 claude braille title churn while working",
    provenance:
      "P3: K9 spinner-frame receipts (⠂/⠐ alternating ~1 Hz while working) + `ESC]9;4;3BEL` working flag",
    events: [
      { t: 0, b64: b64("\x1b]9;4;3\x07") },
      { t: 100, b64: b64("\x1b]0;⠂ Claude Code\x07") },
      { t: 1100, b64: b64("\x1b]0;⠐ Claude Code\x07") },
      { t: 2100, b64: b64("\x1b]0;⠂ Claude Code\x07") },
      { t: 3100, b64: b64("\x1b]0;⠐ Claude Code\x07") },
    ],
    expectedScreen: {
      description: "osc9 4;3 working + final braille frame ⠐",
      title: "⠐ Claude Code",
      osc9: "4;3",
    },
  },
  // ---- R6: cross-harness idle captures (P2/P3 composition) ----------------
  {
    harness: "codex",
    scenario: "r6-codex-idle",
    source: "P3",
    title: "R6 codex idle (cwd-basename title) → idle + pasteable",
    provenance:
      "P2: C1 receipt `ESC]0;p1 BEL` (idle title = cwd basename), `ESC[?2004h` at startup; grid from the probe transcript surface",
    events: [
      { t: 0, b64: b64("\x1b[?2004h\r\n") },
      { t: 50, b64: b64("Codex — deep-field station\r\n") },
      { t: 100, b64: b64("──────────────────────────\r\n") },
      { t: 150, b64: b64("› \r\n") },
      { t: 200, b64: b64("──────────────────────────\r\n") },
      { t: 250, b64: b64("\x1b]0;p1\x07") },
    ],
    expectedScreen: {
      description: "codex idle: non-spinner title `p1`",
      title: "p1",
    },
  },
  {
    harness: "grok",
    scenario: "r6-grok-idle",
    source: "P3",
    title: "R6 grok idle (bare `grok` title) → idle + pasteable",
    provenance:
      "P2: G11 receipt — idle-before-first-turn title is exactly `grok`; idle footer `Shift+Tab:mode │ Ctrl+;:queue │ Ctrl+.:shortcuts`",
    events: [
      { t: 0, b64: b64("\r\n") },
      { t: 50, b64: b64("grok build\r\n") },
      { t: 100, b64: b64("Shift+Tab:mode │ Ctrl+;:queue │ Ctrl+.:shortcuts\r\n") },
      { t: 150, b64: b64("\x1b]0;grok\x07") },
    ],
    expectedScreen: {
      description: "grok idle: title exactly `grok`, idle footer",
      title: "grok",
    },
  },
  {
    harness: "kimi",
    scenario: "r6-kimi-idle",
    source: "P3",
    title: "R6 kimi idle (static title + prompt/footer) → idle + pasteable",
    provenance:
      "P2: kimi.md receipt — static `ESC]0;Kimi CodeBEL` (dead title), idle chrome `> ` prompt + `context: 0% (0/1M)` footer",
    events: [
      { t: 0, b64: b64("\r\n") },
      { t: 50, b64: b64("> \r\n") },
      { t: 100, b64: b64("context: 0% (0/1M)\r\n") },
      { t: 150, b64: b64("\x1b]0;Kimi Code\x07") },
    ],
    expectedScreen: {
      description: "kimi idle: `> ` prompt + context footer + static title",
      title: "Kimi Code",
      promptGlyph: ">",
    },
  },
  {
    harness: "pi",
    scenario: "r6-pi-idle",
    source: "P3",
    title: "R6 pi idle (static π title) → idle + pasteable",
    provenance:
      "P2: pi.md receipt — static OSC title `π - <session> - <cwd>`; OSC 9;4 off by default; no live status line at idle",
    events: [
      { t: 0, b64: b64("\r\n") },
      { t: 50, b64: b64("pi session\r\n") },
      { t: 100, b64: b64("\x1b]0;π - session - cwd\x07") },
    ],
    expectedScreen: {
      description: "pi idle: static π title",
      title: "π - session - cwd",
    },
  },
  {
    harness: "prime-agent",
    scenario: "r6-prime-agent-idle",
    source: "P3",
    title: "R6 prime-agent idle (static title + osc9 4;0) → idle + pasteable",
    provenance:
      "P2: prime-agent.md receipts — `ESC]9;4;0BEL` on agent_end/exit; static title `prime-agent - <session> - <cwd>`",
    events: [
      { t: 0, b64: b64("\r\n") },
      { t: 50, b64: b64("prime-agent session\r\n") },
      { t: 100, b64: b64("\x1b]9;4;0\x07") },
      { t: 150, b64: b64("\x1b]0;prime-agent - session - cwd\x07") },
    ],
    expectedScreen: {
      description: "prime-agent idle: osc9 4;0 + static title",
      title: "prime-agent - session - cwd",
      osc9: "4;0",
    },
  },
];

const BUILTIN_BY_KEY = new Map(
  BUILTIN_FIXTURES.map((f) => [`${f.harness}/${f.scenario}`, f]),
);

// ---------------------------------------------------------------------------
// Fixture loading: P1 corpus first, then built-in P2/P3 tables
// ---------------------------------------------------------------------------

/**
 * Canonical corpus root: `tests/pty-e2e/corpus/<harness>/<scenario>.jsonl`
 * (+ per-harness `manifest.json`). `VELLUM_PTY_CORPUS` overrides it — the
 * transition hatch while the captures move in-repo; it must name a real
 * directory or resolution fails.
 *
 * A missing corpus is NEVER a skip. Callers that need real bytes use
 * `requireCapture`, which throws with the path it looked for.
 */
const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), "corpus");

export const corpusRoot = (): string => process.env.VELLUM_PTY_CORPUS ?? CORPUS_DIR;

/** Absolute path of one capture. Does not check existence. */
export const capturePath = (harness: string, scenario: string): string =>
  join(corpusRoot(), harness, `${scenario}.jsonl`);

/**
 * What the committed manifest DECLARES about one scenario.
 *
 * A harness can genuinely be unable to produce a screen (pi renders no paste
 * chip at all), and the capture tool records that as `status: "skip"` with a
 * reason. That is a reviewed, auditable absence — different in kind from
 * "nobody captured it yet", and the only absence a test may accept. It is
 * still not a silent skip: the declaration itself is what gets asserted.
 */
export const captureDeclaration = (
  harness: string,
  scenario: string,
): { readonly status?: string; readonly reason?: string } | null => {
  const manifestPath = join(corpusRoot(), harness, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    scenarios?: Array<Record<string, unknown>>;
  };
  const entry = manifest.scenarios?.find((s) => s.scenario === scenario);
  if (!entry) return null;
  return {
    ...(typeof entry.status === "string" ? { status: entry.status } : {}),
    ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
  };
};

/**
 * Resolve one real capture or THROW. The loud half of the corpus contract:
 * an absent corpus fails the suite red instead of passing as a silent skip.
 */
export function requireCapture(harness: string, scenario: string): LoadedFixture {
  const fixture = loadP1Fixture(harness, scenario);
  if (fixture) return fixture;
  const file = capturePath(harness, scenario);
  throw new Error(
    `real capture missing: ${harness}/${scenario}\n` +
      `  looked for: ${file}\n` +
      `  corpus root: ${corpusRoot()}${process.env.VELLUM_PTY_CORPUS ? " (VELLUM_PTY_CORPUS)" : " (canonical)"}\n` +
      `  capture it with tests/pty-e2e/pty-capture.ts — a missing corpus is a red suite, never a skip.`,
  );
}

export interface LoadedFixture extends Fixture {
  /** Absolute path of the P1 corpus file, when source === "P1". */
  readonly corpusPath?: string;
}

/**
 * Manifest `expectedScreen` → the gate's key names.
 *
 * The capture manifests wrote `idleTitle` / `osc9Idle` while `gateFixture`
 * reads `title` / `osc9`, and every gate assertion is guarded by an
 * undefined-check — so on a real capture the title and osc9 checks silently
 * never ran. Normalizing here means a legacy manifest still gates; the
 * capture side emits the canonical names going forward.
 */
const normalizeExpectedScreen = (raw: Record<string, unknown>): ExpectedScreen => {
  const pick = (...keys: ReadonlyArray<string>): string | undefined => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === "string") return value;
    }
    return undefined;
  };
  const title = pick("title", "idleTitle");
  const osc9 = pick("osc9", "osc9Idle");
  const promptGlyph = pick("promptGlyph");
  const description = pick("description");
  return {
    description: description ?? "P1 corpus manifest expectedScreen",
    ...(title !== undefined ? { title } : {}),
    ...(osc9 !== undefined ? { osc9 } : {}),
    ...(promptGlyph !== undefined ? { promptGlyph } : {}),
    ...(raw.noPromptGlyph === true ? { noPromptGlyph: true as const } : {}),
  };
};

/** Read a P1 jsonl corpus scenario (with manifest, when present). */
export function loadP1Fixture(
  harness: string,
  scenario: string,
): LoadedFixture | null {
  const file = capturePath(harness, scenario);
  if (!existsSync(file)) return null;
  const events: FixtureEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const parsed = JSON.parse(t) as FixtureEvent;
    events.push({ t: parsed.t, b64: parsed.b64 });
  }
  const manifestPath = join(corpusRoot(), harness, "manifest.json");
  let expectedScreen: ExpectedScreen = {
    description: "P1 corpus manifest did not specify screen truth",
  };
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      scenarios?: Array<Record<string, unknown>>;
    };
    const entry = manifest.scenarios?.find((s) => s.scenario === scenario);
    const esc = entry?.expectedScreen as Record<string, unknown> | undefined;
    if (esc && typeof esc === "object") expectedScreen = normalizeExpectedScreen(esc);
  }
  return {
    harness,
    scenario,
    source: "P1",
    title: `P1 ${harness}/${scenario}`,
    events,
    expectedScreen,
    provenance: `P1 real capture ${file} (sanitized per manifest)`,
    corpusPath: file,
  };
}

/**
 * Load a fixture for (harness, scenario). P1 real captures win; anything else
 * falls back to the built-in P2/P3 receipt tables.
 */
export function loadFixture(harness: string, scenario: string): LoadedFixture {
  const p1 = loadP1Fixture(harness, scenario);
  if (p1) return p1;
  const builtin = BUILTIN_BY_KEY.get(`${harness}/${scenario}`);
  if (!builtin) {
    throw new Error(
      `no fixture for ${harness}/${scenario}: no P1 corpus file and no built-in P2/P3 receipt table`,
    );
  }
  return builtin;
}

// ---------------------------------------------------------------------------
// Chunking — three realistic delivery modes
// ---------------------------------------------------------------------------

export type ChunkMode = "whole" | "split-at-escapes" | "split-mid-sequence";

export const CHUNK_MODES: readonly ChunkMode[] = [
  "whole",
  "split-at-escapes",
  "split-mid-sequence",
];

/**
 * Split one byte string into chunks for the given delivery mode.
 *  - whole:              the event stays one write (natural PTY write size).
 *  - split-at-escapes:   chunk boundaries at every ESC — each escape sequence
 *                        (ESC … terminator) arrives whole in one chunk, plain
 *                        text between sequences is its own chunk (real TUIs
 *                        repaint in many small writes).
 *  - split-mid-sequence: fixed-size chunks that cut INSIDE escape sequences
 *                        (worst case: a partial OSC/CSI arrives mid-chunk).
 */
export function chunkBytes(data: string, mode: ChunkMode): string[] {
  if (data.length === 0) return [""];
  if (mode === "whole") return [data];
  if (mode === "split-at-escapes") {
    const out: string[] = [];
    let acc = "";
    for (let i = 0; i < data.length; i++) {
      const ch = data[i]!;
      if (ch === "\x1b") {
        if (acc.length > 0) {
          out.push(acc);
          acc = "";
        }
        // Consume the whole escape sequence (BEL / ST / CSI final byte).
        let j = i + 1;
        while (j < data.length) {
          const c = data[j]!;
          if (c === "\x07") {
            j += 1;
            break;
          }
          if (c === "\x1b" && j + 1 < data.length && data[j + 1] === "\\") {
            j += 2;
            break;
          }
          j += 1;
        }
        out.push(data.slice(i, j));
        i = j - 1;
      } else {
        acc += ch;
      }
    }
    if (acc.length > 0) out.push(acc);
    return out;
  }
  // split-mid-sequence: fixed 7-byte pieces, regardless of boundaries.
  const out: string[] = [];
  for (let i = 0; i < data.length; i += 7) {
    out.push(data.slice(i, i + 7));
  }
  return out;
}

/**
 * Expand fixture events into per-chunk feed units with monotonic seq.
 * seq advances per chunk so intermediate snapshots pin distinct seq values
 * (same rule as the production plane journal).
 */
export function chunkEvents(
  events: readonly FixtureEvent[],
  mode: ChunkMode,
): Array<{ data: string; seq: bigint }> {
  const out: Array<{ data: string; seq: bigint }> = [];
  let seq = 0n;
  for (const ev of events) {
    const data = Buffer.from(ev.b64, "base64").toString("utf8");
    for (const chunk of chunkBytes(data, mode)) {
      seq += 1n;
      out.push({ data: chunk, seq });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Feeding + canonicality gate
// ---------------------------------------------------------------------------

export interface SeatSlotProjection {
  state: string;
  reason: string;
  confidence: string;
  visibleIdle: boolean;
  visibleWorking: boolean;
  visibleAttention: boolean;
}

export interface ObserverRun {
  readonly bindingId: string;
  readonly epoch: string;
  readonly snapshot: ObserverGridSnapshot;
  readonly events: readonly AgentSeatStateEvent[];
  readonly slot: SeatSlotProjection | undefined;
  readonly isSeatIdle: boolean;
}

/**
 * Feed a chunked stream through a real observer + a FRESH runtime.
 * Returns the final observer snapshot (gate target), the runtime's published
 * event stream, the final machine slot projection, and isSeatIdle.
 */
export async function feedStream(
  harness: string,
  chunks: ReadonlyArray<{ data: string; seq: bigint }>,
  opts: {
    readonly bindingId?: string;
    readonly cols?: number;
    readonly rows?: number;
    /** machine.feed (rule path, no OSC hook feed) — runtime.observe otherwise. */
    readonly rulePathOnly?: boolean;
    readonly now?: () => number;
    readonly onEvent?: (e: AgentSeatStateEvent) => void;
  } = {},
): Promise<ObserverRun> {
  const bindingId = opts.bindingId ?? "seat-1";
  const epoch = "e1";
  const obs = new SessionObserver({
    bindingId,
    epoch,
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
  });
  const rt = new SeatStateRuntime({
    now: opts.now,
    onEvent: opts.onEvent,
    turnProgressWatch: false,
  });
  rt.bindHarness(bindingId, harness, epoch);
  try {
    for (const chunk of chunks) {
      obs.feed(chunk.data, chunk.seq);
      await obs.snapshot();
      const snap = await obs.snapshot();
      if (opts.rulePathOnly) {
        rt.machine.feed(snap, { harness });
      } else {
        rt.observe(snap);
      }
    }
    const snapshot = await obs.snapshot();
    const slot = rt.machine.getSlot(bindingId);
    return {
      bindingId,
      epoch,
      snapshot,
      events: rt.currentEvents(),
      slot: slot
        ? {
            state: slot.state,
            reason: slot.reason,
            confidence: slot.confidence,
            visibleIdle: slot.visibleIdle,
            visibleWorking: slot.visibleWorking,
            visibleAttention: slot.visibleAttention,
          }
        : undefined,
      isSeatIdle: rt.isSeatIdle(bindingId),
    };
  } finally {
    rt.stop();
    obs.dispose();
  }
}

/**
 * Canonicality gate — the spec's hard bar: a fixture is only usable once a
 * REAL SessionObserver reproduces its expected screen truth. Throws (test
 * fails) on any mismatch; tests must never reach behavior assertions on an
 * unvalidated fixture.
 */
export function gateFixture(
  snapshot: ObserverGridSnapshot,
  fixture: Fixture,
): void {
  const esc = fixture.expectedScreen;
  // A gate that asserts nothing is not a gate. Every check below is guarded by
  // an undefined-check, so an expectedScreen carrying none of the assertable
  // keys used to pass silently — that is the vacuity this refuses.
  const assertable =
    esc.title !== undefined ||
    esc.osc9 !== undefined ||
    esc.promptGlyph !== undefined ||
    esc.noPromptGlyph === true;
  expect(
    assertable,
    `[gate ${fixture.harness}/${fixture.scenario}] expectedScreen carries no assertable key ` +
      `(title / osc9 / promptGlyph / noPromptGlyph) — the canonicality gate would assert nothing. ` +
      `Fix the manifest entry rather than gating on an empty shape.`,
  ).toBe(true);
  if (esc.title !== undefined) {
    expect(
      snapshot.signals.title,
      `[gate ${fixture.harness}/${fixture.scenario}] title`,
    ).toBe(esc.title);
  }
  if (esc.osc9 !== undefined) {
    expect(
      snapshot.signals.osc9,
      `[gate ${fixture.harness}/${fixture.scenario}] osc9`,
    ).toBe(esc.osc9);
  }
  const composerGlyphs = /^\s*[❯>❭›]/u;
  const hasGlyph = snapshot.lines.some((l) => composerGlyphs.test(l));
  if (esc.promptGlyph !== undefined) {
    // Assert the DECLARED literal, not a shared glyph class. The class form
    // passed on the wrong harness (codex prints ›, claude ❯, devin ❭) and
    // outright failed for a harness whose declared idle chrome is a footer
    // string rather than a glyph (pi: "0.0%/400k (auto)").
    const declared = esc.promptGlyph;
    const onScreen = snapshot.lines.some((l) => l.includes(declared));
    expect(
      onScreen,
      `[gate ${fixture.harness}/${fixture.scenario}] declared idle chrome ${JSON.stringify(declared)} not on screen`,
    ).toBe(true);
    // When the declaration IS a composer glyph, it must open a line — a glyph
    // buried mid-transcript is scrollback, not the live composer.
    if (composerGlyphs.test(declared)) {
      expect(
        snapshot.lines.some((l) => l.trimStart().startsWith(declared)),
        `[gate ${fixture.harness}/${fixture.scenario}] composer glyph ${JSON.stringify(declared)} must start a line`,
      ).toBe(true);
    }
  }
  if (esc.noPromptGlyph === true) {
    expect(
      hasGlyph,
      `[gate ${fixture.harness}/${fixture.scenario}] no composer glyph on screen`,
    ).toBe(false);
  }
}

// ---------------------------------------------------------------------------
// Per-scenario orchestration
// ---------------------------------------------------------------------------

export interface ScenarioRun {
  readonly fixture: LoadedFixture;
  readonly modes: ReadonlyArray<{
    readonly mode: ChunkMode;
    readonly run: ObserverRun;
  }>;
}

export type RunOptions = {
  readonly harness: string;
  readonly scenario: string;
  /** Only run a subset of chunk modes (tests may scope). */
  readonly modes?: ReadonlyArray<ChunkMode>;
  readonly rulePathOnly?: boolean;
  readonly now?: () => number;
  readonly onEvent?: (e: AgentSeatStateEvent) => void;
  readonly bindingId?: string;
  readonly cols?: number;
  readonly rows?: number;
};

/**
 * Full scenario pipeline: load → gate (whole mode) → feed all modes →
 * chunk-mode equality → seat projection. Every mode gets its own FRESH
 * observer + runtime (state isolation), so golden grids and event streams
 * must be identical across delivery modes.
 */
export async function runScenario(opts: RunOptions): Promise<ScenarioRun> {
  const fixture = loadFixture(opts.harness, opts.scenario);
  const modes = opts.modes ?? CHUNK_MODES;
  // Fixed clock so event `at` stamps are deterministic across chunk modes
  // (chunk-equality compares the full published event stream).
  const now = opts.now ?? (() => 1_000);

  // 1. Canonicality gate on the whole-mode feed (real observer).
  const wholeChunks = chunkEvents(fixture.events, "whole");
  const gated = await feedStream(fixture.harness, wholeChunks, {
    rulePathOnly: opts.rulePathOnly,
    now,
    bindingId: opts.bindingId,
    cols: opts.cols,
    rows: opts.rows,
  });
  gateFixture(gated.snapshot, fixture);

  // 2. Feed every chunk mode; collect golden grids + event streams.
  const runs: Array<{ mode: ChunkMode; run: ObserverRun }> = [];
  for (const mode of modes) {
    const chunks = chunkEvents(fixture.events, mode);
    const run = await feedStream(fixture.harness, chunks, {
      rulePathOnly: opts.rulePathOnly,
      now,
      bindingId: opts.bindingId,
      cols: opts.cols,
      rows: opts.rows,
    });
    runs.push({ mode, run });
  }

  return { fixture, modes: runs };
}

/**
 * Assert golden-grid + event-stream equality across chunk modes.
 * This asserts parser robustness (identical screens regardless of how the
 * same bytes are chunked), not product behavior.
 */
export function assertChunkEquality(run: ScenarioRun): void {
  const [first, ...rest] = run.modes;
  if (!first) return;
  for (const other of rest) {
    expect(
      other.run.snapshot.lines,
      `[chunk-equality ${run.fixture.harness}/${run.fixture.scenario}] lines (${first.mode} vs ${other.mode})`,
    ).toEqual(first.run.snapshot.lines);
    expect(
      other.run.snapshot.text,
      `[chunk-equality ${run.fixture.harness}/${run.fixture.scenario}] text (${first.mode} vs ${other.mode})`,
    ).toBe(first.run.snapshot.text);
    expect(
      other.run.snapshot.signals,
      `[chunk-equality ${run.fixture.harness}/${run.fixture.scenario}] signals (${first.mode} vs ${other.mode})`,
    ).toEqual(first.run.snapshot.signals);
    expect(
      other.run.events,
      `[chunk-equality ${run.fixture.harness}/${run.fixture.scenario}] seat events (${first.mode} vs ${other.mode})`,
    ).toEqual(first.run.events);
  }
}
