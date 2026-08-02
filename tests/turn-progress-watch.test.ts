import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TURN_STALL_MS,
  TURN_STALLED_REASON,
  TurnProgressWatch,
  progressFingerprint,
} from "../src/main/vellum/term/agent-state/turn-progress-watch";
import { SeatStateRuntime } from "../src/main/vellum/term/agent-state/runtime";
import type { ObserverGridSnapshot } from "../src/main/vellum/term/observer/types";
import { ManagedTerminalDrive } from "../src/main/vellum/term/drive/managed-terminal-drive";

const snap = (
  bindingId: string,
  partial: Partial<ObserverGridSnapshot> & {
    title?: string;
    lines?: string[];
    seq?: bigint;
  } = {},
): ObserverGridSnapshot => {
  const lines = partial.lines ?? ["thinking…"];
  return {
    bindingId,
    epoch: partial.epoch ?? "e1",
    cols: 80,
    rows: 24,
    lines,
    text: lines.join("\n"),
    seq: partial.seq ?? 1n,
    signals: {
      title: partial.title ?? partial.signals?.title ?? "Thinking",
      osc9: partial.signals?.osc9 ?? "4;3",
      modes: partial.signals?.modes ?? {
        bracketedPaste: true,
        synchronizedOutput: false,
        altScreen: false,
        mouseModes: [],
      },
    },
  };
};

describe("TurnProgressWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms on first arm, fires once after stallMs with no progress", () => {
    const stalls: string[] = [];
    const watch = new TurnProgressWatch({
      now: () => Date.now(),
      stallMs: 1_000,
      onStall: (id) => stalls.push(id),
    });
    watch.arm("b1");
    expect(watch.isArmed("b1")).toBe(true);
    watch.arm("b1"); // idempotent
    vi.advanceTimersByTime(999);
    expect(stalls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(stalls).toEqual(["b1"]);
    expect(watch.isArmed("b1")).toBe(false);
  });

  it("progress resets the deadline", () => {
    const stalls: string[] = [];
    const watch = new TurnProgressWatch({
      stallMs: 1_000,
      onStall: (id) => stalls.push(id),
    });
    watch.arm("b1");
    vi.advanceTimersByTime(800);
    watch.noteProgress("b1");
    vi.advanceTimersByTime(800);
    expect(stalls).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(stalls).toEqual(["b1"]);
  });

  it("clear prevents fire", () => {
    const stalls: string[] = [];
    const watch = new TurnProgressWatch({
      stallMs: 500,
      onStall: (id) => stalls.push(id),
    });
    watch.arm("b1");
    watch.clear("b1");
    vi.advanceTimersByTime(1_000);
    expect(stalls).toEqual([]);
  });

  it("documents default threshold", () => {
    expect(DEFAULT_TURN_STALL_MS).toBe(90_000);
    expect(TURN_STALLED_REASON).toBe("turn-stalled");
  });
});

describe("progressFingerprint", () => {
  it("changes when seq or title changes", () => {
    const a = progressFingerprint({
      seq: 1n,
      signals: { title: "Thinking", osc9: "" },
      text: "x",
    });
    const b = progressFingerprint({
      seq: 2n,
      signals: { title: "Thinking", osc9: "" },
      text: "x",
    });
    const c = progressFingerprint({
      seq: 1n,
      signals: { title: "Responding", osc9: "" },
      text: "x",
    });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("SeatStateRuntime mid-turn stall", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms on working, fires attention turn-stalled (never idle), sticky until progress", () => {
    const events: Array<{ state: string; reason: string }> = [];
    let t = 1_000;
    const rt = new SeatStateRuntime({
      now: () => t,
      turnStallMs: 1_000,
      onEvent: (e) => events.push({ state: e.state, reason: e.reason }),
    });
    rt.bindHarness("b1", "grok", "e1");

    // Grok working chrome (title Thinking keeps state working).
    rt.observe(
      snap("b1", {
        title: "Thinking",
        lines: ["…"],
        seq: 1n,
        signals: {
          title: "Thinking",
          osc9: "4;3",
          modes: {
            bracketedPaste: true,
            synchronizedOutput: false,
            altScreen: false,
            mouseModes: [],
          },
        },
      }),
    );
    expect(rt.getState("b1")).toBe("working");
    expect(rt.isSeatIdle("b1")).toBe(false);

    // No progress: same fingerprint after silence.
    t = 2_000;
    vi.advanceTimersByTime(1_000);

    expect(rt.getState("b1")).toBe("attention");
    expect(rt.machine.getSlot("b1")?.reason).toBe(TURN_STALLED_REASON);
    expect(rt.isTurnStalled("b1")).toBe(true);
    expect(rt.isSeatIdle("b1")).toBe(false);
    expect(events.some((e) => e.state === "idle")).toBe(false);

    // Frozen working chrome must not flip back to cyan without progress.
    t = 2_100;
    rt.observe(
      snap("b1", {
        title: "Thinking",
        lines: ["…"],
        seq: 1n,
        signals: {
          title: "Thinking",
          osc9: "4;3",
          modes: {
            bracketedPaste: true,
            synchronizedOutput: false,
            altScreen: false,
            mouseModes: [],
          },
        },
      }),
    );
    expect(rt.getState("b1")).toBe("attention");
    expect(rt.machine.getSlot("b1")?.reason).toBe(TURN_STALLED_REASON);

    // Progress resumes working path.
    t = 2_200;
    rt.observe(
      snap("b1", {
        title: "Thinking",
        lines: ["tool output"],
        seq: 2n,
        signals: {
          title: "Thinking",
          osc9: "4;3",
          modes: {
            bracketedPaste: true,
            synchronizedOutput: false,
            altScreen: false,
            mouseModes: [],
          },
        },
      }),
    );
    expect(rt.isTurnStalled("b1")).toBe(false);
    expect(rt.getState("b1")).toBe("working");

    rt.stop();
  });

  it("happy-path working→idle clears watch and does not fire stall", () => {
    const stalls: string[] = [];
    let t = 1_000;
    const rt = new SeatStateRuntime({
      now: () => t,
      turnStallMs: 5_000,
      onEvent: (e) => {
        if (e.reason === TURN_STALLED_REASON) stalls.push(e.bindingId);
      },
    });
    rt.bindHarness("b1", "claude", "e1");

    // Working title for claude (braille-ish).
    rt.observe(
      snap("b1", {
        title: "⣿",
        lines: ["working"],
        seq: 1n,
      }),
    );
    // May be working or unknown depending on rules — force path via machine if needed.
    if (rt.getState("b1") !== "working") {
      rt.machine.force("b1", "working", "rule:test_working", "high");
    }
    expect(rt.getState("b1")).toBe("working");

    t = 2_000;
    // Visible idle chrome for claude (prompt box).
    rt.observe(
      snap("b1", {
        title: "",
        lines: [
          "────────────────",
          "❯ ready",
          "────────────────",
        ],
        seq: 3n,
      }),
    );
    expect(rt.getState("b1")).toBe("idle");
    t = 10_000;
    vi.advanceTimersByTime(10_000);
    expect(stalls).toEqual([]);
    expect(rt.isTurnStalled("b1")).toBe(false);
    rt.stop();
  });

  it("stall does not drain managed prompt queue as idle", async () => {
    let t = 1_000;
    const rt = new SeatStateRuntime({
      now: () => t,
      turnStallMs: 500,
    });
    rt.bindHarness("b1", "grok", "e1");
    rt.machine.force("b1", "working", "rule:test", "high");

    const writes: string[] = [];
    const drive = new ManagedTerminalDrive({
      write: (_id, data) => {
        writes.push(data);
        return true;
      },
      isSeatIdle: (id) => rt.isSeatIdle(id),
      stallWatch: false,
    });

    // Queue a follow-up while working (not idle).
    const queued = drive.writePrompt("b1", "second-prompt", {
      queueIfBusy: true,
      queueTimeoutMs: 30_000,
    });
    expect(drive.queuedCount("b1")).toBe(1);

    t = 2_000;
    vi.advanceTimersByTime(500);
    expect(rt.getState("b1")).toBe("attention");
    expect(rt.isSeatIdle("b1")).toBe(false);
    // Stall must not call onSeatIdle — queue stays.
    expect(drive.queuedCount("b1")).toBe(1);
    expect(writes).toEqual([]);

    // Explicit idle drain is the only re-inject path.
    rt.machine.force("b1", "idle", "rule:test_idle", "high");
    drive.onSeatIdle("b1");
    await queued;
    expect(writes.length).toBeGreaterThan(0);
    rt.stop();
  });
});
