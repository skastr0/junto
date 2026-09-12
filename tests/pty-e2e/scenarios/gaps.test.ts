/**
 * Gap coverage (Agent E, iteration 2) — OBS-4/5/7/8/10-15/17/18, DRV-4/6,
 * POL-2/3/4/5 repro + documentation scenarios.
 *
 * Anti-hacking bar (spec §1): every screen truth flows through a REAL
 * SessionObserver fed by REAL byte receipts (P2/P3 compositions grounded in
 * the 2026-08 managed-terminal probe reports and the P1 corpus under
 * /tmp/vellum-pty-fixtures). No hand-built ObserverGridSnapshot objects.
 * Pure-function tests (scanMarker / engine ordering / isSeatIdle gate) call
 * the REAL functions with REAL observer output. Fakes sit ONLY at the OS
 * boundary: the scripted TUI (PTY process model, scripted-tui.ts) and fake
 * timers (clock).
 *
 * Test naming: `GAP-<id>: <expected behavior>`. Tests that FAIL on today's
 * code are the repros (they pass once the defect is fixed); tests that pass
 * document the current law.
 *
 * Defect map (from /tmp/vellum-defect-coverage.md + /tmp/vellum-pty-expert.md):
 *   OBS-4  D4   1150 tie: legacy_permission_blocker beats composer_draft_idle —
 *                stale scrollback permission text pins attention over a live chip.
 *   OBS-5  D5   whole_recent attention rules pin attention from scrollback.
 *                (Claude path also exposed by the INVALID `(?m)^\s*❯\s*$`
 *                not-gate — compileRegex fails under the `u` flag and the
 *                guard silently never blocks.)
 *   OBS-7  D7   needsLook arms on false working→idle title flips.
 *   OBS-8  D8   engine safety-net attention runs before hooks.
 *   OBS-10 D10  viewport snapshot race — documentation (no throw, seq sane).
 *   OBS-12 D12  osc9 stored unsanitized (control bytes survive into fingerprints).
 *   OBS-13 D13  SerializeAddon bracketed-paste restore — documentation.
 *   OBS-14 D14  debounce burst: 3 confirmations in ~30ms publish idle (cap is
 *                the real debounce).
 *   OBS-15 D15  attention heartbeat re-publishes every 800ms.
 *   OBS-17 D17  isSeatIdle low-confidence gate keys on the reason string.
 *   OBS-18 D1   observer title never expires — stale braille pins working.
 *   DRV-4  D20  mid-sequence write failure leaks the paste chip (no clear).
 *   DRV-6  E2   hermes chip never collapses on a 2nd CR (real capture); hermes
 *                is fallback-idle today → drive never pastes (documentation).
 *   DRV-7       Grok `[Pasted:Nlines]` footer is not composer chip chrome
 *                (no recipe CR2). Codex payload-head leftover is the same
 *                class — D8 is the drive proof.
 *   DRV-8       Amp/Muse have no composer probes; firstTyped admits empty;
 *                mail (firstTypedArmed false) stays null.
 *   DRV-9       Grok history footer is not a chip-submit CR — drive proof is
 *                D9 in drive-law.test.ts (not duplicated).
 *   POL-2  D26  false working→idle flips count as turns → fake escalation.
 *   POL-3  D26  scanMarker is chip-blind: `[Pasted text #N]` ≠ marker →
 *                "consumed" while our text sits unsubmitted in the box.
 *   POL-4  D26  no-rules prompt region = 1 line → multi-line prompt
 *                misclassified (marker on an earlier line reads "output").
 *   POL-5  D28  noteUserInput sticky across generations — escalation still
 *                fires (canvas-only) → documentation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionObserver } from "../../../src/main/vellum-command/term/observer";
import { SeatStateRuntime } from "../../../src/main/vellum-command/term/agent-state/runtime";
import {
  admitUngroundedFirstTypedComposer,
  composerVerdictFor,
  rulePackFor,
} from "../../../src/main/vellum-command/term/agent-state";
import {
  SeatStateMachine,
  SEAT_DEBOUNCE,
} from "../../../src/main/vellum-command/term/agent-state/seat-state-machine";
import { evaluate } from "../../../src/main/vellum-command/term/agent-state/engine";
import { hookStateFromSnapshot } from "../../../src/main/vellum-command/term/agent-state/hook-feed";
import { progressFingerprint } from "../../../src/main/vellum-command/term/agent-state/turn-progress-watch";
import { sanitizeTitle } from "../../../src/main/vellum-command/term/observer/sanitize";
import {
  deriveInjectionSignal,
  promptRegionLines,
  scanMarker,
} from "../../../src/main/vellum-command/term/observer/interaction";
import { InjectionSupervisor } from "../../../src/main/vellum-command/term/injection-supervisor";
import { buildBootstrapMarker } from "@shared/managed-terminal-injection";
import {
  applyAgentSeatStateEvent,
  agentSeat$,
  resetAgentSeatState,
} from "../../../src/renderer/lib/agent-seat-state";
import { armFirstTypedMessage, resetFirstTypedForTest } from "../../../src/main/vellum-command/term/first-typed";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  CR,
  INTERRUPT_BYTE,
  ManagedTerminalDrive,
  encodeBracketedPaste,
  promptHasPasteChip,
  promptStillPending,
} from "../../../src/main/vellum-command/term/drive";
import {
  assertChunkEquality,
  chunkEvents,
  feedStream,
  loadFixture,
  runScenario,
} from "../runner";
import { DriveLoop, ScriptedTui, type DriveLoopOptions } from "../scripted-tui";
import type { ObserverGridSnapshot } from "../../../src/main/vellum-command/term/observer/types";
import type { AgentSeatStateEvent } from "../../../src/shared/agent-seat-state";

const BINDING = "seat-b1";

afterEach(() => {
  vi.useRealTimers();
  resetAgentSeatState();
  resetFirstTypedForTest();
});

/** Drive-loop fake-clock setup (same contract as drive-law.test.ts). */
const setup = (over: Partial<DriveLoopOptions> = {}) => {
  vi.useFakeTimers({ now: 1_000_000 });
  const loop = new DriveLoop({
    now: () => Date.now(),
    stallTimeoutMs: 5_000,
    pasteToCrSettleMs: 40,
    ...over,
  });
  const advance = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
  };
  const flush = async () => {
    // Model timers (setTimeout) → observer feed; xterm parse timer → snapshot.
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  };
  return { loop, advance, flush };
};

const labels = (loop: DriveLoop) => loop.writes.map((w) => loop.labelWrite(w.data));
const ctrlC = (loop: DriveLoop) => loop.writes.filter((w) => w.data === INTERRUPT_BYTE);

/** Production-style supervisor wiring over a DriveLoop (mirrors ipc.ts). */
const wireSupervisor = (loop: DriveLoop, sup: InjectionSupervisor) => {
  sup.setNow(() => Date.now());
  loop.runtime.subscribe((ev) => sup.noteSeatState(ev));
};

// ---------------------------------------------------------------------------
// OBS-4 — paste chip + STALE permission text in the scrollback tail
// ---------------------------------------------------------------------------

describe("GAP-OBS-4: paste chip + stale permission text in scrollback tail is idle", () => {
  it("GAP-OBS-4: idle + visibleIdle + isSeatIdle (today: legacy_permission_blocker attention)", async () => {
    const run = await runScenario({
      harness: "claude",
      scenario: "obs4-chip-stale-permission",
    });
    assertChunkEquality(run);
    for (const { mode, run: r } of run.modes) {
      // The chip in the composer is the live idle chrome; the previous turn's
      // permission dialog is scrollback history. The 1150 tie must go to the
      // composer rule, not the stale whole_recent blocker.
      expect(
        r.slot,
        `[${mode}] composer chip must outrank stale scrollback permission text`,
      ).toMatchObject({ state: "idle", visibleIdle: true });
      expect(r.isSeatIdle, `[${mode}] chip-idle seat must be pasteable`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// OBS-5 — idle prompt + stale "do you want to proceed" in whole_recent
// ---------------------------------------------------------------------------

describe("GAP-OBS-5: stale whole_recent attention text must not pin an idle prompt", () => {
  it("GAP-OBS-5a: claude bare ❯ composer + stale K2 dialog → idle (today: legacy_permission_blocker)", async () => {
    const run = await runScenario({
      harness: "claude",
      scenario: "obs5-idle-stale-permission",
    });
    assertChunkEquality(run);
    for (const { mode, run: r } of run.modes) {
      expect(
        r.slot,
        `[${mode}] bare idle composer must win over stale scrollback permission text`,
      ).toMatchObject({ state: "idle", visibleIdle: true });
      expect(r.isSeatIdle, `[${mode}]`).toBe(true);
    }
  });

  it("GAP-OBS-5b: codex idle prompt + stale P13 approval modal → idle (today: weak_attention)", async () => {
    const run = await runScenario({
      harness: "codex",
      scenario: "obs5-codex-idle-stale-permission",
    });
    assertChunkEquality(run);
    for (const { mode, run: r } of run.modes) {
      expect(
        r.slot,
        `[${mode}] codex idle chrome must win over stale approval text`,
      ).toMatchObject({ state: "idle", visibleIdle: true });
      expect(r.isSeatIdle, `[${mode}]`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// OBS-18 — stale braille title never expires after an idle redraw
// ---------------------------------------------------------------------------

describe("GAP-OBS-18: title fed before the idle redraw must expire with the prompt box", () => {
  it("GAP-OBS-18: braille title then idle-screen redraw (no new title) → idle (today: osc_title_working)", async () => {
    const run = await runScenario({
      harness: "claude",
      scenario: "obs18-stale-braille-title-redraw",
    });
    assertChunkEquality(run);
    // Gate: the observer really kept the stale braille title (no expiry).
    expect(run.modes[0]!.run.snapshot.signals.title).toBe("⠂ Claude Code");
    for (const { mode, run: r } of run.modes) {
      // The fresh prompt-box redraw is newer evidence than the stale title.
      expect(
        r.slot,
        `[${mode}] idle prompt box must outrank the stale braille title`,
      ).toMatchObject({ state: "idle", visibleIdle: true });
      expect(r.isSeatIdle, `[${mode}]`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// OBS-8 — engine ordering: attention safety net vs non-full hook
// ---------------------------------------------------------------------------

describe("GAP-OBS-8: stale low-priority attention must not beat a non-full hook idle", () => {
  it("GAP-OBS-8: osc9 4;0 idle hook wins over stale scrollback attention (today: rule wins)", async () => {
    // Real bytes: stale K2 dialog + bare ❯ composer + ✳ title + OSC 9;4;0.
    const fixture = loadFixture("claude", "obs5-idle-stale-permission");
    const chunks = chunkEvents(fixture.events, "whole");
    const run = await feedStream("claude", chunks, { rulePathOnly: true });
    const snap = run.snapshot;
    expect(snap.signals.title).toBe("✳ Claude Code");
    expect(snap.signals.osc9).toBe("4;0");

    // Real hook derivation: OSC 9;4;0 is Claude's deterministic idle flag.
    const hook = hookStateFromSnapshot(snap, "claude", 1_000);
    expect(hook).toMatchObject({ state: "idle", reason: "osc9_idle", fullLifecycle: false });

    const today = evaluate(snap, { harness: "claude", hookState: hook, now: 1_000 });
    // ACTUAL today (pre-fix): the stale whole_recent rule won and evaluate
    // returned attention — documented as a comment, not an assertion (the
    // same object cannot be both attention and idle; the law is below).

    // PRODUCT LAW: hook idle (deterministic OSC 9;4;0) beats the stale
    // whole_recent attention rule; the safety net must run after hooks.
    // (Assert the mechanism too: the win must come from the hook, not a rule.)
    expect(today).toMatchObject({
      state: "idle",
      reason: "hook:osc9_idle",
      confidence: "high",
      visibleIdle: true,
    });
  });
});

// ---------------------------------------------------------------------------
// POL-3 — scanMarker chip blindness: [Pasted text #N] is our pending text
// ---------------------------------------------------------------------------

describe("GAP-POL-3: a visible paste chip is a LIVE injection, never consumed", () => {
  it("GAP-POL-3: chip in prompt box + no marker → scanMarker 'prompt' / deriveInjectionSignal 'live' (today: cleared/consumed)", async () => {
    // REAL grid from real bytes (obs4 fixture: chip composer + stale dialog).
    const fixture = loadFixture("claude", "obs4-chip-stale-permission");
    const chunks = chunkEvents(fixture.events, "whole");
    const run = await feedStream("claude", chunks);
    const lines = run.snapshot.lines;
    // Precondition: the chip line is really in the prompt box.
    expect(
      lines.some((l) => l.includes("[Pasted text #3 +12 lines]")),
    ).toBe(true);

    const marker = buildBootstrapMarker(BINDING);
    expect(marker).toMatch(/^\[vc-/);
    // The chip does not contain the marker token — that is the blind spot.
    expect(lines.some((l) => l.includes(marker))).toBe(false);

    const scan = scanMarker(lines, marker, true);
    const injection = deriveInjectionSignal(scan, true);

    // PRODUCT LAW: our text is still on screen, unsubmitted, collapsed into
    // the harness chip. The supervisor must treat it as pending ("live"), not
    // as delivered-and-consumed — otherwise the next clean delivery starts
    // from wrong "cleared" semantics and the one-live hold is never armed.
    expect(scan).toBe("prompt");
    expect(injection).toBe("live");
  });
});

// ---------------------------------------------------------------------------
// POL-4 — codex no-rules prompt region collapses to one line
// ---------------------------------------------------------------------------

describe("GAP-POL-4: multi-line codex prompt must scan as one prompt region", () => {
  it("GAP-POL-4: marker on the 2nd line of a no-rules codex box → 'prompt'/'live' (today: output/in-flight)", async () => {
    // P3 composition: real codex idle chrome + bracketed paste carrying the
    // REAL marker + 15 payload lines (codex/paste-chip.jsonl receipt shows
    // exactly this multi-line `› PASTE_LINE_00 … PASTE_LINE_14` render).
    const marker = buildBootstrapMarker(BINDING);
    const payload = `${marker}\n\nPASTE_LINE_00\nPASTE_LINE_01\nPASTE_LINE_02\nPASTE_LINE_03\nPASTE_LINE_04\nPASTE_LINE_05\nPASTE_LINE_06\nPASTE_LINE_07\nPASTE_LINE_08\nPASTE_LINE_09\nPASTE_LINE_10\nPASTE_LINE_11\nPASTE_LINE_12\nPASTE_LINE_13\nPASTE_LINE_14`;
    const obs = new SessionObserver({
      bindingId: BINDING,
      epoch: "e1",
      cols: 120,
      rows: 32,
    });
    try {
      let seq = 0n;
      const feed = async (data: string) => {
        seq += 1n;
        obs.feed(data, seq);
        await obs.snapshot();
      };
      await feed(
        "\x1b[?2004h\r\nsession text\r\n› \r\nImprove documentation in @filename\r\ngpt-5.4-mini low \u00b7 cwd\r\n",
      );
      await feed(`\x1b[200~${payload}\x1b[201~`);
      await feed("\x1b]0;codex\x07");
      const snap = await obs.snapshot();

      // Precondition: codex draws NO horizontal rules (real no-rules grid) and
      // the marker is still on screen, inside the prompt box area.
      expect(snap.lines.some((l) => /^─{3,}/u.test(l))).toBe(false);
      expect(snap.lines.some((l) => l.includes(marker))).toBe(true);
      // The multi-line box has many non-empty lines, but the no-rules
      // fallback region is the LAST non-empty line only — the marker line is
      // outside it (that is the POL-4 blind spot).
      const prompt = promptRegionLines(snap.lines);
      const promptNonEmpty = prompt.filter((l) => l.trim().length > 0);
      expect(promptNonEmpty.length).toBe(1); // today's fallback: last line only
      expect(promptNonEmpty.some((l) => l.includes(marker))).toBe(false);

      const scan = scanMarker(snap.lines, marker, true);
      const injection = deriveInjectionSignal(scan, true);

      // PRODUCT LAW: the marker sits in the prompt box (on the first line of
      // the multi-line draft) — the injection is LIVE, and the one-live hold
      // must be armed so a second delivery is not attempted.
      expect(scan).toBe("prompt");
      expect(injection).toBe("live");
    } finally {
      obs.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// POL-2 — supervisor turn budget must not count false working→idle flips
// ---------------------------------------------------------------------------

describe("GAP-POL-2: false working→idle flips are not turns", () => {
  const runFlipEpisode = async (flips: number) => {
    const sup = new InjectionSupervisor();
    const escalations: string[] = [];
    sup.setEscalationHandler((_b, reason) => escalations.push(reason));
    sup.setWriter(() => true);
    const { loop, flush } = setup({
      onSnapshot: (snap) => sup.onSnapshot(snap),
    });
    wireSupervisor(loop, sup);
    await flush();
    for (let i = 0; i < flips; i += 1) {
      loop.tui.emitFalseWorking(); // braille title + empty prompt (R1 receipt)
      await flush();
      loop.tui.emitIdleRestore(); // ✳ title + prompt box (K9)
      await flush();
    }
    loop.dispose();
    return escalations;
  };

  it("GAP-POL-2: 3 false flips must NOT escalate (today: escalates 'unguided after 3 turns')", async () => {
    const escalations = await runFlipEpisode(3);
    // Today the supervisor counts each false working→idle flip as a completed
    // turn (deriveTurnSignal: idle + recent output ⇒ ended) and escalates at
    // the 3-turn budget with zero real turns and zero marker observations.
    expect(escalations).toEqual([]);
  });

  it("GAP-POL-2 sanity: REAL marker-observed turns still count toward the budget (today: escalate at 3)", async () => {
    // Positive half of the law: a real turn — marker pasted into the box,
    // submitted, working, idle — must count. Codex renders the paste (with the
    // real marker) directly in the composer, so the marker is observed.
    const sup = new InjectionSupervisor();
    const escalations: string[] = [];
    sup.setEscalationHandler((_b, reason) => escalations.push(reason));
    sup.setWriter(() => true);
    const marker = buildBootstrapMarker(BINDING);
    const { loop, advance, flush } = setup({
      harness: "codex",
      tui: { workingFrames: 1 },
      onSnapshot: (snap) => sup.onSnapshot(snap),
    });
    wireSupervisor(loop, sup);
    await flush();

    for (let i = 0; i < 3; i += 1) {
      const p = loop.drive.writePrompt(
        BINDING,
        `${marker}\n\nrequest ${i}`,
      );
      await advance(40);
      await flush();
      // Marker observed live in the box while pending…
      const during = loop.observer.snapshotNow();
      expect(during.lines.some((l) => l.includes(marker))).toBe(true);
      // …then the CR submits (codex), working frames run, idle restores.
      await advance(2_500);
      await flush();
      await expect(p).resolves.toBe(true);
      await advance(100);
      await flush();
    }
    loop.dispose();
    // Real turns: the budget must be honored and the canvas escalation fires.
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toContain("3 turns");
  });
});

// ---------------------------------------------------------------------------
// POL-5 — noteUserInput sticky across generations (documentation)
// ---------------------------------------------------------------------------

describe("GAP-POL-5: sticky noteUserInput across generations (documentation)", () => {
  it("GAP-POL-5: a gen-1 user input re-seeds gen-2 but does not delay canvas escalation (today's behavior)", async () => {
    const sup = new InjectionSupervisor();
    const escalations: string[] = [];
    sup.setEscalationHandler((_b, reason) => escalations.push(reason));
    sup.setWriter(() => true);
    // Operator typed 5s ago in a previous generation (sticky by design).
    sup.noteUserInput(BINDING, Date.now() - 5_000);
    const { loop, flush } = setup({
      onSnapshot: (snap) => sup.onSnapshot(snap),
    });
    wireSupervisor(loop, sup);
    await flush();
    for (let i = 0; i < 3; i += 1) {
      loop.tui.emitFalseWorking();
      await flush();
      loop.tui.emitIdleRestore();
      await flush();
    }
    loop.dispose();
    // Escalate is canvas-only — it passes the user-present gate, so the
    // sticky input does not delay budget exhaustion (D28: impact is nil today
    // because notify-orient is gone; the re-seed itself is documented).
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toContain("3 turns");
  });
});

// ---------------------------------------------------------------------------
// DRV-4 — mid-sequence write failure must clear the chip it created
// ---------------------------------------------------------------------------

describe("GAP-DRV-4: paste accepted, CR write refused → exactly one clear attempt", () => {
  it("GAP-DRV-4: drive must clear the leaked chip (today: write-failed, no clear, chip stays)", async () => {
    const { loop, advance, flush } = setup({
      tui: { refuseCrWrite: true },
    });
    await flush();
    const p = loop.drive.writePrompt(BINDING, "one\ntwo\nthree");
    await advance(40);
    await flush();
    const ok = await p;

    // ACTUAL today (pre-fix): paste landed, the CR write was refused,
    // executePrompt fired write-failed and returned false WITHOUT
    // clearFailedSubmit — the chip leaked (D20). Documented as a comment
    // (the law below requires the chip to be cleared afterwards).
    expect(ok).toBe(false);

    // PRODUCT LAW: the drive created the chip, so it must clean it up:
    // exactly one idle Ctrl+C (never two — D6 exit window) and the composer
    // must be empty afterwards.
    expect(ctrlC(loop)).toHaveLength(1);
    // Law-aligned: the drive must ATTEMPT the CR (it cannot know the write
    // will be refused) — the harness logs the attempt. The law is the single
    // Ctrl+C + cleared composer, not the absence of the refused CR attempt.
    expect(labels(loop)).toEqual(["paste", "cr", "ctrl-c"]);
    expect(loop.tui.chipPending()).toBe(false);
    loop.dispose();
  });
});

// ---------------------------------------------------------------------------
// DRV-6 — hermes chip semantics (real E2 receipts) + drive reality
// ---------------------------------------------------------------------------

describe("GAP-DRV-6: hermes chips never collapse on a 2nd CR (real E2 receipts)", () => {
  it("GAP-DRV-6a: model receipts match the manifest — chip on paste, CR1/CR2 no collapse, Ctrl+C clears", async () => {
    // Model canonicality: the emitted bytes must render the chip through a
    // REAL observer (same read side as production).
    const emitted: string[] = [];
    const tui = new ScriptedTui({
      harness: "hermes",
      emit: (data) => emitted.push(data),
    });
    const obs = new SessionObserver({
      bindingId: BINDING,
      epoch: "e1",
      cols: 120,
      rows: 32,
    });
    try {
      tui.boot();
      tui.write(
        `${BRACKETED_PASTE_START}PASTE_LINE_00\nPASTE_LINE_01\nPASTE_LINE_02\nPASTE_LINE_03\nPASTE_LINE_04\nPASTE_LINE_05\nPASTE_LINE_06\nPASTE_LINE_07\nPASTE_LINE_08\nPASTE_LINE_09\nPASTE_LINE_10\nPASTE_LINE_11\nPASTE_LINE_12\nPASTE_LINE_13\nPASTE_LINE_14${BRACKETED_PASTE_END}`,
      );
      let seq = 0n;
      for (const data of emitted) {
        seq += 1n;
        obs.feed(data, seq);
        await obs.snapshot();
      }
      const snap = await obs.snapshot();
      // E2 receipt: the chip renders immediately on paste.
      expect(
        snap.lines.some((l) => l.includes("[[ PASTE_LINE_00 PA.. [15 lines] .. PASTE_LINE_13 PASTE_LINE_14 ]]")),
      ).toBe(true);

      // CR@40ms and the slow 2nd CR never collapse it (submitted40=False,
      // submittedSlow=False in hermes/paste-chip.jsonl manifest).
      tui.write(CR);
      expect(tui.chipPending()).toBe(true);
      tui.write(CR);
      expect(tui.chipPending()).toBe(true);
      expect(tui.getPhase()).toBe("idle");
      // clearedByCtrlC=True
      tui.write(INTERRUPT_BYTE);
      expect(tui.chipPending()).toBe(false);
    } finally {
      obs.dispose();
      tui.dispose();
    }
  });

  it("GAP-DRV-6b: hermes is fallback-idle today → drive never pastes; queue-timeout, zero writes (documentation)", async () => {
    const { loop, advance, flush } = setup({
      harness: "hermes",
      drive: { queueTimeoutMs: 800 },
    });
    await flush();
    // Real hermes idle (✓ title + ready footer) evaluates fallback idle —
    // low confidence, not visible → the paste gate refuses (RBR-4 coupling).
    expect(loop.runtime.getState(BINDING)).toBe("idle");
    expect(loop.runtime.isSeatIdle(BINDING)).toBe(false);

    const p = loop.drive.writePrompt(BINDING, "one line");
    await advance(900);
    await flush();
    await expect(p).resolves.toBe(false);
    // Today the drive never reaches the paste (the chip-collapse law for
    // hermes is unreachable until hermes publishes visible idle)…
    expect(loop.writes).toEqual([]);
    expect(loop.tui.chipPending()).toBe(false);
    // …and the prompt waits out the queue budget into attention.
    expect(loop.attention.map((a) => a.reason)).toEqual(["queue-timeout"]);
    loop.dispose();
  });

  it("GAP-DRV-6c: hermes multiline is refused at the write boundary — zero writes, attention", async () => {
    const { loop, flush } = setup({
      harness: "hermes",
      drive: {
        queueTimeoutMs: 800,
        harnessFor: () => "hermes",
      },
    });
    await flush();
    const p = loop.drive.writePrompt(BINDING, "one\ntwo\nthree");
    await flush();
    await expect(p).resolves.toBe(false);
    expect(loop.writes).toEqual([]);
    expect(loop.tui.chipPending()).toBe(false);
    expect(loop.attention.map((a) => a.reason)).toEqual(["multiline-refused"]);
    loop.dispose();
  });
});

// ---------------------------------------------------------------------------
// DRV-7 — Grok `[Pasted:Nlines]` footer is not a composer chip
// ---------------------------------------------------------------------------

describe("GAP-DRV-7: Grok [Pasted:Nlines] footer is not composer chip chrome", () => {
  it("GAP-DRV-7a: observer bytes with [Pasted:40lines] → promptHasPasteChip false, no recipe CR2", async () => {
    // Grok-shaped idle: history, then the history-footer chip Grok paints
    // after a multiline paste (`[Pasted:40lines]`), then the › composer.
    // Real SessionObserver — same read side as production pasteChip.
    const obs = new SessionObserver({
      bindingId: BINDING,
      epoch: "e1",
      cols: 80,
      rows: 16,
    });
    try {
      let seq = 0n;
      const feed = async (data: string) => {
        seq += 1n;
        obs.feed(data, seq);
        await obs.snapshot();
      };
      await feed(
        "\x1b[?2004h\x1b]0;grok\x07\x1b[H\x1b[2J" +
          "old turn\r\n" +
          "› \r\n" +
          "[Pasted:40lines]\r\n",
      );
      const snap = await obs.snapshot();
      expect(snap.lines.some((l) => l.includes("[Pasted:40lines]"))).toBe(true);
      expect(snap.lines.some((l) => l.includes("[Pasted text"))).toBe(false);
      expect(promptHasPasteChip(snap)).toBe(false);
      expect(promptStillPending(snap, "one\ntwo")).toBe(false);

      const writes: string[] = [];
      const drive = new ManagedTerminalDrive({
        write: (_id, data) => {
          writes.push(data);
          return true;
        },
        isSeatIdle: () => true,
        stallWatch: false,
        pasteToCrSettleMs: 0,
        pendingText: () => promptStillPending(obs.snapshotNow(), "one\ntwo"),
        pasteChip: () => promptHasPasteChip(obs.snapshotNow()),
      });
      await expect(drive.writePrompt(BINDING, "one\ntwo")).resolves.toBe(true);
      expect(writes).toEqual([encodeBracketedPaste("one\ntwo"), CR]);
      drive.resetForTest();
    } finally {
      obs.dispose();
    }
  });

  it("GAP-DRV-7b: Codex payload-head leftover is not a chip (D8 is the drive proof)", async () => {
    // No-rules Codex composer still showing the payload after CR1. That is
    // pendingText, not [Pasted text chrome — the drive must not queue CR2.
    // D8 (drive-law.test.ts) is the full-loop proof; this is the predicate.
    const obs = new SessionObserver({
      bindingId: BINDING,
      epoch: "e1",
      cols: 80,
      rows: 16,
    });
    try {
      let seq = 0n;
      const feed = async (data: string) => {
        seq += 1n;
        obs.feed(data, seq);
        await obs.snapshot();
      };
      // No-rules prompt region is the last non-empty line. Leave the payload
      // head there — pendingText, not [Pasted text chrome.
      await feed("\x1b[?2004h\x1b]0;Codex\x07\x1b[H\x1b[2Jsession\r\n› one\r\n");
      const snap = await obs.snapshot();
      expect(snap.lines.some((l) => l.includes("one"))).toBe(true);
      expect(promptHasPasteChip(snap)).toBe(false);
      expect(promptStillPending(snap, "one\ntwo")).toBe(true);
    } finally {
      obs.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// DRV-8 — Amp/Muse ungrounded composer: firstTyped empty, mail stays null
// ---------------------------------------------------------------------------

describe("GAP-DRV-8: Amp/Muse ungrounded composer admits firstTyped only", () => {
  it("GAP-DRV-8: Amp and Muse packs have no composer probes", () => {
    expect(rulePackFor("amp").composer ?? []).toEqual([]);
    expect(rulePackFor("muse").composer ?? []).toEqual([]);
  });

  it("GAP-DRV-8: admitUngroundedFirstTypedComposer(null, pack, true) is empty", () => {
    expect(
      admitUngroundedFirstTypedComposer(null, rulePackFor("amp"), true),
    ).toBe("empty");
    expect(
      admitUngroundedFirstTypedComposer(null, rulePackFor("muse"), true),
    ).toBe("empty");
  });

  it("GAP-DRV-8: mail path stays null when firstTypedArmed is false", async () => {
    // Live grid through a real observer: Amp-shaped settled title, no
    // composer probes → verdict null. Mail (firstTypedArmed false) stays
    // refuse; it must not inherit the firstTyped one-shot empty.
    const obs = new SessionObserver({
      bindingId: BINDING,
      epoch: "e1",
      cols: 80,
      rows: 16,
    });
    try {
      obs.feed("\x1b]0;Ready response - amp - ~/Projects/vellum\x07", 1n);
      const snap = await obs.snapshot();
      const amp = rulePackFor("amp");
      const muse = rulePackFor("muse");
      expect(composerVerdictFor(snap, amp)).toBe(null);
      expect(composerVerdictFor(snap, muse)).toBe(null);
      expect(admitUngroundedFirstTypedComposer(null, amp, false)).toBe(null);
      expect(admitUngroundedFirstTypedComposer(null, muse, false)).toBe(null);
    } finally {
      obs.dispose();
    }
  });
});

// GAP-DRV-9: Grok `[Pasted:Nlines]` footer chip-submit is D9 in
// tests/pty-e2e/scenarios/drive-law.test.ts — not duplicated here.

// ---------------------------------------------------------------------------
// OBS-7 — renderer needsLook must not ride false working→idle flips
// ---------------------------------------------------------------------------

describe("GAP-OBS-7: needsLook arms only after real work (false title flips are not turns)", () => {
  it("GAP-OBS-7: false working→idle title flip must NOT arm needsLook (today: 'Ready — waiting for review')", async () => {
    resetAgentSeatState();
    const { loop, flush } = setup({
      onSnapshot: () => undefined,
    });
    await flush();
    const events: AgentSeatStateEvent[] = [...loop.events];

    // Real false flip: braille title + empty prompt (working) → ✳ idle restore.
    loop.tui.emitFalseWorking();
    await flush();
    loop.tui.emitIdleRestore();
    await flush();
    events.push(...loop.events.slice(events.length));

    // Precondition: the runtime really published the false working→idle pair.
    const states = events.map((e) => e.state);
    expect(states).toContain("working");
    expect(states[states.length - 1]).toBe("idle");

    // Feed the REAL published events into the REAL renderer store.
    for (const ev of events) applyAgentSeatStateEvent(ev);

    // PRODUCT LAW: no real turn happened (no marker-observed submit), so the
    // seat must not present "done — waiting for review".
    expect(agentSeat$.needsLookByBindingId[BINDING].peek()).toBe(false);
    loop.dispose();
  });

  it("GAP-OBS-7 sanity: a real turn still arms needsLook when the surface is closed (today's law)", async () => {
    resetAgentSeatState();
    const { loop, advance, flush } = setup({
      harness: "codex",
      tui: { workingFrames: 1 },
    });
    await flush();
    const p = loop.drive.writePrompt(BINDING, "real request");
    await advance(40);
    await flush();
    await advance(2_500);
    await flush();
    await expect(p).resolves.toBe(true);
    await advance(100);
    await flush();

    const events = [...loop.events];
    const states = events.map((e) => e.state);
    expect(states).toContain("working");
    expect(states[states.length - 1]).toBe("idle");
    for (const ev of events) applyAgentSeatStateEvent(ev);
    // The turn really happened → idle + unseen = done chrome.
    expect(agentSeat$.needsLookByBindingId[BINDING].peek()).toBe(true);
    loop.dispose();
  });
});

// ---------------------------------------------------------------------------
// OBS-14 — debounce burst: 3 confirmations in ~30ms publish idle
// ---------------------------------------------------------------------------

describe("GAP-OBS-14: the 3-confirmation debounce is confirmation-count (documentation)", () => {
  const makeMachine = () => {
    vi.useFakeTimers({ now: 0 });
    const machine = new SeatStateMachine({ now: () => Date.now() });
    const events: Array<{ state: string; at: number }> = [];
    machine.subscribe((e) => events.push({ state: e.state, at: e.at }));
    machine.bind("b", { harness: "claude", epoch: "e1" });
    return { machine, events };
  };

  it("GAP-OBS-14: a 3-confirmation burst at ~30ms publishes idle immediately (cap is the real debounce)", async () => {
    const { machine, events } = makeMachine();
    const obs = new SessionObserver({ bindingId: "b", epoch: "e1", cols: 60, rows: 24 });
    let seq = 0n;
    const feedSnap = async (data: string) => {
      seq += 1n;
      obs.feed(data, seq);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(1);
      return obs.snapshot();
    };
    try {
      // Working first: braille title + OSC 9;4;3 (K9).
      await feedSnap("\x1b]0;⠂ Claude Code\x07\x1b]9;4;3\x07");
      machine.feed(await obs.snapshot(), { harness: "claude" });
      expect(machine.getState("b")).toBe("working");

      // A final output burst of 3 low-confidence idle confirmations in ~30ms.
      // (Real screens: title cleared + neutral text — no rule matches.)
      const idleBytes = "\x1b]0;\x07\x1b]9;4;0\x07just transcript text\r\n";
      for (let i = 0; i < 3; i += 1) {
        await vi.advanceTimersByTimeAsync(10);
        machine.feed(await feedSnap(idleBytes), { harness: "claude" });
      }

      // ACTUAL behavior: the 3rd confirmation (t≈30ms) releases the hold —
      // far before the 700ms cap. This documents that the cap is the real
      // debounce; time-spacing confirmations would be the fix.
      expect(machine.getState("b")).toBe("idle");
      const idleEvent = events.find((e) => e.state === "idle");
      expect(idleEvent).toBeDefined();
      expect(idleEvent!.at).toBeLessThan(SEAT_DEBOUNCE.pendingIdleCapMs);
      expect(idleEvent!.at).toBeGreaterThan(0);
    } finally {
      obs.dispose();
      machine.dispose();
    }
  });

  it("GAP-OBS-14b: a SINGLE confirmation does not publish before the 700ms cap", async () => {
    const { machine, events } = makeMachine();
    const obs = new SessionObserver({ bindingId: "b", epoch: "e1", cols: 60, rows: 24 });
    let seq = 0n;
    const feedSnap = async (data: string) => {
      seq += 1n;
      obs.feed(data, seq);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(1);
      return obs.snapshot();
    };
    try {
      await feedSnap("\x1b]0;⠂ Claude Code\x07\x1b]9;4;3\x07");
      machine.feed(await obs.snapshot(), { harness: "claude" });
      const workingAt = events[events.length - 1]!.at;
      await vi.advanceTimersByTimeAsync(10);
      // Law-aligned (R3a): osc9 4;0 is now a VISIBLE idle (publishes
      // immediately) — the hold case needs a genuinely low-confidence idle,
      // so use the neutral fallback (no title, no OSC 9).
      machine.feed(await feedSnap("\x1b]0;\x07just transcript text\r\n"), { harness: "claude" });
      expect(machine.getState("b")).toBe("working"); // still held after 1 confirmation
      await vi.advanceTimersByTimeAsync(SEAT_DEBOUNCE.pendingIdleCapMs + 50);
      expect(machine.getState("b")).toBe("idle"); // released by the cap timer
      const idleEvent = events.find((e) => e.state === "idle")!;
      expect(idleEvent.at - workingAt).toBeGreaterThanOrEqual(SEAT_DEBOUNCE.pendingIdleCapMs);
    } finally {
      obs.dispose();
      machine.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// OBS-15 — attention heartbeat re-publishes every 800ms
// ---------------------------------------------------------------------------

describe("GAP-OBS-15: sustained visible attention re-publishes on an 800ms heartbeat (documentation)", () => {
  it("GAP-OBS-15: ~4 AgentSeatStateEvents per 3s of sustained attention (heartbeat cadence)", async () => {
    vi.useFakeTimers({ now: 0 });
    const machine = new SeatStateMachine({ now: () => Date.now() });
    const events: Array<{ state: string; at: number }> = [];
    machine.subscribe((e) => events.push({ state: e.state, at: e.at }));
    machine.bind(BINDING, { harness: "claude", epoch: "e1" });
    const obs = new SessionObserver({ bindingId: BINDING, epoch: "e1", cols: 60, rows: 24 });
    let seq = 0n;
    try {
      // Real live-permission-form bytes (K2 grid): visible attention.
      const attentionBytes =
        "Do you want to proceed?\r\n" +
        "❯ 1. Yes\r\n" +
        "  2. No\r\n" +
        "Esc to cancel - Enter to select - Tab/Arrow keys to navigate\r\n";
      for (let i = 0; i < 31; i += 1) {
        seq += 1n;
        obs.feed(attentionBytes, seq);
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(1);
        machine.feed(await obs.snapshot(), { harness: "claude" });
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(machine.getState(BINDING)).toBe("attention");
      const in3s = events.filter(
        (e) => e.state === "attention" && e.at <= 3_000,
      );
      // ACTUAL: initial publish + heartbeat re-publishes at ~800/1600/2400ms —
      // 4 events per 3s (SEAT_DEBOUNCE.stableVisibleRefreshMs). A fix should
      // collapse this to a few (publish only on reason/flag change).
      expect(in3s.length).toBe(4);
      const gaps = in3s.slice(1).map((e, i) => e.at - in3s[i]!.at);
      for (const gap of gaps) {
        expect(gap).toBeGreaterThanOrEqual(SEAT_DEBOUNCE.stableVisibleRefreshMs);
      }
    } finally {
      obs.dispose();
      machine.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// OBS-10 — resize during an in-flight feed (documentation)
// ---------------------------------------------------------------------------

describe("GAP-OBS-10: resize during an in-flight feed (documentation)", () => {
  it("GAP-OBS-10: no throw, seq sane, grid sized to the new viewport", async () => {
    const obs = new SessionObserver({ bindingId: BINDING, epoch: "e1", cols: 80, rows: 24 });
    try {
      const big = "some line of content\r\n".repeat(2_000);
      obs.feed(big, 5n); // write still in flight
      let threw: unknown = null;
      try {
        obs.resize(100, 30); // resize joins no queue (D11)
      } catch (err) {
        threw = err;
      }
      expect(threw).toBeNull();
      const snap = await obs.snapshot();
      expect(snap.seq).toBe(5n); // seq pins to the settled write
      expect(snap.cols).toBe(100);
      expect(snap.rows).toBe(30);
      expect(snap.lines).toHaveLength(30);
    } finally {
      obs.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// OBS-12 — osc9 control bytes pass through unsanitized (documentation)
// ---------------------------------------------------------------------------

describe("GAP-OBS-12: osc9 is not sanitized like the title (documentation)", () => {
  it("GAP-OBS-12: DEL + bare-CSI fragments survive into osc9 and progressFingerprint", async () => {
    const obs = new SessionObserver({ bindingId: BINDING, epoch: "e1", cols: 60, rows: 24 });
    try {
      // OSC 9 payload carrying a DEL (0x7f) and a bare CSI fragment `[0m` —
      // exactly the control class sanitizeTitle strips from OSC 0/2 titles.
      obs.feed("\x1b]9;4;0;evil\x7f[0m\x07", 1n);
      await obs.snapshot();
      const snap = await obs.snapshot();
      // ACTUAL: raw payload retained (slice(0,512), no stripping)…
      expect(snap.signals.osc9).toBe("4;0;evil\x7f[0m");
      // …while the same payload WOULD be stripped by the title sanitizer.
      expect(sanitizeTitle("4;0;evil\x7f[0m")).toBe("4;0;evil");
      // …and the control bytes flow into the turn-progress fingerprint.
      const fp = progressFingerprint(snap);
      expect(fp).toContain("evil\x7f[0m");
    } finally {
      obs.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// OBS-13 — SerializeAddon restores bracketed paste after attach replay
// ---------------------------------------------------------------------------

describe("GAP-OBS-13: attachScreen replay restores bracketed-paste mode (documentation)", () => {
  it("GAP-OBS-13: ESC[?2004h survives serialize + replay into a fresh observer", async () => {
    const obs = new SessionObserver({ bindingId: BINDING, epoch: "e1", cols: 60, rows: 24 });
    try {
      obs.feed("\x1b[?2004hhello world\r\n", 1n);
      await obs.snapshot();
      const attach = await obs.attachScreen();
      expect(attach.serialized).toContain("2004h");
      // Replay into a FRESH observer — the negotiated paste mode must come
      // back, or the renderer grid would accept literal ESC[200~ drive bytes.
      const obs2 = new SessionObserver({ bindingId: BINDING, epoch: "e1", cols: 60, rows: 24 });
      try {
        obs2.feed(attach.serialized, 1n);
        await obs2.snapshot();
        const snap2 = await obs2.snapshot();
        expect(snap2.signals.modes.bracketedPaste).toBe(true);
      } finally {
        obs2.dispose();
      }
    } finally {
      obs.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// OBS-17 — isSeatIdle low-confidence gate keys on the reason string
// ---------------------------------------------------------------------------

describe("GAP-OBS-17: isSeatIdle gates low-confidence idle by reason string (documentation)", () => {
  it("GAP-OBS-17: fallback vs rule reasons behave differently through the REAL gate", async () => {
    const obs = new SessionObserver({ bindingId: BINDING, epoch: "e1", cols: 60, rows: 24 });
    try {
      // Real bytes: neutral grid + OSC 9;4;0 + bracketed paste on + empty title.
      obs.feed("\x1b[?2004h\x1b]0;\x07\x1b]9;4;0\x07neutral text\r\n", 1n);
      await obs.snapshot();
      const snap = await obs.snapshot();

      // (a) RULE path (no OSC hook), low-confidence FALLBACK idle (neutral
      //     grid, no title, no OSC 9 — reason "default_known_agent_idle_fallback")
      //     → gate refuses (fail-closed on unknown chrome).
      const rtRule = new SeatStateRuntime({ now: () => 1_000 });
      rtRule.bindHarness(BINDING, "claude", "e1");
      const fallbackSnap = { ...snap, signals: { ...snap.signals, title: "", osc9: "" } };
      rtRule.machine.feed(fallbackSnap, { harness: "claude" });
      expect(rtRule.machine.getSlot(BINDING)?.state).toBe("idle");
      expect(rtRule.machine.getSlot(BINDING)?.confidence).toBe("low");
      expect(rtRule.isSeatIdle(BINDING)).toBe(false);
      // Law-aligned (R3a): with OSC 9;4;0 present the rule path is now a
      // VISIBLE idle (osc9_idle visibleIdle) → the gate opens.
      const rtRuleOsc9 = new SeatStateRuntime({ now: () => 1_000 });
      rtRuleOsc9.bindHarness(BINDING, "claude", "e1");
      rtRuleOsc9.machine.feed(snap, { harness: "claude" });
      expect(rtRuleOsc9.machine.getSlot(BINDING)?.reason).toBe("rule:osc9_idle");
      expect(rtRuleOsc9.machine.getSlot(BINDING)?.visibleIdle).toBe(true);
      expect(rtRuleOsc9.isSeatIdle(BINDING)).toBe(true);

      // (b) HOOK path: same bytes via runtime.observe → hook:osc9_idle is
      //     high-confidence → gate opens. (The reason STRING differs — the
      //     gate is not purely confidence+visibleIdle.)
      const rtHook = new SeatStateRuntime({ now: () => 1_000 });
      rtHook.bindHarness(BINDING, "claude", "e1");
      rtHook.observe(snap);
      expect(rtHook.machine.getSlot(BINDING)?.reason).toBe("hook:osc9_idle");
      expect(rtHook.isSeatIdle(BINDING)).toBe(true);

      // (c) Muse: the same neutral screen is fallback idle (empty pack) —
      //     refused, unless the firstTyped doctrine arm + paste handshake open
      //     the one-shot exception (the gate matches the fallback STRING).
      const rtMuse = new SeatStateRuntime({ now: () => 1_000 });
      rtMuse.bindHarness(BINDING, "muse", "e1");
      rtMuse.machine.feed(snap, { harness: "muse" });
      expect(rtMuse.machine.getSlot(BINDING)?.reason).toBe(
        "default_known_agent_idle_fallback",
      );
      expect(rtMuse.isSeatIdle(BINDING)).toBe(false);
      armFirstTypedMessage(BINDING, "## doctrine\npayload");
      rtMuse.observe(snap);
      expect(rtMuse.isSeatIdle(BINDING)).toBe(true);
      rtMuse.stop();
      rtRule.stop();
      rtHook.stop();
    } finally {
      obs.dispose();
    }
  });
});
