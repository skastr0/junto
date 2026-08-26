import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  __resetKernelMemoryForTest,
  __setDocsForTest,
  applyNodeFlag,
  clearRuntimeFlag,
  getRuntimeFlagOverrides,
  projectRuntimeFlags,
  setRuntimeFlag,
} from "../src/main/vellum/kernel/cycle";
import {
  __setSchedulerEffectDepsForTest,
  applySchedulerFire,
} from "../src/main/vellum/kernel/effects";

const board = (flags: ReadonlyArray<"blocker" | "parked" | "attention"> = []): CanvasDoc =>
  ({
    nodes: [
      {
        id: "cron",
        type: "text",
        text: "cron",
        x: 0,
        y: 0,
        width: 100,
        height: 40,
        ether: {
          entity: { kind: "cron" },
          timer: { everyMinutes: 30 },
        },
      },
      {
        id: "target",
        type: "text",
        text: "agent seat",
        x: 200,
        y: 0,
        width: 100,
        height: 40,
        ether: {
          entity: { kind: "agent", name: "local:worker" },
          ...(flags.length > 0 ? { flags } : {}),
        },
      },
    ],
    edges: [
      { id: "e-flag", fromNode: "cron", toNode: "target", ether: { verb: "flags" } },
    ],
  }) as CanvasDoc;

describe("applyNodeFlag — durable document truth", () => {
  it("sets and clears flags like toggleFlag / setFlagForNodes", () => {
    const base = board();
    const on = applyNodeFlag(base, "target", "attention", true);
    expect(on.nodes.find((n) => n.id === "target")?.ether?.flags).toEqual([
      "attention",
    ]);
    // Authorial input unchanged.
    expect(base.nodes.find((n) => n.id === "target")?.ether?.flags).toBeUndefined();

    const off = applyNodeFlag(on, "target", "attention", false);
    expect(off.nodes.find((n) => n.id === "target")?.ether?.flags).toBeUndefined();
  });

  it("leaves unknown nodes untouched", () => {
    const base = board(["parked"]);
    const next = applyNodeFlag(base, "missing", "blocker", true);
    expect(next).toBe(base);
  });

  it("preserves sibling flags when toggling one", () => {
    const base = board(["parked"]);
    const next = applyNodeFlag(base, "target", "blocker", true);
    expect(next.nodes.find((n) => n.id === "target")?.ether?.flags).toEqual([
      "parked",
      "blocker",
    ]);
  });
});

describe("set_flag effect — visible on projected/read path", () => {
  beforeEach(() => {
    __resetKernelMemoryForTest();
  });

  afterEach(() => {
    __setSchedulerEffectDepsForTest(undefined);
  });

  it("applySchedulerFire durable-mutates the document the read path sees", async () => {
    let durable: CanvasDoc = board();
    __setDocsForTest(new Map([["board", durable]]));

    const writes: Array<{ flag: string; enabled: boolean }> = [];
    __setSchedulerEffectDepsForTest({
      canAutomateCanvas: () => true,
      canApplyFlagEffects: () => true,
      hasReceipt: () => false,
      recordReceipt: () => undefined,
      enqueueTask: async () => ({ ok: true }),
      setFlag: async (canvasName, nodeId, flag, enabled) => {
        // Production path: applyNodeFlag is what CanvasesService.mutate runs.
        durable = applyNodeFlag(durable, nodeId, flag, enabled);
        // Same-tick eval projection then drop ghost (mirrors service setNodeFlag).
        setRuntimeFlag(canvasName, nodeId, flag, enabled);
        __setDocsForTest(new Map([["board", durable]]));
        clearRuntimeFlag(canvasName, nodeId, flag);
        writes.push({ flag, enabled });
        return { ok: true };
      },
    });

    await applySchedulerFire(durable, {
      canvasName: "board",
      sourceNodeId: "cron",
      kind: "cron",
      fireKey: "test-fire-1",
      status: "satisfied",
    });

    expect(writes).toEqual([{ flag: "attention", enabled: true }]);
    // Document read path — durable ether.flags, not ghost overrides.
    expect(durable.nodes.find((n) => n.id === "target")?.ether?.flags).toEqual([
      "attention",
    ]);
    expect(getRuntimeFlagOverrides("board")).toEqual({});
    // Kernel projected read matches document truth.
    expect(
      projectRuntimeFlags("board", durable).nodes.find((n) => n.id === "target")
        ?.ether?.flags,
    ).toEqual(["attention"]);
  });

  it("skips set_flag when flag effects are not Command Center", async () => {
    const durable = board();
    let called = false;
    __setSchedulerEffectDepsForTest({
      canAutomateCanvas: () => true,
      canApplyFlagEffects: () => false,
      hasReceipt: () => false,
      recordReceipt: () => undefined,
      enqueueTask: async () => ({ ok: true }),
      setFlag: async () => {
        called = true;
        return { ok: true };
      },
    });

    await applySchedulerFire(durable, {
      canvasName: "board",
      sourceNodeId: "cron",
      kind: "cron",
      fireKey: "test-fire-2",
      status: "satisfied",
    });

    expect(called).toBe(false);
    expect(durable.nodes.find((n) => n.id === "target")?.ether?.flags).toBeUndefined();
  });
});
