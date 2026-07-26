import { describe, expect, it } from "vitest";
import {
  FALLBACK_IDLE,
  SeatStateMachine,
  SEAT_DEBOUNCE,
  evaluate,
  ruleMatches,
  claudeRules,
  codexRules,
  grokRules,
  hermesRules,
  rulePackFor,
} from "../src/main/vellum/term/agent-state";
import type { ObserverGridSnapshot } from "../src/main/vellum/term/observer/types";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";

const snap = (
  partial: Partial<ObserverGridSnapshot> & {
    lines?: readonly string[];
    title?: string;
    osc9?: string;
  },
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
      modes: { bracketedPaste: false, synchronizedOutput: false },
    },
    seq: partial.seq ?? 1n,
    epoch: partial.epoch ?? "e1",
    bindingId: partial.bindingId ?? "b1",
  };
};

const HR = "────────────────";

describe("rule packs", () => {
  it("ships four harness packs", () => {
    expect(rulePackFor("claude").harness).toBe("claude");
    expect(rulePackFor("codex").harness).toBe("codex");
    expect(rulePackFor("grok").harness).toBe("grok");
    expect(rulePackFor("hermes").harness).toBe("hermes");
    expect(claudeRules.rules.length).toBeGreaterThan(5);
    expect(codexRules.rules.length).toBeGreaterThan(3);
    expect(grokRules.rules.length).toBeGreaterThan(5);
    expect(hermesRules.rules.length).toBeGreaterThan(2);
  });
});

describe("evaluate — claude", () => {
  it("braille title → working", () => {
    // U+28FF is a braille pattern.
    const r = evaluate(snap({ title: "⣿ working on task" }), {
      harness: "claude",
    });
    expect(r.state).toBe("working");
    expect(r.reason).toBe("rule:osc_title_working");
    expect(r.visibleWorking).toBe(true);
  });

  it("prompt box with ❯ → idle (visible)", () => {
    const r = evaluate(
      snap({
        lines: [HR, "❯ help me ship", HR, "footer"],
        title: "✳ Claude",
      }),
      { harness: "claude" },
    );
    expect(r.state).toBe("idle");
    expect(r.reason).toBe("rule:live_prompt_box");
    expect(r.visibleIdle).toBe(true);
    expect(r.confidence).toBe("high");
  });

  it("permission form → attention, never idle", () => {
    const r = evaluate(
      snap({
        lines: [
          "Bash(rm -rf /tmp/x)",
          HR,
          "Do you want to proceed?",
          "❯ 1. Yes",
          "  2. No",
          "Esc to cancel",
        ],
      }),
      { harness: "claude" },
    );
    expect(r.state).toBe("attention");
    expect(r.visibleAttention).toBe(true);
    expect(r.state).not.toBe("idle");
  });

  it("live permission form with navigate hints", () => {
    const r = evaluate(
      snap({
        lines: [
          HR,
          "Allow edit?",
          "Enter to select · Esc to cancel · Tab/Arrow keys to navigate",
        ],
      }),
      { harness: "claude" },
    );
    expect(r.state).toBe("attention");
    expect(r.reason).toBe("rule:live_permission_form");
  });

  it("OSC 9;4;3 alone is NOT working (stuck while permission)", () => {
    // Only 4;0 is idle; 4;3 must not force working over permission chrome.
    const permission = evaluate(
      snap({
        osc9: "4;3",
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
    expect(permission.state).toBe("attention");
  });

  it("transcript viewer skip_state_update", () => {
    const r = evaluate(
      snap({
        lines: [
          "showing detailed transcript",
          "ctrl+o to toggle",
          "? for shortcuts",
        ],
      }),
      { harness: "claude" },
    );
    expect(r.skipStateUpdate).toBe(true);
  });
});

describe("evaluate — codex", () => {
  it("Action Required title → attention", () => {
    const r = evaluate(snap({ title: "[ ! ] Action Required | p13" }), {
      harness: "codex",
    });
    expect(r.state).toBe("attention");
    expect(r.reason).toBe("rule:osc_title_attention");
  });

  it("spinner in title → working", () => {
    const r = evaluate(snap({ title: "⠋ codex-project" }), {
      harness: "codex",
    });
    expect(r.state).toBe("working");
    expect(r.reason).toBe("rule:osc_title_working");
  });

  it("braille title → working", () => {
    const r = evaluate(snap({ title: "⣿ myproj" }), { harness: "codex" });
    expect(r.state).toBe("working");
  });

  it("plain cwd title → idle", () => {
    const r = evaluate(snap({ title: "myproj" }), { harness: "codex" });
    expect(r.state).toBe("idle");
    expect(r.visibleIdle).toBe(true);
  });

  it("dir-trust modal (no title) → attention", () => {
    const r = evaluate(
      snap({
        title: "",
        lines: [
          "Do you trust the files in this folder?",
          "Press Enter to confirm or Esc to cancel",
        ],
      }),
      { harness: "codex" },
    );
    expect(r.state).toBe("attention");
  });

  it("screen working fallback", () => {
    const r = evaluate(
      snap({
        title: "",
        lines: ["• Working (esc to interrupt) · 12s"],
      }),
      { harness: "codex" },
    );
    expect(r.state).toBe("working");
    expect(r.reason).toBe("rule:screen_working_fallback");
  });
});

describe("evaluate — grok", () => {
  it("Action Required title → attention", () => {
    const r = evaluate(snap({ title: "⚠ Action Required - grok" }), {
      harness: "grok",
    });
    expect(r.state).toBe("attention");
  });

  it("OSC 9;4;1;-1 → working", () => {
    const r = evaluate(snap({ osc9: "4;1;-1", title: "" }), {
      harness: "grok",
    });
    expect(r.state).toBe("working");
    expect(r.reason).toBe("rule:osc9_working");
  });

  it("idle title grok without braille", () => {
    const r = evaluate(snap({ title: "User requests exact OK - grok" }), {
      harness: "grok",
    });
    expect(r.state).toBe("idle");
    expect(r.reason).toBe("rule:osc_title_idle");
  });

  it("[stop] status line → working (not bare braille)", () => {
    const r = evaluate(
      snap({
        title: "",
        lines: ["  ⠧ Waiting for response… 4.3s   4.3s ⇣22.3k [stop]"],
      }),
      { harness: "grok" },
    );
    expect(r.state).toBe("working");
    expect(r.reason).toBe("rule:spinner_status_working");
  });

  it("option dialog gutter → attention", () => {
    const r = evaluate(
      snap({
        lines: ["┃  2 (○) Yes, proceed", "┃  z (○) Type your answer here"],
      }),
      { harness: "grok" },
    );
    expect(r.state).toBe("attention");
  });
});

describe("evaluate — hermes", () => {
  it("title warning → attention", () => {
    const r = evaluate(snap({ title: "⚠ approval needed" }), {
      harness: "hermes",
    });
    expect(r.state).toBe("attention");
    expect(r.reason).toBe("rule:osc_title_attention");
  });

  it("dangerous command form → attention", () => {
    const r = evaluate(
      snap({
        lines: [
          "Dangerous command detected",
          "Allow once · Allow for this session · Deny",
          "Enter to confirm · ↑/↓ to select",
        ],
      }),
      { harness: "hermes" },
    );
    expect(r.state).toBe("attention");
  });

  it("ready footer → idle", () => {
    const r = evaluate(
      snap({
        lines: [
          "─ ready │ gpt 5.4 mini │ 17.7k/272k │ voice off ─ ~/Projects",
        ],
      }),
      { harness: "hermes" },
    );
    expect(r.state).toBe("idle");
  });
});

describe("evaluate — hooks", () => {
  it("claude full-lifecycle hook wins over low screen", () => {
    const r = evaluate(snap({ title: "", lines: ["noise"] }), {
      harness: "claude",
      hookState: {
        state: "working",
        reason: "pre_tool_use",
        at: 1,
        fullLifecycle: true,
      },
    });
    expect(r.state).toBe("working");
    expect(r.reason).toContain("hook:");
  });

  it("screen attention overrides hook", () => {
    const r = evaluate(
      snap({
        lines: [
          "Do you want to proceed?",
          "bash command",
          "  1. Yes",
          "  2. No",
          "Esc to cancel",
        ],
      }),
      {
        harness: "claude",
        hookState: {
          state: "working",
          reason: "pre_tool_use",
          at: 1,
          fullLifecycle: true,
        },
      },
    );
    expect(r.state).toBe("attention");
  });

  it("codex ignores hooks for state", () => {
    const r = evaluate(snap({ title: "myproj" }), {
      harness: "codex",
      hookState: {
        state: "working",
        reason: "notify",
        at: 1,
        fullLifecycle: true,
      },
    });
    expect(r.state).toBe("idle");
    expect(r.reason).toBe("rule:osc_title_idle");
  });
});

describe("fallback", () => {
  it("known harness with no match → low-confidence idle", () => {
    const r = evaluate(snap({ title: "", lines: ["hello world"] }), {
      harness: "claude",
    });
    expect(r.state).toBe("idle");
    expect(r.reason).toBe(FALLBACK_IDLE);
    expect(r.confidence).toBe("low");
  });

  it("unknown harness → unknown", () => {
    const r = evaluate(snap({}), { harness: "not-a-harness" });
    expect(r.state).toBe("unknown");
  });
});

describe("SeatStateMachine — transitions without flapping", () => {
  it("idle → working → attention → idle (visible)", () => {
    let t = 1_000;
    const events: AgentSeatStateEvent[] = [];
    const m = new SeatStateMachine({
      now: () => t,
      onEvent: (e) => events.push(e),
    });
    m.bind("b1", { harness: "claude", epoch: "e1" });

    // Idle prompt box
    let ev = m.feed(
      snap({
        lines: [HR, "❯ ", HR],
        title: "✳ Claude",
      }),
      { harness: "claude" },
    );
    expect(ev?.state).toBe("idle");

    // Working: braille title
    t += 300;
    ev = m.feed(snap({ title: "⣿ doing work", lines: ["thinking…"] }), {
      harness: "claude",
    });
    expect(ev?.state).toBe("working");

    // Attention: permission
    t += 300;
    ev = m.feed(
      snap({
        title: "⣿ doing work",
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
    expect(ev?.state).toBe("attention");

    // Back to visible idle — immediate, no debounce
    t += 300;
    ev = m.feed(
      snap({
        title: "✳ Claude",
        lines: [HR, "❯ next", HR],
      }),
      { harness: "claude" },
    );
    expect(ev?.state).toBe("idle");
    expect(ev?.confidence).toBe("high");

    expect(events.map((e) => e.state)).toEqual([
      "idle",
      "working",
      "attention",
      "idle",
    ]);
  });

  it("debounces low-confidence working→idle (3 confirmations)", () => {
    let t = 1_000;
    const m = new SeatStateMachine({ now: () => t });
    m.bind("b1", { harness: "claude", epoch: "e1" });

    // Establish working
    expect(
      m.feed(snap({ title: "⣿ work" }), { harness: "claude" })?.state,
    ).toBe("working");

    // Low-confidence idle (empty screen, no visible chrome) — held
    t += 50;
    expect(
      m.feed(snap({ title: "", lines: ["some log"] }), {
        harness: "claude",
      }),
    ).toBeNull();
    expect(m.getState("b1")).toBe("working");

    t += 50;
    expect(
      m.feed(snap({ title: "", lines: ["some log"] }), {
        harness: "claude",
      }),
    ).toBeNull();
    expect(m.getState("b1")).toBe("working");

    // 3rd confirmation → publish idle
    t += 50;
    const released = m.feed(snap({ title: "", lines: ["some log"] }), {
      harness: "claude",
    });
    expect(released?.state).toBe("idle");
    expect(released?.reason).toContain("debounced_idle");
  });

  it("debounces with 700ms cap", () => {
    let t = 1_000;
    const m = new SeatStateMachine({ now: () => t });
    m.bind("b1", { harness: "claude", epoch: "e1" });

    expect(
      m.feed(snap({ title: "⣿ work" }), { harness: "claude" })?.state,
    ).toBe("working");

    t += 10;
    expect(
      m.feed(snap({ title: "", lines: ["x"] }), { harness: "claude" }),
    ).toBeNull();

    // Jump past cap without 3 confirmations
    t += SEAT_DEBOUNCE.pendingIdleCapMs + 1;
    const released = m.feed(snap({ title: "", lines: ["x"] }), {
      harness: "claude",
    });
    expect(released?.state).toBe("idle");
  });

  it("visible idle bypasses debounce", () => {
    let t = 1_000;
    const m = new SeatStateMachine({ now: () => t });
    m.bind("b1", { harness: "claude", epoch: "e1" });

    expect(
      m.feed(snap({ title: "⣿ work" }), { harness: "claude" })?.state,
    ).toBe("working");

    t += 10;
    const ev = m.feed(
      snap({
        title: "✳ Claude",
        lines: [HR, "❯ ready", HR],
      }),
      { harness: "claude" },
    );
    expect(ev?.state).toBe("idle");
    expect(ev?.confidence).toBe("high");
  });

  it("permission prompt never read as idle across feeds", () => {
    let t = 1_000;
    const m = new SeatStateMachine({ now: () => t });
    m.bind("b1", { harness: "claude", epoch: "e1" });

    // Start working
    m.feed(snap({ title: "⣿ work" }), { harness: "claude" });

    const permissionLines = [
      "Do you want to proceed?",
      "bash command",
      "❯ 1. Yes",
      "  2. No",
      "Esc to cancel",
    ];

    for (let i = 0; i < 10; i++) {
      t += 100;
      const ev = m.feed(
        snap({
          // Claude can leave braille title OR clear it during permission —
          // grid attention must win either way.
          title: i % 2 === 0 ? "⣿ work" : "✳ Claude",
          lines: permissionLines,
        }),
        { harness: "claude" },
      );
      if (ev) expect(ev.state).toBe("attention");
      expect(m.getState("b1")).toBe("attention");
      expect(m.getState("b1")).not.toBe("idle");
    }
  });

  it("skip_state_update holds prior state", () => {
    const m = new SeatStateMachine({ now: () => 1000 });
    m.bind("b1", { harness: "claude", epoch: "e1" });
    m.feed(snap({ title: "⣿ work" }), { harness: "claude" });
    expect(m.getState("b1")).toBe("working");

    const held = m.feed(
      snap({
        lines: [
          "showing detailed transcript",
          "ctrl+o to toggle",
          "? for shortcuts",
        ],
      }),
      { harness: "claude" },
    );
    expect(held).toBeNull();
    expect(m.getState("b1")).toBe("working");
  });

  it("codex Action Required publishes attention immediately", () => {
    const m = new SeatStateMachine({ now: () => 1000 });
    m.bind("b1", { harness: "codex", epoch: "e1" });
    m.feed(snap({ title: "myproj" }), { harness: "codex" });
    const ev = m.feed(snap({ title: "Action Required | p13" }), {
      harness: "codex",
    });
    expect(ev?.state).toBe("attention");
  });

  it("force process-exit idle", () => {
    const m = new SeatStateMachine({ now: () => 1000 });
    m.bind("b1", { harness: "hermes", epoch: "e1" });
    m.feed(snap({ title: "⣿" }), { harness: "hermes" });
    const ev = m.force("b1", "idle", "process_exited");
    expect(ev.state).toBe("idle");
    expect(ev.reason).toBe("process_exited");
  });
});

describe("ruleMatches unit", () => {
  it("matches contains case-insensitively", () => {
    const rule = codexRules.rules.find((r) => r.id === "osc_title_attention")!;
    expect(
      ruleMatches(rule, snap({ title: "ACTION REQUIRED now" })),
    ).toBe(true);
    expect(ruleMatches(rule, snap({ title: "idle title" }))).toBe(false);
  });
});
