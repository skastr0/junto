import { describe, expect, it } from "vitest";
import {
  browserActivity,
  chatActivity,
  herdrActivity,
  houseGradientStops,
  loadingActivity,
  terminalActivity,
  timerActivity,
  toolActivity,
  watcherActivity,
} from "../src/renderer/lib/activity";

describe("houseGradientStops", () => {
  it("returns monochrome hex stops for a tone (gradient-spin needs #rrggbb)", () => {
    const stops = houseGradientStops("amber");
    expect(stops).toHaveLength(3);
    expect(stops[0]?.position).toBe(0);
    expect(stops[2]?.position).toBe(1);
    for (const s of stops) {
      expect(s.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("can tip amber into cyan with hex only", () => {
    const stops = houseGradientStops("amber", { cyanTip: true });
    expect(stops[2]?.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    // tip should move toward cyan vs pure amber mid stop
    expect(stops[2]?.color.toLowerCase()).not.toBe(
      stops[1]?.color.toLowerCase(),
    );
  });
});

describe("herdrActivity", () => {
  it("maps herdr seen/unseen with RTS severity tones (cyan/amber/crimson)", () => {
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
    // done = Idle+!seen → attention amber until the operator looks
    expect(herdrActivity({ agentStatus: "done" })).toMatchObject({
      mode: "wave",
      tone: "amber",
      pattern: "ripple",
    });
    // idle = Idle+seen → quiet; never animate the whole fleet
    expect(herdrActivity({ agentStatus: "idle" })).toMatchObject({
      mode: "static",
      tone: "steel",
      label: "idle",
    });
  });

  it("gives each wave state a distinct (tone, pattern) pair", () => {
    const waves = [
      herdrActivity({ agentStatus: "working" }),
      herdrActivity({ agentStatus: "blocked" }),
      herdrActivity({ agentStatus: "done" }),
      herdrActivity({ agentStatus: "idle", connState: "degraded" }),
    ];
    const keys = waves.map((s) => `${s.tone}:${s.pattern ?? "none"}`);
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

  it("done (unseen) beats degraded so attention amber stays visible", () => {
    expect(
      herdrActivity({ agentStatus: "done", connState: "degraded" }),
    ).toMatchObject({
      mode: "wave",
      tone: "amber",
      pattern: "ripple",
    });
  });

  it("working cyan and done amber never share a tone", () => {
    const work = herdrActivity({ agentStatus: "working" });
    const done = herdrActivity({ agentStatus: "done" });
    expect(work.tone).toBe("cyan");
    expect(done.tone).toBe("amber");
    expect(work.tone).not.toBe(done.tone);
  });
});

describe("browserActivity", () => {
  it("waves on loading and attaching", () => {
    expect(browserActivity({ state: "loading" }).mode).toBe("wave");
    expect(browserActivity({ state: "ready", attaching: true }).mode).toBe(
      "wave",
    );
  });

  it("static ready / failed / idle", () => {
    expect(browserActivity({ state: "ready" })).toMatchObject({
      mode: "static",
      tone: "green",
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
    expect(
      terminalActivity({ seatState: "idle", running: true }),
    ).toMatchObject({
      mode: "static",
      tone: "steel",
    });
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
      tone: "cyan",
      pattern: "diagonal",
    });
    expect(terminalActivity({ running: true })).toMatchObject({
      mode: "static",
      tone: "green",
    });
    expect(terminalActivity({})).toMatchObject({
      mode: "static",
      tone: "steel",
    });
  });
});

describe("watcherActivity + timerActivity", () => {
  it("watcher pending waves; satisfied static green", () => {
    expect(watcherActivity("pending").mode).toBe("wave");
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
