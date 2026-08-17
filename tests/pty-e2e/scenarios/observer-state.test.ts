/**
 * Observer/state repro scenarios (Agent B) — R1..R6.
 *
 * Every scenario feeds REAL bytes through a REAL SessionObserver (canonicality
 * gate first — see runner.ts), runs all three chunk modes with FRESH runtimes,
 * asserts golden-grid + event equality across modes, then asserts the CORRECT
 * product behavior. Tests that FAIL on today's code are the repros (they must
 * pass once the defect is fixed); tests that pass document the working law.
 *
 * Defect map (from /tmp/vellum-pty-expert.md / /tmp/vellum-my-findings.md):
 *   R1: claude.ts priorities — osc_title_working (1100) outranks
 *       live_prompt_box (950), so an empty composer + stale braille title
 *       evaluates working. Expect idle (composer glyph is idle chrome).
 *   R3: claude.ts osc9_idle lacks visibleIdle → rule path publishes
 *       low-confidence idle → isSeatIdle false although OSC 9;4;0 is the
 *       harness's deterministic idle flag (K9).
 *   R4: renderer/lib/activity.ts terminalActivity — the green process-wave
 *       check (running && activeProcess) precedes the idle check, so an idle
 *       managed seat labeled "Claude Code" / "⠋ Claude Code" waves green
 *       instead of settling to static steel.
 *   R5: progressFingerprint must change on braille title churn so the
 *       mid-turn watch never stalls a churning working seat.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import {
  BUILTIN_FIXTURES,
  CHUNK_MODES,
  assertChunkEquality,
  chunkEvents,
  feedStream,
  gateFixture,
  loadFixture,
  runScenario,
} from "../runner";
import { SessionObserver } from "../../../src/main/vellum/term/observer";
import { SeatStateRuntime, progressFingerprint } from "../../../src/main/vellum/term/agent-state/runtime";
import { terminalActivity, isActiveProcessLabel } from "../../../src/renderer/lib/activity";
import {
  armFirstTypedMessage,
  resetFirstTypedForTest,
  takeFirstTypedMessage,
} from "../../../src/main/vellum/term/first-typed";
import type { ObserverGridSnapshot } from "../../../src/main/vellum/term/observer/types";

afterEach(() => {
  resetFirstTypedForTest();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// R1 — claude empty prompt box (❯ and >) + braille OSC title → idle
// ---------------------------------------------------------------------------

describe("R1 — claude empty prompt box + braille title is idle", () => {
  for (const scenario of [
    "r1-empty-prompt-box-braille-title",
    "r1b-empty-prompt-box-ascii-gt-braille-title",
  ] as const) {
    it(`BUG-R1: ${scenario} — idle + visibleIdle + isSeatIdle (today: working)`, async () => {
      const run = await runScenario({ harness: "claude", scenario });
      // Tooling: parser robustness first — identical golden grid + events in
      // all three chunk modes.
      assertChunkEquality(run);
      // Repro: the empty composer glyph is Claude's idle chrome and must
      // outrank the stale braille working title.
      for (const { mode, run: r } of run.modes) {
        expect(
          r.slot,
          `[${scenario}/${mode}] seat must be idle`,
        ).toMatchObject({ state: "idle", visibleIdle: true });
        expect(
          r.isSeatIdle,
          `[${scenario}/${mode}] idle seat must be pasteable`,
        ).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// R2 — claude draft chip + braille title → idle (sanity)
// ---------------------------------------------------------------------------

describe("R1c — claude genuinely working: braille title + OSC 9;4;3 + empty composer", () => {
  it("BUG-R1c: real-working receipt must publish working + refuse paste (live-test regression: no indicator on a running Claude)", async () => {
    // Live report: a running Claude session showed NO working indicator after
    // the R1 fix — because a real working Claude paints an EMPTY composer with
    // braille title + OSC 9;4;3 (K9), and the empty-prompt idle rule (1160)
    // outranked the title rule (1100). The deterministic OSC 9 flag is the
    // tiebreaker: 4;3 = working (this fixture), 4;0 = stale-title idle (r1).
    const run = await runScenario({
      harness: "claude",
      scenario: "r1c-real-working-receipt",
    });
    assertChunkEquality(run);
    for (const { mode, run: r } of run.modes) {
      expect(
        r.slot,
        `[${mode}] real-working receipt must be working`,
      ).toMatchObject({ state: "working", visibleWorking: true });
      expect(r.isSeatIdle, `[${mode}] working seat must refuse paste`).toBe(false);
    }
  });
});

describe("R2 — claude draft chip + braille title is idle (sanity)", () => {
  it("draft chip in composer outranks braille working title — idle + pasteable", async () => {
    const run = await runScenario({
      harness: "claude",
      scenario: "r2-draft-chip-braille-title",
    });
    assertChunkEquality(run);
    for (const { mode, run: r } of run.modes) {
      expect(
        r.slot,
        `[${mode}] composer_draft_idle must win over osc_title_working`,
      ).toMatchObject({ state: "idle", visibleIdle: true });
      expect(r.isSeatIdle, `[${mode}]`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// R3 — claude osc9 "4;0" idle with empty title → isSeatIdle
// ---------------------------------------------------------------------------

describe("R3 — claude osc9 4;0 + empty title is pasteable idle", () => {
  it("BUG-R3a: rule path — osc9_idle must be visible idle (isSeatIdle true; today: false)", async () => {
    // rulePathOnly = machine.feed without the OSC hook channel: the pure
    // screen-rule path that the engine's osc9_idle rule is supposed to carry.
    const run = await runScenario({
      harness: "claude",
      scenario: "r3-osc9-idle-empty-title",
      rulePathOnly: true,
    });
    assertChunkEquality(run);
    for (const { mode, run: r } of run.modes) {
      expect(
        r.slot,
        `[${mode}] osc9 4;0 is Claude's deterministic idle flag (K9) — rule must publish visible idle`,
      ).toMatchObject({ state: "idle", visibleIdle: true });
      expect(
        r.isSeatIdle,
        `[${mode}] rule-path osc9 idle must authorize paste`,
      ).toBe(true);
    }
  });

  it("R3b (documentation): runtime OSC-hook path currently masks R3a — isSeatIdle true via hook", async () => {
    // Same bytes through runtime.observe: hookStateFromSnapshot turns osc9
    // 4;0 into a high-confidence idle hook, which today papers over the rule
    // defect. Keep this as documentation so removing the mask cannot go
    // unnoticed in either direction.
    const run = await runScenario({
      harness: "claude",
      scenario: "r3-osc9-idle-empty-title",
    });
    assertChunkEquality(run);
    for (const { mode, run: r } of run.modes) {
      expect(r.slot?.state, `[${mode}]`).toBe("idle");
      expect(r.isSeatIdle, `[${mode}]`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// R4 — renderer terminalActivity: idle managed seat must be static steel
// ---------------------------------------------------------------------------

describe("R4 — terminalActivity: idle managed seat is static steel, not green wave", () => {
  it("BUG-R4: idle + running + 'Claude Code' → static steel (today: green wave)", () => {
    expect(
      terminalActivity({
        seatState: "idle",
        running: true,
        processName: "Claude Code",
      }),
    ).toEqual({ mode: "static", tone: "steel", label: "idle" });
  });

  it("BUG-R4b: idle + running + '⠋ Claude Code' → static steel (today: green wave)", () => {
    expect(
      terminalActivity({
        seatState: "idle",
        running: true,
        processName: "⠋ Claude Code",
      }),
    ).toEqual({ mode: "static", tone: "steel", label: "idle" });
  });

  it("sanity: real user command without a seat stays green process wave", () => {
    expect(
      terminalActivity({ running: true, processName: "npm run dev" }),
    ).toMatchObject({ mode: "wave", tone: "green", pattern: "ripple" });
    expect(
      terminalActivity({ running: true, processName: "npm" }),
    ).toMatchObject({ mode: "wave", tone: "green" });
  });

  it("isActiveProcessLabel: harness labels are active, shells and user@host:path are not", () => {
    expect(isActiveProcessLabel("Claude Code")).toBe(true);
    expect(isActiveProcessLabel("⠋ Claude Code")).toBe(true);
    expect(isActiveProcessLabel("npm run dev")).toBe(true);
    expect(isActiveProcessLabel("zsh")).toBe(false);
    expect(isActiveProcessLabel("/bin/zsh")).toBe(false);
    expect(isActiveProcessLabel("user@host:~/project")).toBe(false);
    expect(isActiveProcessLabel(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R5 — progressFingerprint: braille churn is progress, never stall
// ---------------------------------------------------------------------------

describe("R5 — braille title churn is progress (turn-stall never fires while churning)", () => {
  it("fingerprint semantics on real observer snapshots: braille frame churn changes the fingerprint", async () => {
    const fixture = loadFixture("claude", "r5-braille-churn-frames");
    const obs = new SessionObserver({
      bindingId: "seat-1",
      epoch: "e1",
      cols: 80,
      rows: 24,
    });
    try {
      // Feed each frame separately with distinct seq, snapshot after each.
      const frames: ObserverGridSnapshot[] = [];
      for (const ev of fixture.events) {
        obs.feed(Buffer.from(ev.b64, "base64").toString("utf8"), BigInt(frames.length + 1));
        frames.push(await obs.snapshot());
      }
      // frames[i] is the snapshot AFTER event i: frame0 = osc9 4;3 only,
      // frame1 = ⠂ braille title, frame2 = ⠐, frame3 = ⠂, frame4 = ⠐.
      const f0 = frames[0]!; // osc9 4;3, no title yet
      const f1 = frames[1]!; // ⠂ Claude Code
      const f2 = frames[2]!; // ⠐ Claude Code
      // Gate: real observer reproduced the working title + osc9.
      gateFixture(frames[frames.length - 1]!, fixture);
      expect(f1.signals.title).toBe("⠂ Claude Code");
      expect(f2.signals.title).toBe("⠐ Claude Code");
      expect(f0.signals.osc9).toBe("4;3");

      // Two braille frames differ → fingerprint changes (churn = progress).
      const fp0 = progressFingerprint(f0);
      const fp1 = progressFingerprint(f1);
      const fp2 = progressFingerprint(f2);
      expect(fp1).not.toBe(fp0); // title change alone is progress
      expect(fp2).not.toBe(fp1); // next braille frame is progress
      // Same frame + same seq → stable fingerprint (no phantom progress).
      expect(progressFingerprint(f1)).toBe(fp1);
      // seq alone changes the fingerprint (any PTY output is progress).
      expect(progressFingerprint({ ...f1, seq: f1.seq + 1n })).not.toBe(fp1);
      // osc9 flip changes the fingerprint.
      expect(
        progressFingerprint({
          ...f1,
          signals: { ...f1.signals, osc9: "4;0" },
        }),
      ).not.toBe(fp1);
      // Hook key is state|reason only — `at` must never count (a fresh clock
      // on every re-observe would clear sticky turn-stalled holds).
      const hookA = { state: "working", reason: "osc_title_braille", at: 1 };
      const hookB = { state: "working", reason: "osc_title_braille", at: 9_999 };
      expect(progressFingerprint(f1, hookA)).toBe(progressFingerprint(f1, hookB));
      expect(progressFingerprint(f1, hookA)).not.toBe(
        progressFingerprint(f1, { state: "idle", reason: "osc9_idle", at: 1 }),
      );
    } finally {
      obs.dispose();
    }
  });

  it("churning braille title while working never stalls; 90s silence does (turn-stalled)", async () => {
    const fixture = loadFixture("claude", "r5-braille-churn-frames");
    // Real snapshots from the real observer FIRST (xterm write completion
    // must run on real timers), then fake timers for the watch.
    const obs = new SessionObserver({
      bindingId: "seat-1",
      epoch: "e1",
      cols: 80,
      rows: 24,
    });
    const frames: ObserverGridSnapshot[] = [];
    try {
      for (let i = 0; i < fixture.events.length; i++) {
        const ev = fixture.events[i]!;
        obs.feed(
          Buffer.from(ev.b64, "base64").toString("utf8"),
          BigInt(i + 1),
        );
        frames.push(await obs.snapshot());
      }
    } finally {
      obs.dispose();
    }
    gateFixture(frames[frames.length - 1]!, fixture);

    vi.useFakeTimers();
    let now = 0;
    const rt = new SeatStateRuntime({
      now: () => now,
      turnStallMs: 90_000,
    });
    rt.bindHarness("seat-1", "claude", "e1");

    // Frame 1 (⠂ + osc9 4;3) at t=0 → working, watch armed.
    rt.observe(frames[1]!);
    expect(rt.getState("seat-1")).toBe("working");

    // 60s later a different braille frame (⠐) → fingerprint changed → progress.
    now += 60_000;
    vi.advanceTimersByTime(60_000);
    rt.observe(frames[2]!);
    expect(rt.isTurnStalled("seat-1")).toBe(false);
    expect(rt.getState("seat-1")).toBe("working");

    // Another churn at 120s → progress again; 89s of silence after that is
    // still inside the 90s window → no stall.
    now += 60_000;
    vi.advanceTimersByTime(60_000);
    rt.observe(frames[3]!);
    now += 89_000;
    vi.advanceTimersByTime(89_000);
    expect(rt.isTurnStalled("seat-1")).toBe(false);
    expect(rt.getState("seat-1")).toBe("working");

    // Cross the deadline with no further progress → stall fires once.
    now += 2_000;
    vi.advanceTimersByTime(2_000);
    expect(rt.isTurnStalled("seat-1")).toBe(true);
    expect(rt.getState("seat-1")).toBe("attention");

    // Stalled attention refuses paste.
    expect(rt.isSeatIdle("seat-1")).toBe(false);
    rt.stop();
  });
});

// ---------------------------------------------------------------------------
// R6 — real P1 captures that exist at run time + cross-harness idle (P2/P3)
// ---------------------------------------------------------------------------

describe("R6 — P1 captures present at run time + cross-harness idle coverage", () => {
  it("built-in fixtures are real P2/P3 receipt tables, never P1 stand-ins", () => {
    // Replaces an assertion that could not fail: it compared BUILTIN_FIXTURES
    // against a hardcoded muse-only P1 list, and since no builtin carries
    // source "P1" the `|| f.source !== "P1"` arm made every row pass. The
    // real invariant is that the builtin table stays what it claims to be —
    // synthesized receipts with actual bytes — so a P1 capture is never
    // silently shadowed by a mock of the same name.
    expect(BUILTIN_FIXTURES.length).toBeGreaterThan(0);
    for (const f of BUILTIN_FIXTURES) {
      const id = `${f.harness}/${f.scenario}`;
      expect(f.source, `[${id}] builtins are P2/P3 receipts, never labelled P1`).not.toBe("P1");
      expect(f.events.length, `[${id}] builtin carries no bytes`).toBeGreaterThan(0);
      expect(
        f.provenance?.trim().length ?? 0,
        `[${id}] builtin must cite where its bytes came from`,
      ).toBeGreaterThan(0);
    }
  });

  // muse startup-idle (P1) REMOVED. muse is behind HARNESS_MUSE_ENABLED
  // (src/shared/features.ts managedHarnessEnabled) and is outside the five
  // harnesses the canonical corpus carries, so this leg could only ever throw
  // "no fixture for muse/startup-idle" — holding the suite red for a harness we
  // do not ship. No law was lost: the Tier-B firstTyped gate it asserted (muse
  // fallback idle refuses paste; arming a firstTyped body opens it for exactly
  // one delivery) is covered corpus-free in gaps.test.ts GAP-OBS-17 case (c).
  // If muse ships, capture it and restore this leg from git history.

  it("R6 cross-harness idle (P2/P3): codex/grok/kimi/pi/prime-agent idle → idle + pasteable", async () => {
    for (const [harness, scenario] of [
      ["codex", "r6-codex-idle"],
      ["grok", "r6-grok-idle"],
      ["kimi", "r6-kimi-idle"],
      ["pi", "r6-pi-idle"],
      ["prime-agent", "r6-prime-agent-idle"],
    ] as const) {
      const run = await runScenario({ harness, scenario });
      assertChunkEquality(run);
      for (const { mode, run: r } of run.modes) {
        expect(
          r.slot,
          `[${harness}/${scenario}/${mode}] idle chrome must publish visible idle`,
        ).toMatchObject({ state: "idle", visibleIdle: true });
        expect(r.isSeatIdle, `[${harness}/${scenario}/${mode}]`).toBe(true);
      }
    }
  });
});
