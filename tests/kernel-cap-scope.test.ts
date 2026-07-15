import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetPulseLogForTest,
  __setDeliveryDepsForTest,
  __setDocsForTest,
  deliverPulse,
  getPulseLog,
  PULSE_CAP_PER_REGION_PER_HOUR,
  setArmed,
  type PulseDeliverDeps,
} from "../src/main/vellum/kernel/cycle";

// sdk-kernel-build fix 6 — the 6/hr cap is per (canvas, region). The SAME
// region id on two canvases is two distinct regions and each keeps its own
// budget; filtering the rolling-hour count on regionId alone let them share
// one allowance.

const REGION = "shared-region-id";

const deliverDeps: PulseDeliverDeps = {
  isLive: () => true,
  openChat: async () => undefined,
  sendPrompt: async () => undefined,
};

beforeEach(() => {
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
});

const deliver = (canvasName: string, i: number) =>
  deliverPulse({ canvasName, sourceNodeId: `n${i}`, kind: "manual", regionId: REGION, summary: `${canvasName} ${i}` });

describe("deliverPulse — the hourly cap is per (canvas, region)", () => {
  it("one canvas spending its whole budget does not cap the same region id on another canvas", async () => {
    // canvas-a spends all 6 live deliveries.
    for (let i = 0; i < PULSE_CAP_PER_REGION_PER_HOUR; i += 1) await deliver("canvas-a", i);

    // canvas-b, SAME region id, still inside the same hour — must be live (own budget).
    await deliver("canvas-b", 0);

    const log = getPulseLog();
    const aLive = log.filter((r) => r.canvasName === "canvas-a" && !r.dry);
    const bLive = log.filter((r) => r.canvasName === "canvas-b" && !r.dry);
    expect(aLive).toHaveLength(PULSE_CAP_PER_REGION_PER_HOUR);
    expect(bLive).toHaveLength(1); // NOT cannibalized by canvas-a's spend

    // canvas-a's 7th is capped to dry; canvas-b is untouched by that.
    await deliver("canvas-a", 99);
    const seventh = getPulseLog().filter((r) => r.canvasName === "canvas-a").at(-1);
    expect(seventh?.dry).toBe(true);
    expect(seventh?.summary).toContain("cap reached");
  });
});
