import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetPulseLogForTest,
  __setDeliveryDepsForTest,
  __setDocsForTest,
  deliverPulse,
  getPulseLog,
  MIN_LIVE_PULSE_SPACING_MS,
  setArmed,
  type PulseDeliverDeps,
} from "../src/main/vellum/kernel/cycle";

// Live-pulse spacing is per (canvas, region). The SAME region id on two
// canvases is two distinct regions and each keeps its own spacing window;
// filtering on regionId alone would let them share one.

const REGION = "shared-region-id";

const deliverDeps: PulseDeliverDeps = {
  isLive: () => true,
  openChat: async () => undefined,
  sendPrompt: async () => undefined,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-15T12:00:00Z"));
  __resetPulseLogForTest();
  __setDocsForTest(
    new Map([
      ["canvas-a", { nodes: [], edges: [] }],
      ["canvas-b", { nodes: [], edges: [] }],
    ]),
  );
  setArmed(`canvas-a::${REGION}`, true);
  setArmed(`canvas-b::${REGION}`, true);
  __setDeliveryDepsForTest(deliverDeps);
});

afterEach(() => {
  __setDeliveryDepsForTest(undefined);
  vi.useRealTimers();
});

const deliver = (canvasName: string, i: number) =>
  deliverPulse({ canvasName, sourceNodeId: `n${i}`, kind: "manual", regionId: REGION, summary: `${canvasName} ${i}` });

describe("deliverPulse — live-pulse spacing is per (canvas, region)", () => {
  it("one canvas inside its cooldown does not cool the same region id on another canvas", async () => {
    await deliver("canvas-a", 0); // live — starts canvas-a's window

    // canvas-b, SAME region id, immediately after — must be live (own window).
    await deliver("canvas-b", 0);

    const log = getPulseLog();
    expect(log.filter((r) => r.canvasName === "canvas-a" && !r.dry)).toHaveLength(1);
    expect(log.filter((r) => r.canvasName === "canvas-b" && !r.dry)).toHaveLength(1);

    // canvas-a again inside the window: suppressed to dry; canvas-b untouched.
    await deliver("canvas-a", 1);
    const second = getPulseLog().filter((r) => r.canvasName === "canvas-a").at(-1);
    expect(second?.dry).toBe(true);
    expect(second?.summary).toContain("cooldown");
  });

  it("a 5-minute-or-slower cadence flows live without suppression", async () => {
    await deliver("canvas-a", 0);
    vi.setSystemTime(Date.now() + MIN_LIVE_PULSE_SPACING_MS);
    await deliver("canvas-a", 1);
    vi.setSystemTime(Date.now() + MIN_LIVE_PULSE_SPACING_MS + 1);
    await deliver("canvas-a", 2);

    const live = getPulseLog().filter((r) => r.canvasName === "canvas-a" && !r.dry);
    expect(live).toHaveLength(3);
  });

  it("seconds-level flapping is suppressed until the window elapses", async () => {
    await deliver("canvas-a", 0); // live
    for (let i = 1; i <= 5; i += 1) {
      vi.setSystemTime(Date.now() + 1_000); // one-second flaps
      await deliver("canvas-a", i);
    }
    const records = getPulseLog().filter((r) => r.canvasName === "canvas-a");
    expect(records.filter((r) => !r.dry)).toHaveLength(1);
    expect(records.filter((r) => r.dry)).toHaveLength(5);

    vi.setSystemTime(Date.now() + MIN_LIVE_PULSE_SPACING_MS);
    await deliver("canvas-a", 99);
    expect(getPulseLog().filter((r) => r.canvasName === "canvas-a" && !r.dry)).toHaveLength(2);
  });
});
