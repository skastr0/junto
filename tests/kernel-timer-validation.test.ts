import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  __resetKernelMemoryForTest,
  __setAutomationGateForTest,
  __setDocsForTest,
  checkTimers,
  getNextFire,
  isValidTimerInterval,
  __setTimerSchedulerForTest,
} from "../src/main/junto/kernel/cycle";
import { makeInMemoryTimerScheduler } from "./helpers/in-memory-timer-scheduler";

// forge-review sdk-kernel-build fix 3 — an EtherTimer.everyMinutes of 0,
// negative, NaN, or non-finite must degrade to an unknown-style no-op, never
// a tight loop or a fire storm. Every test below uses a canvas/node id
// unique to that test: cycle.ts's nextFire/watchers maps are module-level
// with no per-test isolation beyond __resetKernelMemoryForTest.

// --- isValidTimerInterval — pure boundary check ------------------------------

describe("isValidTimerInterval", () => {
  it("accepts a positive finite interval", () => {
    expect(isValidTimerInterval(5)).toBe(true);
    expect(isValidTimerInterval(1440)).toBe(true);
    expect(isValidTimerInterval(0.5)).toBe(true);
  });

  it("rejects zero", () => {
    expect(isValidTimerInterval(0)).toBe(false);
  });

  it("rejects negative values", () => {
    expect(isValidTimerInterval(-1)).toBe(false);
    expect(isValidTimerInterval(-60)).toBe(false);
  });

  it("rejects NaN", () => {
    expect(isValidTimerInterval(NaN)).toBe(false);
  });

  it("rejects non-finite values", () => {
    expect(isValidTimerInterval(Infinity)).toBe(false);
    expect(isValidTimerInterval(-Infinity)).toBe(false);
  });
});

// --- checkTimers — invalid intervals never schedule, never fire, never loop -

const timerDoc = (nodeId: string, everyMinutes: number): CanvasDoc =>
  ({
    nodes: [
      {
        id: nodeId,
        type: "text",
        text: "timer",
        x: 0,
        y: 0,
        width: 100,
        height: 40,
        ether: { entity: { kind: "timer" }, timer: { everyMinutes } },
      },
    ],
    edges: [],
  }) as unknown as CanvasDoc;

describe("checkTimers — invalid everyMinutes degrades to a no-op", () => {
  beforeEach(() => {
    __resetKernelMemoryForTest();
    __setTimerSchedulerForTest(makeInMemoryTimerScheduler());
    __setAutomationGateForTest({
      canAutomateCanvas: () => true,
      canApplyFlagEffects: () => true,
    });
  });

  afterEach(() => {
    __setTimerSchedulerForTest(undefined);
    __setAutomationGateForTest(undefined);
  });

  it("a zero interval never schedules a nextFire entry", async () => {
    const canvasName = "timer-canvas-zero";
    const nodeId = "timer-zero";
    __setDocsForTest(new Map([[canvasName, timerDoc(nodeId, 0)]]));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await checkTimers();

    expect(getNextFire().has(`${canvasName}::${nodeId}`)).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`${canvasName}::${nodeId}`));
    errorSpy.mockRestore();
  });

  it("a negative interval never schedules, even across repeated cycle passes (no tight loop)", async () => {
    const canvasName = "timer-canvas-negative";
    const nodeId = "timer-negative";
    __setDocsForTest(new Map([[canvasName, timerDoc(nodeId, -30)]]));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await checkTimers();
    await checkTimers();
    await checkTimers();

    expect(getNextFire().has(`${canvasName}::${nodeId}`)).toBe(false);
    vi.restoreAllMocks();
  });

  it("a NaN interval never schedules, even across repeated cycle passes (no fire storm)", async () => {
    const canvasName = "timer-canvas-nan";
    const nodeId = "timer-nan";
    __setDocsForTest(new Map([[canvasName, timerDoc(nodeId, NaN)]]));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await checkTimers();
    await checkTimers();
    await checkTimers();

    expect(getNextFire().has(`${canvasName}::${nodeId}`)).toBe(false);
    vi.restoreAllMocks();
  });

  it("an Infinity interval never schedules", async () => {
    const canvasName = "timer-canvas-infinity";
    const nodeId = "timer-infinity";
    __setDocsForTest(new Map([[canvasName, timerDoc(nodeId, Infinity)]]));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await checkTimers();

    expect(getNextFire().has(`${canvasName}::${nodeId}`)).toBe(false);
    vi.restoreAllMocks();
  });

  it("a valid interval still schedules one interval out and does not fire on discovery", async () => {
    const canvasName = "timer-canvas-valid";
    const nodeId = "timer-valid";
    __setDocsForTest(new Map([[canvasName, timerDoc(nodeId, 30)]]));

    await checkTimers();

    const due = getNextFire().get(`${canvasName}::${nodeId}`);
    expect(due).toBeDefined();
    expect(due!).toBeGreaterThan(Date.now()); // scheduled out, not immediately due
  });

  it("an edited-to-invalid timer clears its stale schedule instead of leaving a phantom countdown", async () => {
    const canvasName = "timer-canvas-edited";
    const nodeId = "timer-edited";
    __setDocsForTest(new Map([[canvasName, timerDoc(nodeId, 30)]]));
    await checkTimers();
    expect(getNextFire().has(`${canvasName}::${nodeId}`)).toBe(true);

    // Document edited mid-run: everyMinutes now invalid.
    __setDocsForTest(new Map([[canvasName, timerDoc(nodeId, 0)]]));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await checkTimers();

    expect(getNextFire().has(`${canvasName}::${nodeId}`)).toBe(false);
    vi.restoreAllMocks();
  });

  it("uses the durable policy decision to coalesce a late timer into one nextFire advance", async () => {
    const canvasName = "timer-canvas-coalesced";
    const nodeId = "timer-coalesced";
    const timerKey = `${canvasName}::${nodeId}`;
    __setDocsForTest(new Map([[canvasName, timerDoc(nodeId, 1)]]));

    // Discovery: schedule one interval out (1_000_000 + 60_000).
    await checkTimers(1_000_000);
    expect(getNextFire().get(timerKey)).toBe(1_060_000);

    // Late wall clock: coalesce missed slots into one claim; advance nextFire.
    await checkTimers(1_250_000);
    expect(getNextFire().get(timerKey)).toBe(1_300_000);

    // Same instant again: NotDue — nextFire stays put (no inject, no double-advance).
    await checkTimers(1_250_000);
    expect(getNextFire().get(timerKey)).toBe(1_300_000);
  });
});
