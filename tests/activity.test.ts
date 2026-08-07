import { describe, expect, it } from "vitest";
import {
  browserActivity,
  chatActivity,
  herdrActivity,
  loadingActivity,
  terminalActivity,
  timerActivity,
  toolActivity,
  watcherActivity,
} from "../src/renderer/lib/activity";

describe("herdrActivity", () => {
  it("maps herdr seen/unseen with RTS severity tones (cyan/amber/crimson/green)", () => {
    // working → cyan (same as chips/minimap); pattern snake
    expect(herdrActivity({ agentStatus: "working" })).toEqual({
      mode: "wave",
      tone: "cyan",
      pattern: "snake",
      label: "working",
    });
    expect(herdrActivity({ agentStatus: "blocked" })).toMatchObject({
      mode: "wave",
      tone: "crimson",
      pattern: "arrow-up",
    });
    // done = Idle+!seen → green pulse until the operator looks (never amber/clockwise)
    expect(herdrActivity({ agentStatus: "done" })).toMatchObject({
      mode: "pulse",
      tone: "green",
      label: "Done — waiting for review",
    });
    // idle = Idle+seen → quiet; never animate the whole fleet
    expect(herdrActivity({ agentStatus: "idle" })).toMatchObject({
      mode: "static",
      tone: "steel",
      label: "idle",
    });
  });

  it("gives each active state a distinct (mode, tone) pair", () => {
    const active = [
      herdrActivity({ agentStatus: "working" }),
      herdrActivity({ agentStatus: "blocked" }),
      herdrActivity({ agentStatus: "done" }),
      herdrActivity({ agentStatus: "idle", connState: "degraded" }),
    ];
    const keys = active.map((s) => `${s.mode}:${s.tone}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("meta loading stays static (fleet-safe) and beats agent idle", () => {
    // First-hydrate loading must not wave — N unbound cards would peg the GPU.
    expect(
      herdrActivity({ agentStatus: "idle", metaStatus: "loading" }),
    ).toMatchObject({
      mode: "static",
      tone: "cyan",
      label: "loading meta",
    });
  });

  it("degraded connection waves steel when agent is idle (seen)", () => {
    expect(
      herdrActivity({ agentStatus: "idle", connState: "degraded" }),
    ).toMatchObject({
      mode: "wave",
      tone: "steel",
    });
  });

  it("done (unseen) beats degraded so green complete stays visible", () => {
    expect(
      herdrActivity({ agentStatus: "done", connState: "degraded" }),
    ).toMatchObject({
      mode: "pulse",
      tone: "green",
    });
  });

  it("working cyan and done green never share a tone or motion", () => {
    const work = herdrActivity({ agentStatus: "working" });
    const done = herdrActivity({ agentStatus: "done" });
    expect(work.tone).toBe("cyan");
    expect(work.mode).toBe("wave");
    expect(done.tone).toBe("green");
    expect(done.mode).toBe("pulse");
    expect(work.tone).not.toBe(done.tone);
    expect(work.mode).not.toBe(done.mode);
  });
});

describe("browserActivity", () => {
  it("waves on loading and attaching", () => {
    expect(browserActivity({ state: "loading" }).mode).toBe("wave");
    expect(browserActivity({ state: "ready", attaching: true }).mode).toBe(
      "wave",
    );
  });

  it("live ready / failed / idle", () => {
    expect(browserActivity({ state: "ready" })).toMatchObject({
      mode: "pulse",
      tone: "green",
      label: "live",
    });
    expect(browserActivity({ state: "failed" }).tone).toBe("crimson");
    expect(browserActivity({ state: "idle" }).mode).toBe("static");
  });
});

describe("terminalActivity", () => {
  it("uses the same working, attention, and idle grammar as herdr", () => {
    expect(terminalActivity({ seatState: "working" })).toMatchObject({
      mode: "wave",
      tone: "cyan",
      pattern: "snake",
    });
    expect(terminalActivity({ seatState: "attention" })).toMatchObject({
      mode: "wave",
      tone: "amber",
      pattern: "ripple",
    });
    // Live PTY under an idle seat still paints green process wave (not steel idle).
    expect(
      terminalActivity({ seatState: "idle", running: true }),
    ).toMatchObject({
      mode: "wave",
      tone: "green",
      pattern: "ripple",
    });
  });

  it("idle + needsLook is ready/complete green pulse, not amber clockwise", () => {
    expect(
      terminalActivity({ seatState: "idle", needsLook: true }),
    ).toMatchObject({
      mode: "pulse",
      tone: "green",
      label: "Ready — waiting for review",
    });
    // Seen idle stays quiet.
    expect(terminalActivity({ seatState: "idle", needsLook: false })).toMatchObject({
      mode: "static",
      tone: "steel",
      label: "idle",
    });
    // True needs-input stays amber wave (distinct from complete).
    expect(terminalActivity({ seatState: "attention" })).toMatchObject({
      mode: "wave",
      tone: "amber",
    });
  });

  it("turn-stalled attention is amber (not cyan) with stalled accessible label", () => {
    expect(
      terminalActivity({
        seatState: "attention",
        seatReason: "turn-stalled",
      }),
    ).toMatchObject({
      mode: "wave",
      tone: "amber",
      label: "stalled — needs operator look",
    });
    expect(
      terminalActivity({
        seatState: "attention",
        seatReason: "prompt-stalled",
      }).label,
    ).toBe("stalled — needs operator look");
    // Unrelated attention reasons keep needs-input wording.
    expect(
      terminalActivity({
        seatState: "attention",
        seatReason: "permission",
      }).label,
    ).toBe("needs operator input");
    // Working remains sacred cyan — stall must not reuse working tone.
    expect(terminalActivity({ seatState: "working" }).tone).toBe("cyan");
  });

  it("waves crimson when graph-blocked even if the seat is idle", () => {
    expect(
      terminalActivity({ seatState: "idle", graphBlocked: true }),
    ).toMatchObject({
      mode: "wave",
      tone: "crimson",
      pattern: "arrow-up",
      label: "blocked",
    });
  });

  it("seat attention still beats graph-blocked (local input first)", () => {
    expect(
      terminalActivity({ seatState: "attention", graphBlocked: true }),
    ).toMatchObject({
      mode: "wave",
      tone: "amber",
      pattern: "ripple",
    });
  });

  it("falls back to process lifecycle for raw terminals", () => {
    expect(terminalActivity({ starting: true })).toMatchObject({
      mode: "wave",
      tone: "green",
      pattern: "diagonal",
    });
    expect(terminalActivity({ running: true })).toMatchObject({
      mode: "wave",
      tone: "green",
      pattern: "ripple",
    });
    // Process green ripple ≠ actor cyan snake.
    expect(terminalActivity({ running: true }).pattern).not.toBe("snake");
    expect(terminalActivity({ seatState: "working" }).pattern).toBe("snake");
    expect(terminalActivity({ running: true, processName: "zsh" }).label).toBe(
      "process · zsh",
    );
    expect(terminalActivity({})).toMatchObject({
      mode: "static",
      tone: "steel",
    });
  });

  it("surfaces missing harness CLI as crimson error (not blocked, not steel stopped)", () => {
    const missing = terminalActivity({
      exitReason: "cli-missing",
      exitMessage: "Claude Code is not installed on this machine",
    });
    expect(missing).toMatchObject({
      mode: "wave",
      tone: "crimson",
      pattern: "diagonal",
      label: "Claude Code is not installed on this machine",
    });
    expect(missing.label).not.toMatch(/stopped|gone|blocked/i);
    // Graph-blocked keeps arrow-up "blocked" — spawn errors do not.
    expect(missing.pattern).not.toBe("arrow-up");

    const spawnFailed = terminalActivity({
      exitReason: "spawn_failed",
      exitMessage: "Codex failed to start",
    });
    expect(spawnFailed).toMatchObject({
      mode: "wave",
      tone: "crimson",
      pattern: "diagonal",
      label: "Codex failed to start",
    });

    // True post-run exit with no exitReason stays stopped.
    expect(terminalActivity({ seatState: "gone" })).toMatchObject({
      mode: "static",
      tone: "steel",
      label: "gone",
    });
    expect(terminalActivity({})).toMatchObject({
      label: "stopped",
      tone: "steel",
    });
  });

  it("live seat states still beat exitReason", () => {
    expect(
      terminalActivity({
        seatState: "working",
        exitReason: "cli-missing",
        exitMessage: "Claude Code is not installed on this machine",
      }),
    ).toMatchObject({ mode: "wave", tone: "cyan", label: "working" });
  });
});

describe("watcherActivity + timerActivity", () => {
  it("watcher pending is static (fire-once, no spin); satisfied static green", () => {
    expect(watcherActivity("pending").mode).toBe("static");
    expect(watcherActivity("satisfied")).toMatchObject({
      mode: "static",
      tone: "green",
    });
  });

  it("timer due waves; future static", () => {
    const now = 1_000_000;
    expect(timerActivity({ nextFire: now - 1, now }).mode).toBe("wave");
    expect(timerActivity({ nextFire: now + 60_000, now }).mode).toBe("static");
    expect(timerActivity({ nextFire: null, now }).mode).toBe("static");
  });
});

describe("chatActivity + toolActivity + loadingActivity", () => {
  it("waves on connecting, permission, tools, sending", () => {
    expect(chatActivity({ status: "connecting" }).mode).toBe("wave");
    expect(chatActivity({ status: "live", pendingPermission: true }).mode).toBe(
      "wave",
    );
    expect(chatActivity({ status: "live", sending: true }).mode).toBe("wave");
    expect(
      chatActivity({ status: "live", tools: [{ status: "in_progress" }] }).mode,
    ).toBe("wave");
  });

  it("uses severity tones: work=cyan, attention=amber, blocked=crimson", () => {
    expect(chatActivity({ status: "connecting" }).tone).toBe("cyan");
    expect(chatActivity({ status: "live", sending: true }).tone).toBe("cyan");
    expect(
      chatActivity({ status: "live", tools: [{ status: "in_progress" }] }).tone,
    ).toBe("cyan");
    expect(chatActivity({ status: "live", pendingPermission: true }).tone).toBe(
      "amber",
    );
    expect(chatActivity({ status: "error" }).tone).toBe("crimson");
  });

  it("static live quiet / error / closed", () => {
    expect(chatActivity({ status: "live" })).toMatchObject({
      mode: "static",
      tone: "green",
    });
    expect(chatActivity({ status: "error" }).tone).toBe("crimson");
    expect(chatActivity({ status: "closed" }).mode).toBe("static");
  });

  it("tool rows", () => {
    expect(toolActivity("in_progress")).toMatchObject({
      mode: "wave",
      tone: "cyan",
    });
    expect(toolActivity("completed").tone).toBe("green");
    expect(toolActivity("failed").tone).toBe("crimson");
  });

  it("loading line", () => {
    expect(loadingActivity(true)).toMatchObject({ mode: "wave", tone: "cyan" });
    expect(loadingActivity(false).mode).toBe("static");
  });
});
