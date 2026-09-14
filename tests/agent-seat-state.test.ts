import { afterEach, describe, expect, it, vi } from "vitest";
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
} from "../src/main/vellum-command/term/agent-state";
import type { ObserverGridSnapshot } from "../src/main/vellum-command/term/observer/types";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import type { SeatMatcher } from "../src/main/vellum-command/term/agent-state/types";
import { HARNESS_IDS } from "../src/shared/managed-terminal-templates";

afterEach(() => {
  vi.useRealTimers();
});

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
      modes: {
        bracketedPaste: false,
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

  it("every pack regex compiles under the production /u flag", () => {
    const sources: string[] = [];
    const walk = (m: SeatMatcher): void => {
      for (const source of m.regex ?? []) sources.push(source);
      for (const source of m.lineRegex ?? []) sources.push(source);
      for (const child of [...(m.all ?? []), ...(m.any ?? []), ...(m.not ?? [])]) {
        walk(child);
      }
    };
    for (const id of HARNESS_IDS) {
      const pack = rulePackFor(id);
      for (const rule of pack.rules) walk(rule.matchers);
      for (const probe of pack.composer ?? []) walk(probe.matchers);
    }
    const invalid: string[] = [];
    for (const source of sources) {
      try {
        void new RegExp(source, "u");
      } catch {
        invalid.push(source);
      }
    }
    expect(invalid).toEqual([]);
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
    expect(r.reason).toMatch(/rule:(live_prompt_box|composer_draft_idle)/);
    expect(r.visibleIdle).toBe(true);
    expect(r.confidence).toBe("high");
  });

  it("paste chip outranks OSC working title (no false running dots)", () => {
    const r = evaluate(
      snap({
        title: "⠋ Claude",
        lines: [HR, "> [Pasted text #1 +5 lines]", HR, "vellum git:(main)"],
      }),
      { harness: "claude" },
    );
    expect(r.state).toBe("idle");
    expect(r.visibleIdle).toBe(true);
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
          "Enter to select - Esc to cancel - Tab/Arrow keys to navigate",
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
        lines: ["• Working (esc to interrupt) - 12s"],
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
        lines: ["  ⠧ compiling   4.3s ⇣22.3k [stop]"],
      }),
      { harness: "grok" },
    );
    expect(r.state).toBe("working");
    expect(r.reason).toBe("rule:spinner_status_working");
  });

  it("Responding / Waiting footer without braille beats idle title grok", () => {
    const responding = evaluate(
      snap({
        title: "grok",
        lines: [
          "earlier transcript",
          "  Responding… 1.2s",
        ],
      }),
      { harness: "grok" },
    );
    expect(responding.state).toBe("working");
    expect(responding.reason).toBe("rule:grid_thinking_working");

    const waiting = evaluate(
      snap({
        title: "grok",
        lines: ["  Waiting for response... 0.4s"],
      }),
      { harness: "grok" },
    );
    expect(waiting.state).toBe("working");
    expect(waiting.reason).toBe("rule:grid_thinking_working");
  });

  it("historical Responding in scrollback does not stick working", () => {
    const r = evaluate(
      snap({
        title: "grok",
        lines: [
          "  Responding… 4.3s",
          "here is the answer",
          "❯ ",
          "Grok 4.5 (low) — 47K / 500K",
        ],
      }),
      { harness: "grok" },
    );
    expect(r.state).toBe("idle");
    expect(r.reason).toBe("rule:osc_title_idle");
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
          "Allow once - Allow for this session - Deny",
          "Enter to confirm - ↑/↓ to select",
        ],
      }),
      { harness: "hermes" },
    );
    expect(r.state).toBe("attention");
  });

  it("ready footer → idle via ready_footer_idle (not fallback)", () => {
    const r = evaluate(
      snap({
        lines: [
          "─ ready │ gpt 5.4 mini │ 17.7k/272k │ voice off ─ ~/Projects",
          " ❯",
        ],
      }),
      { harness: "hermes" },
    );
    expect(r.state).toBe("idle");
    expect(r.ruleId).toBe("ready_footer_idle");
    expect(r.visibleIdle).toBe(true);
    expect(r.confidence).toBe("high");
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
      "unknown",
      "idle",
      "working",
      "attention",
      "idle",
    ]);
  });

  it("projects the current published state for renderer hydration", () => {
    let t = 1_000;
    const m = new SeatStateMachine({ now: () => t });
    m.bind("b2", { harness: "codex", epoch: "e2" });
    t += 10;
    m.force("b2", "working", "rule:osc_title_working");
    t += 10;
    m.bind("b1", { harness: "claude", epoch: "e1" });
    m.setHookState("hook-only", {
      state: "working",
      reason: "early_hook",
      at: t,
    });

    expect(m.currentEvents()).toEqual([
      {
        bindingId: "b1",
        epoch: "e1",
        state: "unknown",
        reason: "generation_bound",
        confidence: "low",
        at: 1_020,
        harness: "claude",
      },
      {
        bindingId: "b2",
        epoch: "e2",
        state: "working",
        reason: "rule:osc_title_working",
        confidence: "high",
        at: 1_010,
        harness: "codex",
      },
    ]);

    m.unbind("b2", { epoch: "e2" });
    expect(m.currentEvents().map((event) => event.bindingId)).toEqual(["b1"]);
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

  it("releases the 700ms cap without requiring another PTY snapshot", async () => {
    vi.useFakeTimers();
    const events: AgentSeatStateEvent[] = [];
    const m = new SeatStateMachine({ onEvent: (event) => events.push(event) });
    m.bind("b1", { harness: "claude", epoch: "e1" });

    expect(
      m.feed(snap({ title: "⣿ work" }), { harness: "claude" })?.state,
    ).toBe("working");
    expect(
      m.feed(snap({ title: "", lines: ["quiet"] }), {
        harness: "claude",
      }),
    ).toBeNull();
    expect(m.getState("b1")).toBe("working");

    await vi.advanceTimersByTimeAsync(SEAT_DEBOUNCE.pendingIdleCapMs);

    expect(m.getState("b1")).toBe("idle");
    expect(events.at(-1)).toMatchObject({
      bindingId: "b1",
      epoch: "e1",
      state: "idle",
    });
    expect(events.at(-1)?.reason).toContain("debounced_idle");
    m.dispose();
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

  it("publishes replacement and epoch-gated gone lifecycle events", () => {
    const events: AgentSeatStateEvent[] = [];
    const m = new SeatStateMachine({
      now: () => 1_000,
      onEvent: (event) => events.push(event),
    });
    m.bind("b1", { harness: "grok", epoch: "e1" });
    m.force("b1", "attention", "permission");

    m.bind("b1", { harness: "grok", epoch: "e2" });
    expect(events.at(-1)).toMatchObject({
      epoch: "e2",
      state: "unknown",
      reason: "generation_replaced",
    });

    expect(
      m.unbind("b1", { epoch: "e1", reason: "late_old_exit" }),
    ).toBeNull();
    expect(m.getSlot("b1")?.epoch).toBe("e2");

    expect(
      m.unbind("b1", { epoch: "e2", reason: "generation_exited" }),
    ).toMatchObject({
      epoch: "e2",
      state: "gone",
      reason: "generation_exited",
    });
    expect(m.getState("b1")).toBeUndefined();
  });

  it("does not carry hook evidence into a replacement generation", () => {
    const m = new SeatStateMachine({ now: () => 1_000 });
    m.bind("b1", { harness: "claude", epoch: "e1" });
    m.setHookState("b1", {
      state: "working",
      reason: "old_hook",
      at: 1_000,
      fullLifecycle: true,
    });
    expect(
      m.feed(snap({ epoch: "e1", title: "⣿ work" }), {
        harness: "claude",
      })?.state,
    ).toBe("working");

    m.bind("b1", { harness: "claude", epoch: "e2" });
    expect(
      m.feed(
        snap({
          epoch: "e2",
          title: "✳ Claude",
          lines: [HR, "❯ ready", HR],
        }),
        { harness: "claude" },
      )?.state,
    ).toBe("idle");
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

describe("evaluate — kimi / pi / prime-agent scrollback hygiene", () => {
  it("kimi: historical moon spinner does not pin working over prompt footer", () => {
    const result = evaluate(
      snap({
        lines: [
          "🌕",
          "old tool output with moon above",
          "line a",
          "line b",
          "line c",
          "line d",
          "line e",
          "line f",
          "line g",
          "line h",
          "> ",
          "context: 6% (58k/1M)",
        ],
        title: "Kimi Code",
      }),
      { harness: "kimi" },
    );
    expect(result.state).toBe("idle");
    expect(result.ruleId).toBe("prompt_footer_idle");
  });

  it("kimi: live braille spinner in status strip is still working", () => {
    const result = evaluate(
      snap({
        lines: [
          "previous turn text",
          "  ⠋ Thinking...",
          "context: 6% (58k/1M)",
        ],
        title: "Kimi Code",
      }),
      { harness: "kimi" },
    );
    expect(result.state).toBe("working");
    expect(result.ruleId).toBe("braille_spinner_working");
  });

  it("prime-agent: historical diamond markers do not pin working when OSC title is idle", () => {
    const result = evaluate(
      snap({
        lines: [
          "◇ old tool call",
          "◈ more history",
          "ready for input",
        ],
        title: "prime-agent - session - vellum",
        osc9: "4;0",
      }),
      { harness: "prime-agent" },
    );
    expect(result.state).toBe("idle");
  });

  it("pi: footer chrome without Working... is idle even with Thinking block above", () => {
    const result = evaluate(
      snap({
        lines: [
          "Thinking...",
          "some reasoning text in scrollback",
          "  12% \u00b7 7.7k \u00b7 sonnet",
        ],
        title: "π - main - vellum",
      }),
      { harness: "pi" },
    );
    expect(result.state).toBe("idle");
  });

  it("cursor: approval form is attention", () => {
    const result = evaluate(
      snap({
        lines: [
          "Run this command?",
          "ls -la",
          "Run (once) (y)",
          "Skip (esc or n)",
        ],
        title: "Cursor Agent",
      }),
      { harness: "cursor" },
    );
    expect(result.state).toBe("attention");
    expect(result.visibleAttention).toBe(true);
  });

  it("cursor: ctrl+c to stop is working", () => {
    const result = evaluate(
      snap({
        lines: ["generating a patch", "ctrl+c to stop"],
        title: "Cursor Agent",
      }),
      { harness: "cursor" },
    );
    expect(result.state).toBe("working");
    expect(result.ruleId).toBe("stop_hint_working");
  });

  it("cursor: welcome placeholder is idle", () => {
    const result = evaluate(
      snap({
        lines: ["Plan, search, build anything"],
        title: "Cursor Agent",
      }),
      { harness: "cursor" },
    );
    expect(result.state).toBe("idle");
    expect(result.ruleId).toBe("welcome_idle");
  });

  // Frames below are transcribed from a real `amp --no-ide threads continue`
  // PTY capture (0.0.1787664850).
  it("amp: connecting startup holds prior state instead of reading idle", () => {
    const result = evaluate(
      snap({
        lines: [
          "\u256d\u2500\u2500 $\u00b7\u00b7\u00b7\u00b7 \u2500 high \u2500\u256e",
          "\u2502                                              \u2502",
          "\u2570 ~ Connecting \u2500\u2500 ~/Projects/vellum (main) \u2500\u256f",
        ],
        title: "",
      }),
      { harness: "amp" },
    );
    expect(result.skipStateUpdate).toBe(true);
    expect(result.ruleId).toBe("connecting_unknown");
  });

  it("amp: resume replay is not a writeable seat either", () => {
    const result = evaluate(
      snap({
        lines: ["\u2570 ~ Catching Up \u2500\u2500 ~/Projects/vellum (main) \u2500\u256f"],
        title: "",
      }),
      { harness: "amp" },
    );
    expect(result.skipStateUpdate).toBe(true);
  });

  it("amp: braille title is working", () => {
    const result = evaluate(
      snap({
        lines: ["\u2570 ~ Streaming \u2500\u2500 ~/Projects/vellum (main) \u2500\u256f"],
        title: "\u28f6 amp - ~/Projects/vellum",
      }),
      { harness: "amp" },
    );
    expect(result.state).toBe("working");
    expect(result.ruleId).toBe("osc_title_working");
    expect(result.visibleWorking).toBe(true);
  });

  it("amp: a settled turn titles <thread> - amp - <cwd> and is idle", () => {
    const result = evaluate(
      snap({
        lines: [
          " \u2503 Reply with the single word READY and nothing else.",
          " READY",
          "\u2570\u2500\u2500 ~/Projects/vellum (main) \u2500\u256f",
        ],
        title: "Ready response - amp - ~/Projects/vellum",
      }),
      { harness: "amp" },
    );
    expect(result.state).toBe("idle");
    expect(result.ruleId).toBe("osc_title_idle");
    expect(result.visibleIdle).toBe(true);
  });

  it("amp: waiting for approval is attention, never idle", () => {
    const result = evaluate(
      snap({
        lines: ["\u2570 Waiting for Approval \u2500\u2500 ~/Projects/vellum \u2500\u256f"],
        title: "Some thread - amp - ~/Projects/vellum",
      }),
      { harness: "amp" },
    );
    expect(result.state).toBe("attention");
    expect(result.visibleAttention).toBe(true);
  });

  it("amp: the Ctrl+C menu is attention, a second Ctrl+C archives the thread", () => {
    const result = evaluate(
      snap({
        lines: [
          "\u256d\u2500 Ctrl+C then \u2500\u256e",
          "\u2502 Ctrl+N Archive and new thread \u2502",
          "\u2502 Ctrl+E Archive and quit       \u2502",
          "\u2502 Ctrl+C Quit                   \u2502",
          "\u2502           Esc cancel          \u2502",
        ],
        title: "Ready response - amp - ~/Projects/vellum",
      }),
      { harness: "amp" },
    );
    expect(result.state).toBe("attention");
    expect(result.ruleId).toBe("interrupt_menu_attention");
  });

  // Transcribed from a live `grok` seat waiting on a swarm it spawned. The
  // OSC title had already reverted to the idle shape, so the seat published
  // idle via osc_title_idle while the subagent was still running.
  it("grok: waiting on a subagent outranks the idle OSC title", () => {
    const result = evaluate(
      snap({
        lines: [
          "▶ Fan out read-only swarm across UI, main, SSH/Tailscale, CC enro…",
          "□ Ground swarm claims at source and report dormant vs still-live …",
          "◎ 1 subagent still running \u00B7 send a message to interrupt",
          "❯",
          "Grok 4.6 (high) \u00B7 163K / 500K (33%) \u00B7 ctrl+o transcript",
        ],
        title: "vellum - grok",
      }),
      { harness: "grok" },
    );
    expect(result.state).toBe("working");
    expect(result.ruleId).toBe("background_wait_working");
    expect(result.visibleWorking).toBe(true);
  });

  it("grok: its own narration about waiting never pins working", () => {
    const result = evaluate(
      snap({
        lines: [
          "┃One agent still running - CLI/preload DCE. Let me wait for it.",
          "❯",
          "Grok 4.6 (high) \u00B7 163K / 500K (33%) \u00B7 ctrl+o transcript",
        ],
        title: "vellum - grok",
      }),
      { harness: "grok" },
    );
    expect(result.state).toBe("idle");
  });

  it("grok: the same seat with the wait line gone is idle again", () => {
    const result = evaluate(
      snap({
        lines: [
          "    Worked for 4m12s",
          "❯",
          "Grok 4.6 (high) \u00B7 163K / 500K (33%) \u00B7 ctrl+o transcript",
        ],
        title: "vellum - grok",
      }),
      { harness: "grok" },
    );
    expect(result.state).toBe("idle");
    expect(result.ruleId).toBe("osc_title_idle");
  });

  // Lines below are transcribed from a live `agy` seat screen captured over
  // the term control plane while a subagent turn was running.
  it("agy: activity line with elapsed timer is working", () => {
    const result = evaluate(
      snap({
        lines: [
          HR,
          ">",
          HR,
          "  ● Agent(self)  Read TerminalSurface session load logic \u00B7 4m30s",
          HR,
          "? for shortcuts                    Gemini 3.7 Flash \u00B7 high",
        ],
      }),
      { harness: "agy" },
    );
    expect(result.state).toBe("working");
    expect(result.ruleId).toBe("activity_line_working");
    expect(result.visibleWorking).toBe(true);
  });

  it("agy: footer subagent counter is working", () => {
    const result = evaluate(
      snap({
        lines: [
          HR,
          ">",
          HR,
          "? for shortcuts                    Gemini 3.7 Flash \u00B7 high \u00B7 1 subagent(s)",
        ],
      }),
      { harness: "agy" },
    );
    expect(result.state).toBe("working");
    expect(result.ruleId).toBe("subagents_working");
  });

  it("agy: braille spinner below prior output is working", () => {
    // Constructed from the declared spinner + prompt idioms (adapter probe:
    // agy-spinner-below-prior-output). The spinner rule must see a line
    // anywhere in whole_recent — a `^`-anchored `regex` matcher tests the
    // joined blob where `^` only sees the first row, so a spinner under
    // prior output silently read idle.
    const result = evaluate(
      snap({
        lines: ["Earlier response", "⠋ Thinking", HR, "❯", HR],
      }),
      { harness: "agy" },
    );
    expect(result.state).toBe("working");
    expect(result.ruleId).toBe("spinner_working");
    expect(result.visibleWorking).toBe(true);
  });

  it("agy: empty composer is visible idle (factory mail nudge gate)", () => {
    const result = evaluate(
      snap({
        lines: [
          "  • Status: Idle — standing by for task edges or work assignments.",
          HR,
          ">",
          HR,
          "? for shortcuts                    Gemini 3.7 Flash \u00B7 high",
        ],
      }),
      { harness: "agy" },
    );
    expect(result.state).toBe("idle");
    expect(result.ruleId).toBe("empty_prompt_idle");
    expect(result.visibleIdle).toBe(true);
  });

  it("agy: composer draft is visible idle", () => {
    const result = evaluate(
      snap({
        lines: [
          HR,
          "> vellum-command msg list",
          HR,
          "? for shortcuts                    Gemini 3.7 Flash \u00B7 high",
        ],
      }),
      { harness: "agy" },
    );
    expect(result.state).toBe("idle");
    expect(result.ruleId).toBe("composer_draft_idle");
    expect(result.visibleIdle).toBe(true);
  });

  it("agy: subagent counter still outranks empty composer idle", () => {
    const result = evaluate(
      snap({
        lines: [
          HR,
          ">",
          HR,
          "? for shortcuts                    Gemini 3.7 Flash \u00B7 high \u00B7 2 subagent(s)",
        ],
      }),
      { harness: "agy" },
    );
    expect(result.state).toBe("working");
    expect(result.ruleId).toBe("subagents_working");
  });

  it("agy: permission prompt still outranks composer idle", () => {
    const result = evaluate(
      snap({
        lines: [
          "  agy is requesting permission for: bash",
          "  do you want to proceed?",
          HR,
          ">",
          HR,
          "? for shortcuts                    Gemini 3.7 Flash \u00B7 high",
        ],
      }),
      { harness: "agy" },
    );
    expect(result.state).toBe("attention");
    expect(result.visibleAttention).toBe(true);
  });

  it("agy: 1.1.28+ Run this command? is attention without the old proceed line", () => {
    const result = evaluate(
      snap({
        lines: [
          "  Run this command?",
          "  ls -la",
          "  Reason: hook flagged this action",
          HR,
          ">",
          HR,
          "? for shortcuts                    Gemini 3.7 Flash \u00B7 high",
        ],
      }),
      { harness: "agy" },
    );
    expect(result.state).toBe("attention");
    expect(result.visibleAttention).toBe(true);
  });

  it("agy: 1.1.28+ Allow access to this URL? is attention", () => {
    const result = evaluate(
      snap({
        lines: [
          "  Allow access to this URL?",
          "  https://example.com",
          HR,
          ">",
          HR,
          "? for shortcuts                    Gemini 3.7 Flash \u00B7 high",
        ],
      }),
      { harness: "agy" },
    );
    expect(result.state).toBe("attention");
    expect(result.visibleAttention).toBe(true);
  });

  it("agy: 1.1.28+ Allow calling this tool? is attention", () => {
    const result = evaluate(
      snap({
        lines: [
          "  Allow calling this tool?",
          "  mcp__search",
          HR,
          ">",
          HR,
          "? for shortcuts                    Gemini 3.7 Flash \u00B7 high",
        ],
      }),
      { harness: "agy" },
    );
    expect(result.state).toBe("attention");
    expect(result.visibleAttention).toBe(true);
  });

  it("agy: idle footer without activity line or subagents is not working", () => {
    const result = evaluate(
      snap({
        lines: [
          "  • Status: Idle — standing by for task edges or work assignments.",
          HR,
          ">",
          HR,
          "? for shortcuts                    Gemini 3.7 Flash \u00B7 high",
        ],
      }),
      { harness: "agy" },
    );
    expect(result.state).not.toBe("working");
  });
});
