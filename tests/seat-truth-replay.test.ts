/**
 * PTY-Factory B replay pack — synthetic snapshots for seat-truth gates.
 *
 * 1. Dialog false-idle (Claude + Grok): unmatched / permission chrome must not
 *    authorize paste via low-conf fallback or sticky idle hook.
 * 2. Sticky working: OSC hook working must clear on null; drain unblocks.
 * 3. Happy path: working → high-conf idle → drive drains queued prompt.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FALLBACK_IDLE,
  SeatStateMachine,
  SeatStateRuntime,
  SEAT_DEBOUNCE,
  applyOscHookFromSnapshot,
  evaluate,
  hookStateFromSnapshot,
} from "../src/main/vellum-command/term/agent-state";
import { ManagedTerminalDrive } from "../src/main/vellum-command/term/drive";
import type { ObserverGridSnapshot } from "../src/main/vellum-command/term/observer/types";

const HR = "────────────────";

const snap = (
  partial: Partial<ObserverGridSnapshot> & {
    lines?: readonly string[];
    title?: string;
    osc9?: string;
    bindingId?: string;
  } = {},
): ObserverGridSnapshot => {
  const lines = partial.lines ?? [];
  return {
    cols: partial.cols ?? 80,
    rows: partial.rows ?? 24,
    lines,
    text: partial.text ?? lines.join("\n"),
    signals: partial.signals ?? {
      title: partial.title ?? "",
      osc9: partial.osc9 ?? "",
      modes: {
        bracketedPaste: true,
        synchronizedOutput: false,
        altScreen: false,
        mouseModes: [],
      },
    },
    seq: partial.seq ?? 1n,
    epoch: partial.epoch ?? "e1",
    bindingId: partial.bindingId ?? "b1",
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("replay - sticky hooks clear", () => {
  it("null OSC feed clears prior working hook (not sticky forever)", () => {
    const m = new SeatStateMachine({ now: () => 1_000 });
    m.bind("b1", { harness: "claude", epoch: "e1" });

    const working = applyOscHookFromSnapshot(
      m,
      snap({ title: "⣿ work", osc9: "4;3" }),
      1_000,
    );
    expect(working?.state).toBe("working");
    expect(m.getSlot("b1")).toBeDefined();

    // Quiet screen: hookStateFromSnapshot returns null → must clear slot hook.
    const cleared = applyOscHookFromSnapshot(
      m,
      snap({ title: "✳ Claude", osc9: "", lines: ["noise only"] }),
      1_100,
    );
    expect(cleared).toBeNull();
    // Feed with explicit null hook — must not retain working from sticky slot.
    const ev = m.feed(
      snap({ title: "✳ Claude", lines: [HR, "❯ ready", HR] }),
      { harness: "claude", hookState: null },
    );
    expect(ev?.state).toBe("idle");
    expect(ev?.confidence).toBe("high");
  });

  it("explicit osc9 idle clears working hook for claude", () => {
    expect(
      hookStateFromSnapshot(
        snap({ osc9: "4;3", title: "⣿" }),
        "claude",
        1,
      )?.state,
    ).toBe("working");
    expect(
      hookStateFromSnapshot(
        snap({ osc9: "4;0", title: "✳" }),
        "claude",
        2,
      ),
    ).toMatchObject({ state: "idle", reason: "osc9_idle" });
  });
});

describe("replay - no typeable low-conf idle", () => {
  it("bare fallback idle is not injectable via isSeatIdle", () => {
    const rt = new SeatStateRuntime({ now: () => 2_000 });
    rt.bindHarness("b1", "claude", "e1");
    const r = evaluate(snap({ title: "", lines: ["hello world"] }), {
      harness: "claude",
    });
    expect(r.reason).toBe(FALLBACK_IDLE);
    expect(r.confidence).toBe("low");
    // Force publish low-conf idle as published state (post-debounce shape).
    rt.machine.force("b1", "idle", FALLBACK_IDLE, "low");
    // force sets visibleIdle=true for idle lifecycle — override via feed path:
    // use real low-conf path through debounce from working.
    rt.stop();

    const rt2 = new SeatStateRuntime({ now: () => 3_000 });
    rt2.bindHarness("b1", "claude", "e1");
    rt2.machine.feed(snap({ title: "⣿ work" }), { harness: "claude" });
    // Three low-conf idle confirms → published idle with fallback reason.
    for (let i = 0; i < SEAT_DEBOUNCE.pendingIdleConfirmations; i++) {
      rt2.machine.feed(snap({ title: "", lines: ["log line"] }), {
        harness: "claude",
      });
    }
    expect(rt2.getState("b1")).toBe("idle");
    expect(rt2.machine.getSlot("b1")?.reason).toContain(FALLBACK_IDLE);
    expect(rt2.machine.getSlot("b1")?.confidence).toBe("low");
    expect(rt2.isSeatIdle("b1")).toBe(false);
    rt2.stop();
  });

  it("Claude permission chrome is never injectable idle", () => {
    for (const fixture of [
      {
        name: "bash proceed",
        lines: [
          "Do you want to proceed?",
          "bash command",
          "  1. Yes",
          "  2. No",
          "Esc to cancel",
        ],
      },
      {
        name: "live form",
        lines: [
          HR,
          "Allow edit?",
          "Enter to select - Esc to cancel - Tab/Arrow keys to navigate",
        ],
      },
    ] as const) {
      const r = evaluate(snap({ lines: [...fixture.lines], title: "" }), {
        harness: "claude",
      });
      expect(r.state, fixture.name).toBe("attention");
      expect(r.state, fixture.name).not.toBe("idle");
    }
  });

  it("Grok option / permission chrome is never injectable idle", () => {
    for (const fixture of [
      {
        name: "option gutter",
        lines: ["┃  2 (○) Yes, proceed", "┃  z (○) Type your answer here"],
      },
      {
        name: "permission hints",
        lines: ["footer", ":select  ctrl+o:yolo  ctrl+c:cancel"],
      },
    ] as const) {
      const r = evaluate(snap({ lines: [...fixture.lines], title: "" }), {
        harness: "grok",
      });
      expect(r.state, fixture.name).toBe("attention");
      expect(r.state, fixture.name).not.toBe("idle");
    }
  });

  it("unmatched noise for claude/grok is low-conf idle, not typeable", () => {
    for (const harness of ["claude", "grok"] as const) {
      const r = evaluate(
        snap({ title: "", lines: ["??? unknown chrome ???"] }),
        { harness },
      );
      expect(r.state).toBe("idle");
      expect(r.reason).toBe(FALLBACK_IDLE);
      expect(r.confidence).toBe("low");
      const rt = new SeatStateRuntime({ now: () => 5_000 });
      rt.bindHarness("b1", harness, "e1");
      // Publish via force high then replace reason isn't enough — feed until
      // published idle from debounce after working.
      rt.machine.feed(
        snap({
          title: harness === "claude" ? "⣿ w" : "",
          osc9: harness === "grok" ? "4;1;-1" : "",
          lines: harness === "grok" ? ["  ⠧ wait [stop]"] : ["thinking"],
        }),
        { harness },
      );
      for (let i = 0; i < SEAT_DEBOUNCE.pendingIdleConfirmations; i++) {
        rt.machine.feed(
          snap({ title: "", lines: ["??? unknown chrome ???"] }),
          { harness },
        );
      }
      expect(rt.getState("b1")).toBe("idle");
      expect(rt.isSeatIdle("b1")).toBe(false);
      rt.stop();
    }
  });
});

describe("replay - paste re-check", () => {
  it("refuses paste when idle flips false immediately before write", async () => {
    const writes: string[] = [];
    const attention: string[] = [];
    let idle = true;
    const drive = new ManagedTerminalDrive({
      pasteToCrSettleMs: 0,
      write: (_id, data) => {
        writes.push(data);
        return true;
      },
      isSeatIdle: () => idle,
      onAttention: (_id, reason) => attention.push(reason),
      stallWatch: false,
    });

    // Flip busy during the outer gate → execute path: simulate by making
    // isSeatIdle false only after queue empty path enters executePrompt.
    idle = true;
    let checks = 0;
    const drive2 = new ManagedTerminalDrive({
      pasteToCrSettleMs: 0,
      write: (_id, data) => {
        writes.push(data);
        return true;
      },
      isSeatIdle: () => {
        checks += 1;
        // First outer writePrompt gate(s) see idle; executePrompt re-check fails.
        return checks <= 1;
      },
      onAttention: (_id, reason) => attention.push(reason),
      stallWatch: false,
    });

    const ok = await drive2.writePrompt("b1", "should not paste");
    expect(ok).toBe(false);
    expect(writes).toEqual([]);
    expect(attention).toContain("not-ready");
    drive.resetForTest();
    drive2.resetForTest();
  });
});

describe("replay - sticky working clearance", () => {
  it("sticky OSC working + clear → high-conf idle unblocks drain", async () => {
    const writes: string[] = [];
    let seatIdle = false;
    const drive = new ManagedTerminalDrive({
      pasteToCrSettleMs: 0,
      write: (_id, data) => {
        writes.push(data);
        return true;
      },
      isSeatIdle: () => seatIdle,
      stallWatch: false,
      queueTimeoutMs: 60_000,
    });

    const queued = drive.writePrompt("b1", "after sticky");
    expect(drive.queuedCount("b1")).toBe(1);
    expect(writes).toEqual([]);

    // Machine path: working hook, then null clear, then visible idle.
    const m = new SeatStateMachine({ now: () => 10_000 });
    m.bind("b1", { harness: "claude", epoch: "e1" });
    applyOscHookFromSnapshot(m, snap({ osc9: "4;3", title: "⣿" }), 10_000);
    m.feed(snap({ osc9: "4;3", title: "⣿", lines: ["thinking"] }), {
      harness: "claude",
      hookState: hookStateFromSnapshot(
        snap({ osc9: "4;3", title: "⣿" }),
        "claude",
        10_000,
      ),
    });
    expect(m.getState("b1")).toBe("working");

    // Clear hook + high-conf prompt box idle.
    const idleEv = m.feed(
      snap({
        osc9: "4;0",
        title: "✳ Claude",
        lines: [HR, "❯ ready", HR],
      }),
      {
        harness: "claude",
        hookState: hookStateFromSnapshot(
          snap({ osc9: "4;0", title: "✳ Claude" }),
          "claude",
          10_100,
        ),
      },
    );
    expect(idleEv?.state).toBe("idle");
    expect(idleEv?.confidence).toBe("high");

    seatIdle = true;
    drive.onSeatIdle("b1");
    await expect(queued).resolves.toBe(true);
    expect(writes.length).toBeGreaterThanOrEqual(2);
    drive.resetForTest();
  });

  it("stuck working leaves via attention path (permission)", () => {
    const m = new SeatStateMachine({ now: () => 20_000 });
    m.bind("b1", { harness: "claude", epoch: "e1" });
    m.feed(snap({ title: "⣿ work" }), { harness: "claude" });
    expect(m.getState("b1")).toBe("working");

    const att = m.feed(
      snap({
        title: "⣿ work",
        lines: [
          "Do you want to proceed?",
          "bash command",
          "  1. Yes",
          "  2. No",
          "Esc to cancel",
        ],
      }),
      { harness: "claude" },
    );
    expect(att?.state).toBe("attention");
    // Queue no longer blocked on permanent working — attention is a clearance.
    expect(m.getState("b1")).not.toBe("working");
  });
});

describe("replay - happy-path working→idle drain", () => {
  it("working → visible idle drains one queued prompt", async () => {
    const writes: Array<{ data: string }> = [];
    let idle = false;
    const drive = new ManagedTerminalDrive({
      pasteToCrSettleMs: 0,
      write: (_id, data) => {
        writes.push({ data });
        return true;
      },
      isSeatIdle: () => idle,
      stallWatch: false,
    });

    const p = drive.writePrompt("b1", "factory work");
    expect(drive.queuedCount("b1")).toBe(1);

    const m = new SeatStateMachine({ now: () => 30_000 });
    m.bind("b1", { harness: "grok", epoch: "e1" });
    m.feed(
      snap({
        osc9: "4;1;-1",
        lines: ["  ⠧ Waiting… [stop]"],
      }),
      { harness: "grok" },
    );
    expect(m.getState("b1")).toBe("working");

    const idleEv = m.feed(
      snap({
        title: "User requests exact OK - grok",
        osc9: "",
        lines: ["ready"],
      }),
      { harness: "grok" },
    );
    expect(idleEv?.state).toBe("idle");
    expect(idleEv?.confidence).toBe("high");

    idle = true;
    drive.onSeatIdle("b1");
    await expect(p).resolves.toBe(true);
    expect(writes.length).toBe(2);
    drive.resetForTest();
  });
});
