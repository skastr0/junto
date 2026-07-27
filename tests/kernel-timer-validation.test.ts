import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  __resetDeliveryQueueForTest,
  __setDocsForTest,
  checkTimers,
  getNextFire,
  getPulseLog,
  isValidTimerInterval,
  __resetPulseLogForTest,
  __setTimerSchedulerForTest,
} from "../src/main/vellum/kernel/cycle";
import { makeInMemoryTimerScheduler } from "./helpers/in-memory-timer-scheduler";

// forge-review sdk-kernel-build fix 3 — an EtherTimer.everyMinutes of 0,
// negative, NaN, or non-finite must degrade to an unknown-style no-op, never
// a tight loop or a fire storm. Every test below uses a canvas/node id
// unique to that test: cycle.ts's nextFire/watchers maps are module-level
// with no reset seam, and this file's tests all run in one module instance.

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
    __setTimerSchedulerForTest(makeInMemoryTimerScheduler());
  });

  afterEach(() => {
    __resetDeliveryQueueForTest();
    __resetPulseLogForTest();
    __setTimerSchedulerForTest(undefined);
  });

  it("a zero interval never schedules a nextFire entry and logs a note instead of firing", async () => {
    const canvasName = "timer-canvas-zero";
    const nodeId = "timer-zero";
    __setDocsForTest(new Map([[canvasName, timerDoc(nodeId, 0)]]));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await checkTimers();

    expect(getNextFire().has(`${canvasName}::${nodeId}`)).toBe(false);
    expect(getPulseLog().filter((record) => record.canvasName === canvasName)).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`${canvasName}::${nodeId}`));
    errorSpy.mockRestore();
  });

  it("a negative interval never schedules and never fires, even across repeated cycle passes (no tight loop)", async () => {
    const canvasName = "timer-canvas-negative";
    const nodeId = "timer-negative";
    __setDocsForTest(new Map([[canvasName, timerDoc(nodeId, -30)]]));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    // Simulate several evaluation passes back-to-back — the old code would
    // compute a `due` in the past every time and fire on every single one.
    await checkTimers();
    await checkTimers();
    await checkTimers();

    expect(getNextFire().has(`${canvasName}::${nodeId}`)).toBe(false);
    expect(getPulseLog().filter((record) => record.canvasName === canvasName)).toEqual([]);
    vi.restoreAllMocks();
  });

  it("a NaN interval never schedules and never fires, even across repeated cycle passes (no fire storm)", async () => {
    const canvasName = "timer-canvas-nan";
    const nodeId = "timer-nan";
    __setDocsForTest(new Map([[canvasName, timerDoc(nodeId, NaN)]]));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    // NaN is the sharpest case: `now < NaN` is always false, so the old
    // skip-guard (`due === undefined || now < due`) never engaged and this
    // fired on every pass.
    await checkTimers();
    await checkTimers();
    await checkTimers();

    expect(getNextFire().has(`${canvasName}::${nodeId}`)).toBe(false);
    expect(getPulseLog().filter((record) => record.canvasName === canvasName)).toEqual([]);
    vi.restoreAllMocks();
  });

  it("an Infinity interval never schedules and never fires", async () => {
    const canvasName = "timer-canvas-infinity";
    const nodeId = "timer-infinity";
    __setDocsForTest(new Map([[canvasName, timerDoc(nodeId, Infinity)]]));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await checkTimers();

    expect(getNextFire().has(`${canvasName}::${nodeId}`)).toBe(false);
    expect(getPulseLog().filter((record) => record.canvasName === canvasName)).toEqual([]);
    vi.restoreAllMocks();
  });

  it("a valid interval still schedules one interval out and does not fire on discovery (unaffected by the guard)", async () => {
    const canvasName = "timer-canvas-valid";
    const nodeId = "timer-valid";
    __setDocsForTest(new Map([[canvasName, timerDoc(nodeId, 30)]]));

    await checkTimers();

    const due = getNextFire().get(`${canvasName}::${nodeId}`);
    expect(due).toBeDefined();
    expect(due!).toBeGreaterThan(Date.now()); // scheduled out, not immediately due
    expect(getPulseLog().filter((record) => record.canvasName === canvasName)).toEqual([]);
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

  it("uses the durable policy decision to coalesce a late timer into one pulse", async () => {
    const canvasName = "timer-canvas-coalesced";
    const nodeId = "timer-coalesced";
    __setDocsForTest(
      new Map([[canvasName, timerDoc(nodeId, 1)]]),
    );

    await checkTimers(1_000_000);
    await checkTimers(1_250_000);
    await checkTimers(1_250_000);
    await Promise.resolve();

    const records = getPulseLog().filter(
      (record) => record.canvasName === canvasName,
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.summary).toContain(
      "3 missed interval(s) coalesced",
    );
    expect(getNextFire().get(`${canvasName}::${nodeId}`)).toBe(
      1_300_000,
    );
  });
});
