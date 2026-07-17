import { describe, expect, it } from "vitest";
import {
  browserActivity,
  chatActivity,
  herdrActivity,
  houseGradientStops,
  loadingActivity,
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
    expect(stops[2]?.color.toLowerCase()).not.toBe(stops[1]?.color.toLowerCase());
  });
});

describe("herdrActivity", () => {
  it("maps herdr seen/unseen: working/blocked/done wave; idle static", () => {
    expect(herdrActivity({ agentStatus: "working" })).toEqual({
      mode: "wave",
      tone: "amber",
      pattern: "snake",
      label: "working",
    });
    expect(herdrActivity({ agentStatus: "blocked" })).toMatchObject({
      mode: "wave",
      tone: "crimson",
      pattern: "arrow-up",
    });
    // done = Idle+!seen → attention until the operator looks
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
      herdrActivity({ metaStatus: "loading" }),
      herdrActivity({ agentStatus: "working" }),
      herdrActivity({ agentStatus: "blocked" }),
      herdrActivity({ agentStatus: "done" }),
      herdrActivity({ agentStatus: "idle", connState: "degraded" }),
    ];
    const keys = waves.map((s) => `${s.tone}:${s.pattern ?? "none"}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("meta loading beats agent idle", () => {
    expect(herdrActivity({ agentStatus: "idle", metaStatus: "loading" })).toMatchObject({
      mode: "wave",
      tone: "cyan",
    });
  });

  it("degraded connection waves steel when agent is idle (seen)", () => {
    expect(herdrActivity({ agentStatus: "idle", connState: "degraded" })).toMatchObject({
      mode: "wave",
      tone: "steel",
    });
  });

  it("done (unseen) beats degraded so attention stays visible", () => {
    expect(herdrActivity({ agentStatus: "done", connState: "degraded" })).toMatchObject({
      mode: "wave",
      tone: "amber",
      pattern: "ripple",
    });
  });
});

describe("browserActivity", () => {
  it("waves on loading and attaching", () => {
    expect(browserActivity({ state: "loading" }).mode).toBe("wave");
    expect(browserActivity({ state: "ready", attaching: true }).mode).toBe("wave");
  });

  it("static ready / failed / idle", () => {
    expect(browserActivity({ state: "ready" })).toMatchObject({ mode: "static", tone: "green" });
    expect(browserActivity({ state: "failed" }).tone).toBe("crimson");
    expect(browserActivity({ state: "idle" }).mode).toBe("static");
  });
});

describe("watcherActivity + timerActivity", () => {
  it("watcher pending waves; satisfied static green", () => {
    expect(watcherActivity("pending").mode).toBe("wave");
    expect(watcherActivity("satisfied")).toMatchObject({ mode: "static", tone: "green" });
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
    expect(chatActivity({ status: "live", pendingPermission: true }).mode).toBe("wave");
    expect(chatActivity({ status: "live", sending: true }).mode).toBe("wave");
    expect(
      chatActivity({ status: "live", tools: [{ status: "in_progress" }] }).mode,
    ).toBe("wave");
  });

  it("static live quiet / error / closed", () => {
    expect(chatActivity({ status: "live" })).toMatchObject({ mode: "static", tone: "green" });
    expect(chatActivity({ status: "error" }).tone).toBe("crimson");
    expect(chatActivity({ status: "closed" }).mode).toBe("static");
  });

  it("tool rows", () => {
    expect(toolActivity("in_progress").mode).toBe("wave");
    expect(toolActivity("completed").tone).toBe("green");
    expect(toolActivity("failed").tone).toBe("crimson");
  });

  it("loading line", () => {
    expect(loadingActivity(true).mode).toBe("wave");
    expect(loadingActivity(false).mode).toBe("static");
  });
});
