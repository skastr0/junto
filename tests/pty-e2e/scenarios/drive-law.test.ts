/**
 * Drive-law repro scenarios (D1–D6) against the REAL ManagedTerminalDrive +
 * SeatStateRuntime + SessionObserver in a full loop (wiring mirrors
 * src/main/vellum-command/ipc.ts: seat working → drive.onTurnStart, idle →
 * drive.onSeatIdle; isSeatIdle = runtime.isSeatIdle).
 *
 * The "harness" is the in-process ScriptedTui byte model (scripted-tui.ts),
 * grounded in the 2026-08 managed-terminal probe receipts:
 *   K3 paste+CR chip collapse, K8 Ctrl+C semantics, K9 OSC title/osc9.
 *
 * Anti-hacking: no hand-built ObserverGridSnapshot objects anywhere. Every
 * screen truth flows through a real SessionObserver fed by the model's
 * emitted bytes; the canonicality gate at the top validates each distinct
 * paint before any scenario uses it.
 *
 * Chip-submit CR is part of the write recipe (paste → CR → evidence CR),
 * not a 5s stall recovery. Tests assert that law.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  CR,
  INTERRUPT_BYTE,
} from "../../../src/main/vellum-command/term/drive";
import { DriveLoop, ScriptedTui, type DriveLoopOptions } from "../scripted-tui";

const BINDING = "seat-b1";

/** Fake-clock setup. Timers and Date.now() advance in lockstep (vitest
 * fake timers own Date), so the drive/runtime/model all read the same clock.
 * flush() advances >= 1ms: xterm's WriteBuffer schedules its flush with
 * setTimeout, and a timer scheduled during a tick is only picked up by a
 * later POSITIVE advance (advance(0) misses same-tick timers). */
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

afterEach(() => {
  vi.useRealTimers();
});

describe("canonicality gate — real SessionObserver on emitted bytes", () => {
  it("boot idle paint: ✳ title, OSC 9;4;0, bracketed-paste mode, prompt glyph", async () => {
    const { loop, flush } = setup();
    await flush();
    const snap = loop.observer.snapshotNow();
    expect(snap.signals.title).toBe("✳ Claude Code");
    expect(snap.signals.osc9).toBe("4;0;");
    expect(snap.signals.modes.bracketedPaste).toBe(true);
    expect(snap.lines.some((l) => l.trim() === "❯")).toBe(true);
    expect(loop.runtime.getState(BINDING)).toBe("idle");
    expect(loop.runtime.isSeatIdle(BINDING)).toBe(true);
    loop.dispose();
  });

  it("chip paint evaluates idle through the real runtime (composer_draft_idle 1150)", async () => {
    const { loop, advance, flush } = setup({
      tui: { secondCrSubmits: false },
    });
    await flush();
    loop.drive.writePrompt(BINDING, "one\ntwo\nthree");
    await advance(40);
    await flush();
    expect(loop.tui.chipPending()).toBe(true);
    expect(loop.runtime.getState(BINDING)).toBe("idle");
    expect(loop.runtime.isSeatIdle(BINDING)).toBe(true);
    loop.dispose();
  });

  it("false-working paint (R1 receipt: empty prompt + braille title) evaluates working", async () => {
    const { loop, flush } = setup();
    await flush();
    loop.tui.emitFalseWorking();
    await flush();
    expect(loop.runtime.getState(BINDING)).toBe("working");
    expect(loop.runtime.isSeatIdle(BINDING)).toBe(false);
    loop.dispose();
  });

  it("chip + braille title stays idle (R2 sanity, passes today)", async () => {
    const { loop, advance, flush } = setup({
      tui: { secondCrSubmits: false },
    });
    await flush();
    loop.drive.writePrompt(BINDING, "one\ntwo");
    await advance(40);
    await flush();
    loop.tui.emitBrailleTitleWithChip();
    await flush();
    expect(loop.tui.chipPending()).toBe(true);
    expect(loop.runtime.getState(BINDING)).toBe("idle");
    loop.dispose();
  });

  it("codex paint: plain title idles via osc_title_idle; separate CR submits", async () => {
    const { loop, flush } = setup({ harness: "codex" });
    await flush();
    expect(loop.runtime.getState(BINDING)).toBe("idle");
    expect(loop.observer.snapshotNow().signals.title).toBe("Codex");
    loop.tui.write(
      `\x1b[200~status please\x1b[201~`,
    );
    loop.tui.write(CR);
    await flush();
    expect(loop.tui.getPhase()).toBe("working");
    expect(loop.runtime.getState(BINDING)).toBe("working");
    loop.dispose();
  });
});

describe("D1 — paste+CR on the Claude chip model", () => {
  const runStuckEpisode = async (
    settleMs: number,
  ): Promise<ReturnType<typeof setup>> => {
    const { loop, advance, flush } = setup({
      tui: { secondCrSubmits: false, workingFrames: 1 },
      stallTimeoutMs: 5_000,
      pasteToCrSettleMs: settleMs,
    });
    await flush();
    const p = loop.drive.writePrompt(BINDING, "one\ntwo\nthree");
    await flush();
    expect(labels(loop)).toEqual(["paste"]); // paste landed at t=0
    await advance(settleMs);
    await flush();
    // Recipe: first CR + immediate chip-submit CR. The harness is stuck
    // (`secondCrSubmits: false`), so the chip remains after both CRs.
    expect(loop.tui.chipPending()).toBe(true);
    expect(labels(loop)).toEqual(["paste", "cr", "cr"]);
    expect(loop.runtime.getState(BINDING)).toBe("idle");
    let settled: boolean | null = null;
    void p.then((ok) => { settled = ok; });
    // The first timeout permits one recovery CR for the same pending paste.
    await advance(5_000);
    await flush();
    expect(settled).toBeNull();
    expect(labels(loop)).toEqual(["paste", "cr", "cr", "cr"]);
    expect(loop.attention).toEqual([]);
    // Exhausting that recovery returns false and preserves the chip.
    await advance(5_000);
    await flush();
    await expect(p).resolves.toBe(false);
    expect(labels(loop)).toEqual(["paste", "cr", "cr", "cr"]);
    expect(loop.drive.pasteWriteCount(BINDING)).toBe(1);
    expect(loop.attention.map((a) => a.reason)).toEqual(["prompt-stalled"]);
    expect(ctrlC(loop)).toHaveLength(0);
    expect(loop.tui.chipPending()).toBe(true);
    expect(loop.tui.getPhase()).toBe("idle");
    return { loop, advance, flush };
  };

  it("settle 40ms: chip remains after recipe CRs → writePrompt FALSE + prompt-stalled without cleanup", async () => {
    const { loop } = await runStuckEpisode(40);
    // Exact write log: recipe CRs after settle, then one bounded recovery.
    expect(loop.writes.map((w) => w.t)).toEqual([
      1_000_002, // paste
      1_000_042, // cr (settle 40ms)
      1_000_042, // chip-submit cr (immediate)
      1_005_042, // recovery after the first ACK timeout
    ]);
    loop.dispose();
  });

  it("settle 80ms variant: identical law, CRs shifted to 80ms", async () => {
    const { loop } = await runStuckEpisode(80);
    expect(loop.writes.map((w) => w.t)).toEqual([
      1_000_002,
      1_000_082, // settle 80ms
      1_000_082, // chip-submit cr
      1_005_082, // recovery after the first ACK timeout
    ]);
    loop.dispose();
  });
});

describe("D2 — false-working must not resolve awaitTurnStart on an unsubmitted chip", () => {
  it("false-working on an unsubmitted chip does not resolve writePrompt", async () => {
    const { loop, advance, flush } = setup({
      tui: { secondCrSubmits: false, workingFrames: 1 },
      stallTimeoutMs: 5_000,
      pasteToCrSettleMs: 40,
    });
    await flush();
    const p = loop.drive.writePrompt(BINDING, "one\ntwo\nthree");
    await advance(40);
    await flush();
    expect(loop.tui.chipPending()).toBe(true);
    expect(loop.events.filter((e) => e.state === "working")).toHaveLength(0);

    // R2 sanity first: chip visible + braille title stays idle — no ack.
    loop.tui.emitBrailleTitleWithChip();
    await flush();
    expect(loop.runtime.getState(BINDING)).toBe("idle");
    let settled: boolean | null = null;
    void p.then((ok) => {
      settled = ok;
    });
    await flush();
    expect(settled).toBeNull();

    // False working: braille title + OSC 9;4;3 + EMPTY prompt (R1 receipt).
    // No submission happened — the model still holds the chip.
    loop.tui.emitFalseWorking();
    await flush();
    expect(loop.runtime.getState(BINDING)).toBe("working");
    expect(loop.events.filter((e) => e.state === "working").length).toBeGreaterThan(0);
    await flush();
    expect(loop.tui.chipPending()).toBe(true); // receipt on an UNSUBMITTED chip

    // PRODUCT LAW: the drive must NOT resolve true while the chip is pending.
    expect(settled).toBeNull();
    expect(loop.attention).toEqual([]);
    expect(labels(loop)).toEqual(["paste", "cr", "cr"]);
    loop.dispose();
  });
});

describe("D3 — unresolved delivery must never Ctrl+C a working agent", () => {
  it("late working ack after a submitted chip CR does not Ctrl+C the working turn", async () => {
    const { loop, advance, flush } = setup({
      // Chip collapses on the recipe chip CR, but the working repaint is
      // delivered 6s late — past the first 5s ACK window.
      tui: { secondCrSubmits: true, workingFrames: 2, ackDelayMs: 6_000 },
      stallTimeoutMs: 5_000,
      pasteToCrSettleMs: 40,
    });
    await flush();
    const p = loop.drive.writePrompt(BINDING, "one\ntwo");
    await advance(40);
    await flush();
    // Recipe chip-submit CR collapses the chip immediately (not at 5s).
    expect(labels(loop)).toEqual(["paste", "cr", "cr"]);
    expect(loop.tui.getPhase()).toBe("working");
    expect(loop.tui.chipPending()).toBe(false);

    await advance(5_000); // first ACK timeout; working repaint is still in flight
    await flush();
    // Law-aligned (live duplicate fix): the retry CR SUBMITTED — the TUI
    // truth is working and our text left the composer; only the working
    // repaint is late. That is "Fired" per the product law → the drive
    // resolves TRUE (never false), so the delivery layer receipts the
    // message and can never re-paste it on a later idle.
    await expect(p).resolves.toBe(true);

    // PRODUCT LAW: delivery recovery must not interrupt the working agent.
    expect(ctrlC(loop)).toEqual([]);

    // Positive submission evidence resolves success without stalled attention.
    expect(loop.attention).toEqual([]);
    expect(labels(loop)).toEqual(["paste", "cr", "cr"]);

    // The late ack is a no-op for the drive (no pending turn).
    await advance(1_100);
    await flush();
    expect(loop.events.filter((e) => e.state === "working").length).toBeGreaterThan(0);
    loop.dispose();
  });
});

describe("D4 — awaitTurnStart:false (firstTyped path) must not receipt a chip", () => {
  it("chip remains after recipe → writePrompt FALSE and the chip is preserved", async () => {
    const { loop, advance, flush } = setup({
      tui: { secondCrSubmits: false, workingFrames: 1 },
      stallTimeoutMs: 5_000,
      pasteToCrSettleMs: 40,
    });
    await flush();
    const p = loop.drive.writePrompt(BINDING, "one\ntwo\nthree", {
      awaitTurnStart: false,
    });
    await advance(40);
    await flush();
    // Two evidence settles after the recipe CR — late chip paint.
    await advance(40);
    await flush();
    await advance(40);
    await flush();
    const ok = await p;
    // PRODUCT LAW: never return true while a paste chip sits in the composer
    // (firstTyped arm is consumed on resolve → gate closes → chip stays).
    expect(ok).toBe(false);
    expect(loop.tui.chipPending()).toBe(true);
    expect(labels(loop)).toEqual(["paste", "cr", "cr"]);
    expect(loop.attention.map((a) => a.reason)).toEqual(["prompt-stalled"]);
    loop.dispose();
  });

  it("snapshot-only pendingText: chip on the observer grid still refuses firstTyped", async () => {
    const { loop, advance, flush } = setup({
      tui: { secondCrSubmits: false, workingFrames: 1 },
      stallTimeoutMs: 5_000,
      pasteToCrSettleMs: 40,
      pendingEvidence: "snapshot",
    });
    await flush();
    const p = loop.drive.writePrompt(BINDING, "one\ntwo\nthree", {
      awaitTurnStart: false,
    });
    await advance(40);
    await flush();
    await advance(40);
    await flush();
    await advance(40);
    await flush();
    const snap = loop.observer.snapshotNow();
    expect(snap.lines.some((l) => l.includes("[Pasted text"))).toBe(true);
    await expect(p).resolves.toBe(false);
    expect(labels(loop)).toEqual(["paste", "cr", "cr"]);
    expect(loop.attention.map((a) => a.reason)).toEqual(["prompt-stalled"]);
    loop.dispose();
  });

  it("firstTyped does not Ctrl+C after a recipe CR that already submitted", async () => {
    const { loop, advance, flush } = setup({
      tui: { secondCrSubmits: true, workingFrames: 1 },
      stallTimeoutMs: 5_000,
      pasteToCrSettleMs: 40,
    });
    await flush();
    const p = loop.drive.writePrompt(BINDING, "one\ntwo", {
      awaitTurnStart: false,
    });
    await advance(40);
    await flush();
    await advance(40);
    await flush();
    await advance(40);
    await flush();
    await expect(p).resolves.toBe(true);
    expect(ctrlC(loop)).toEqual([]);
    expect(loop.tui.chipPending()).toBe(false);
    expect(labels(loop)).toEqual(["paste", "cr", "cr"]);
    loop.dispose();
  });
});

describe("D5 — 2nd-CR collapse (sanity, passes today)", () => {
describe("D7 — FIRED-LAW: paste submitted, working ack late → resolve TRUE (live 4x duplicate class)", () => {
  it("D7: text leaves the composer before the timeout → TRUE without recovery or attention", async () => {
    const { loop, advance, flush } = setup({
      // Real submit on the FIRST CR (single-line paste), but the working
      // repaint is delivered 6s later — past the 5s stall window. This is
      // the live report shape: one msg.send pasted 4x because each paste
      // fired while the ack was late, so the drive resolved false and the
      // delivery layer re-pasted on every idle.
      tui: { chipOnMultilinePaste: false, workingFrames: 1, ackDelayMs: 6_000 },
      stallTimeoutMs: 5_000,
      pasteToCrSettleMs: 40,
    });
    await flush();
    const p = loop.drive.writePrompt(BINDING, "single line");
    await advance(40);
    await flush();
    expect(loop.tui.getPhase()).toBe("working"); // model truth: fired

    await advance(5_000); // stall closes without an ack
    await flush();
    // FIRED-LAW: our text is no longer in the composer → delivered.
    await expect(p).resolves.toBe(true);
    expect(ctrlC(loop)).toEqual([]);
    // Attention belongs to a final failure, not an intermediate ACK timeout.
    expect(loop.attention).toEqual([]);
    expect(labels(loop)).toEqual(["paste", "cr"]);
    loop.dispose();
  });
});

  it("chip + recipe CR submits → writePrompt true, working then idle", async () => {
    const { loop, advance, flush } = setup({
      tui: { secondCrSubmits: true, workingFrames: 2 },
      stallTimeoutMs: 5_000,
      pasteToCrSettleMs: 40,
    });
    await flush();
    const p = loop.drive.writePrompt(BINDING, "one\ntwo");
    await advance(40);
    await flush();
    expect(labels(loop)).toEqual(["paste", "cr", "cr"]);
    expect(loop.tui.chipPending()).toBe(false);
    await advance(1);
    await flush();
    await expect(p).resolves.toBe(true);
    expect(loop.attention).toEqual([]);
    expect(loop.events.filter((e) => e.state === "working").length).toBeGreaterThan(0);

    // Working frames then idle restore (K9: ✳ + 9;4;0 + prompt box).
    await advance(3_000);
    await flush();
    expect(loop.tui.getPhase()).toBe("idle");
    expect(loop.events.filter((e) => e.state === "idle").length).toBeGreaterThan(0);
    expect(ctrlC(loop)).toHaveLength(0);
    loop.dispose();
  });
});

describe("D6 — an unresolved paste stops automatic writes on the binding", () => {
  it("one failed episode preserves the chip without automatic Ctrl+C", async () => {
    const { loop, advance, flush } = setup({
      tui: { secondCrSubmits: false, workingFrames: 1 },
      stallTimeoutMs: 5_000,
      pasteToCrSettleMs: 40,
    });
    await flush();
    const p = loop.drive.writePrompt(BINDING, "a\nb");
    await advance(40);
    await flush();
    await advance(10_000); // original ACK wait plus one recovery ACK wait
    await flush();
    await expect(p).resolves.toBe(false);
    expect(ctrlC(loop)).toHaveLength(0);
    expect(labels(loop)).toEqual(["paste", "cr", "cr", "cr"]);
    expect(loop.attention.map((a) => a.reason)).toEqual(["prompt-stalled"]);
    expect(loop.tui.getPhase()).toBe("idle");
    expect(loop.tui.chipPending()).toBe(true);
    loop.dispose();
  });

  it("an immediate delivery retry cannot paste over the unresolved chip", async () => {
    const { loop, advance, flush } = setup({
      tui: { secondCrSubmits: false, workingFrames: 1 },
      stallTimeoutMs: 450,
      pasteToCrSettleMs: 40,
    });
    await flush();
    const p1 = loop.drive.writePrompt(BINDING, "a\nb");
    await advance(40);
    await flush();
    await advance(900); // original ACK wait plus one recovery ACK wait
    await flush();
    await expect(p1).resolves.toBe(false);
    expect(ctrlC(loop)).toHaveLength(0);
    expect(loop.tui.getPhase()).toBe("idle");
    expect(loop.tui.chipPending()).toBe(true);

    // message-delivery style immediate retry on the idle event
    await expect(loop.drive.writePrompt(BINDING, "c\nd")).resolves.toBe(false);
    loop.drive.onSeatIdle(BINDING);
    await advance(450);
    await flush();
    expect(labels(loop)).toEqual(["paste", "cr", "cr", "cr"]);
    expect(loop.drive.pasteWriteCount(BINDING)).toBe(1);
    expect(ctrlC(loop)).toHaveLength(0);
    expect(loop.tui.chipPending()).toBe(true);
    expect(loop.tui.getPhase()).toBe("idle");
    loop.dispose();
  });

  it("elapsed time does not re-arm a binding with an unresolved paste", async () => {
    const { loop, advance, flush } = setup({
      tui: { secondCrSubmits: false, workingFrames: 1 },
      stallTimeoutMs: 1_100,
      pasteToCrSettleMs: 40,
    });
    await flush();
    const p1 = loop.drive.writePrompt(BINDING, "a\nb");
    await advance(40);
    await flush();
    await advance(2_200); // original ACK wait plus one recovery ACK wait
    await flush();
    await expect(p1).resolves.toBe(false);
    expect(ctrlC(loop)).toHaveLength(0);

    // Waiting beyond the former idle-interrupt gap must not reopen admission.
    await advance(1_100);
    await flush();
    await expect(loop.drive.writePrompt(BINDING, "c\nd")).resolves.toBe(false);
    expect(labels(loop)).toEqual(["paste", "cr", "cr", "cr"]);
    expect(loop.drive.pasteWriteCount(BINDING)).toBe(1);
    expect(ctrlC(loop)).toHaveLength(0);
    expect(loop.tui.chipPending()).toBe(true);
    expect(loop.tui.getPhase()).toBe("idle");
    loop.dispose();
  });
});

describe("D8 — Codex snapshot evidence must not send a chip-submit CR", () => {
  it("literal pending text permits later bounded recovery, never an immediate chip CR or early receipt", async () => {
    const { loop, advance, flush } = setup({
      harness: "codex",
      pendingEvidence: "snapshot",
      tui: { workingFrames: 1, ackDelayMs: 6_000 },
      stallTimeoutMs: 5_000,
      pasteToCrSettleMs: 40,
    });
    await flush();
    const p = loop.drive.writePrompt(BINDING, "one\ntwo");
    let settled: boolean | null = null;
    void p.then((ok) => { settled = ok; });
    await advance(40);
    await flush();
    // Chip-CR path waits one more settle when chrome is absent.
    await advance(40);
    await flush();
    // Codex submits on the first CR. Snapshot-only pendingText still sees
    // the payload head (working paint is delayed) — that is not a chip.
    expect(loop.tui.getPhase()).toBe("working");
    expect(loop.tui.chipPending()).toBe(false);
    expect(labels(loop)).toEqual(["paste", "cr"]);
    await advance(5_000);
    await flush();
    expect(settled).toBeNull();
    expect(labels(loop)).toEqual(["paste", "cr", "cr"]);
    expect(loop.attention).toEqual([]);
    // Only the delayed working paint clears pending evidence and permits success.
    await advance(1_100);
    await flush();
    await expect(p).resolves.toBe(true);
    expect(labels(loop)).toEqual(["paste", "cr", "cr"]);
    expect(loop.drive.pasteWriteCount(BINDING)).toBe(1);
    expect(loop.attention).toEqual([]);
    expect(ctrlC(loop)).toEqual([]);
    loop.dispose();
  }, 15_000);
});

describe("D9 — Grok history footer is not a chip-submit CR", () => {
  it("history footer never adds a chip CR; literal pending text allows one later recovery", async () => {
    const { loop, advance, flush } = setup({
      harness: "grok",
      pendingEvidence: "snapshot",
      tui: { workingFrames: 1, ackDelayMs: 6_000 },
      stallTimeoutMs: 5_000,
      pasteToCrSettleMs: 40,
    });
    await flush();
    expect(loop.runtime.getState(BINDING)).toBe("idle");
    const p = loop.drive.writePrompt(BINDING, "one\ntwo");
    let settled: boolean | null = null;
    void p.then((ok) => { settled = ok; });
    await advance(40);
    await flush();
    await advance(40);
    await flush();
    expect(loop.tui.getPhase()).toBe("working");
    expect(loop.tui.chipPending()).toBe(false);
    expect(
      loop.observer.snapshotNow().lines.some((l) => l.includes("[Pasted:2lines]")),
    ).toBe(true);
    expect(labels(loop)).toEqual(["paste", "cr"]);
    await advance(5_000);
    await flush();
    expect(settled).toBeNull();
    expect(labels(loop)).toEqual(["paste", "cr", "cr"]);
    expect(loop.attention).toEqual([]);
    await advance(1_100);
    await flush();
    await expect(p).resolves.toBe(true);
    expect(labels(loop)).toEqual(["paste", "cr", "cr"]);
    expect(loop.drive.pasteWriteCount(BINDING)).toBe(1);
    expect(loop.attention).toEqual([]);
    expect(ctrlC(loop)).toEqual([]);
    loop.dispose();
  }, 15_000);
});

describe("scripted TUI protocol receipts", () => {
  it("single-line paste inserts into the composer and a CR submits", async () => {
    const tui = new ScriptedTui({
      harness: "claude",
      emit: () => undefined,
      chipOnMultilinePaste: true,
    });
    tui.boot();
    tui.write(`\x1b[200~hello world\x1b[201~`);
    expect(tui.chipPending()).toBe(false);
    tui.write(CR);
    expect(tui.getPhase()).toBe("working");
    tui.dispose();
  });

  it("K8: idle Ctrl+C with text clears the composer (one press, no exit)", async () => {
    const tui = new ScriptedTui({ harness: "claude", emit: () => undefined });
    tui.boot();
    tui.write(`\x1b[200~a\nb\nc\x1b[201~`);
    expect(tui.chipPending()).toBe(true);
    tui.write(INTERRUPT_BYTE);
    expect(tui.chipPending()).toBe(false);
    expect(tui.getPhase()).toBe("idle");
    tui.dispose();
  });

  it("K8: two idle Ctrl+C inside ~1s exits; outside the window it does not", async () => {
    let now = 0;
    const tui = new ScriptedTui({
      harness: "claude",
      emit: () => undefined,
      now: () => now,
    });
    tui.boot();
    tui.write(INTERRUPT_BYTE); // arm (empty composer)
    tui.write(INTERRUPT_BYTE); // still inside window → exit
    expect(tui.getPhase()).toBe("exiting");

    const tui2 = new ScriptedTui({
      harness: "claude",
      emit: () => undefined,
      now: () => now,
    });
    tui2.boot();
    tui2.write(INTERRUPT_BYTE);
    now += 1_200;
    tui2.write(INTERRUPT_BYTE); // window expired → re-arm, no exit
    expect(tui2.getPhase()).toBe("idle");
    tui.dispose();
    tui2.dispose();
  });

  it("C2: codex swallows a CR joined into the payload write; separate CR submits", async () => {
    const tui = new ScriptedTui({ harness: "codex", emit: () => undefined });
    tui.boot();
    tui.write(`${BRACKETED_PASTE_START}/status${BRACKETED_PASTE_END}${CR}`);
    expect(tui.getPhase()).toBe("idle"); // joined → NOT submitted (C2 P9/P12)
    tui.write(CR);
    expect(tui.getPhase()).toBe("working"); // separate → submitted (C2 P8/P11)
    tui.dispose();
  });
});
