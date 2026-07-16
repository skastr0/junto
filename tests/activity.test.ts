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
  it("returns monochrome stops for a tone", () => {
    const stops = houseGradientStops("amber");
    expect(stops).toHaveLength(3);
    expect(stops[0]?.position).toBe(0);
    expect(stops[2]?.position).toBe(1);
    expect(stops[0]?.color).toMatch(/^rgba\(/);
    expect(stops[1]?.color).toMatch(/^#/);
    expect(stops[2]?.color).toMatch(/^rgba\(/);
  });

  it("can tip amber into cyan", () => {
    const stops = houseGradientStops("amber", { cyanTip: true });
    expect(stops[2]?.color).toContain("57"); // cyan channel fragment
  });
});

describe("herdrActivity", () => {
  it("waves on working and blocked; static on idle/done", () => {
    expect(herdrActivity({ agentStatus: "working" })).toEqual({
      mode: "wave",
      tone: "amber",
      label: "working",
    });
    expect(herdrActivity({ agentStatus: "blocked" }).mode).toBe("wave");
    expect(herdrActivity({ agentStatus: "idle" })).toMatchObject({ mode: "static", tone: "green" });
    expect(herdrActivity({ agentStatus: "done" }).tone).toBe("green");
  });

  it("meta loading beats agent idle", () => {
    expect(herdrActivity({ agentStatus: "idle", metaStatus: "loading" })).toMatchObject({
      mode: "wave",
      tone: "cyan",
    });
  });

  it("degraded connection waves when agent settled", () => {
    expect(herdrActivity({ agentStatus: "idle", connState: "degraded" }).mode).toBe("wave");
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
