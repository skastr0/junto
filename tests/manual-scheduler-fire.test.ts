import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  __resetKernelMemoryForTest,
  __setAutomationGateForTest,
  __setDocsForTest,
  manualSchedulerFire,
} from "../src/main/vellum/kernel/cycle";
import { __setSchedulerEffectDepsForTest } from "../src/main/vellum/kernel/effects";

const board = (): CanvasDoc =>
  ({
    nodes: [
      {
        id: "cron1",
        type: "text",
        text: "morning",
        x: 0,
        y: 0,
        width: 100,
        height: 40,
        ether: {
          entity: { kind: "cron" },
          host: "local",
          timer: { expression: "0 9 * * *" },
        },
      },
      {
        id: "relay1",
        type: "text",
        text: "relay",
        x: 200,
        y: 0,
        width: 100,
        height: 40,
        ether: { entity: { kind: "relay" }, host: "local" },
      },
      {
        id: "tasks-cron",
        type: "text",
        text: "cron tasks",
        x: 0,
        y: 100,
        width: 100,
        height: 40,
        ether: { entity: { kind: "task" }, tasks: { items: [] } },
      },
      {
        id: "tasks-relay",
        type: "text",
        text: "relay tasks",
        x: 200,
        y: 100,
        width: 100,
        height: 40,
        ether: { entity: { kind: "task" }, tasks: { items: [] } },
      },
      {
        id: "agent1",
        type: "text",
        text: "agent",
        x: 400,
        y: 0,
        width: 100,
        height: 40,
        ether: { entity: { kind: "agent", name: "local:a" }, host: "local" },
      },
    ],
    edges: [
      {
        id: "e-cron-does",
        fromNode: "cron1",
        toNode: "tasks-cron",
        ether: {
          does: { mode: "enqueue_task", data: { brief: "from-cron", metadata: { title: "from-cron", details: "from-cron" }, reason: "scheduler" } },
        },
      },
      {
        id: "e-relay-does",
        fromNode: "relay1",
        toNode: "tasks-relay",
        ether: {
          does: { mode: "enqueue_task", data: { brief: "from-relay", metadata: { title: "from-relay", details: "from-relay" }, reason: "scheduler" } },
        },
      },
      // Trigger chain: cron fire cascades into the relay's does edges.
      {
        id: "e-trigger",
        fromNode: "cron1",
        toNode: "relay1",
        ether: { slot: "trigger" },
      },
    ],
  }) as CanvasDoc;

describe("manualSchedulerFire scope", () => {
  const enqueues: string[] = [];

  beforeEach(() => {
    enqueues.length = 0;
    __resetKernelMemoryForTest();
    __setAutomationGateForTest({
      canAutomateCanvas: () => true,
      canApplyFlagEffects: () => true,
    });
    __setSchedulerEffectDepsForTest({
      canAutomateCanvas: () => true,
      canApplyFlagEffects: () => true,
      hasReceipt: () => false,
      recordReceipt: () => undefined,
      enqueueTask: async ({ payload }) => {
        enqueues.push(payload.brief);
        return { ok: true };
      },
      boardCreateTopic: async () => ({ ok: true }),
      boardPost: async () => ({ ok: true }),
      setFlag: async () => ({ ok: true }),
    });
    __setDocsForTest(new Map([["board", board()]]));
  });

  afterEach(() => {
    __setAutomationGateForTest(undefined);
    __setSchedulerEffectDepsForTest(undefined);
  });

  it("cron fire applies own does then cascades trigger→relay does", async () => {
    const result = await manualSchedulerFire({
      canvasName: "board",
      sourceNodeId: "cron1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("cron");
    // cron does + cascade into relay does
    expect(result.applied).toBe(2);
    expect(enqueues).toEqual(["from-cron", "from-relay"]);
  });

  it("relay fire applies only that relay's does (no reverse cascade)", async () => {
    const result = await manualSchedulerFire({
      canvasName: "board",
      sourceNodeId: "relay1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("relay");
    expect(result.applied).toBe(1);
    expect(enqueues).toEqual(["from-relay"]);
  });

  it("refuses non-scheduler sources", async () => {
    const result = await manualSchedulerFire({
      canvasName: "board",
      sourceNodeId: "agent1",
    });
    expect(result.ok).toBe(false);
    expect(enqueues).toEqual([]);
  });

  it("reports paused factory honestly", async () => {
    __setAutomationGateForTest({
      canAutomateCanvas: () => false,
      canApplyFlagEffects: () => true,
    });
    __setSchedulerEffectDepsForTest({
      canAutomateCanvas: () => false,
      canApplyFlagEffects: () => true,
      hasReceipt: () => false,
      recordReceipt: () => undefined,
      enqueueTask: async ({ payload }) => {
        enqueues.push(payload.brief);
        return { ok: true };
      },
      boardCreateTopic: async () => ({ ok: true }),
      boardPost: async () => ({ ok: true }),
      setFlag: async () => ({ ok: true }),
    });
    const result = await manualSchedulerFire({
      canvasName: "board",
      sourceNodeId: "cron1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/playing/i);
    expect(enqueues).toEqual([]);
  });

  it("reports zero does edges without claiming work ran", async () => {
    const bare: CanvasDoc = {
      nodes: [
        {
          id: "r-empty",
          type: "text",
          text: "empty relay",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          ether: { entity: { kind: "relay" } },
        },
      ],
      edges: [],
    } as CanvasDoc;
    __setDocsForTest(new Map([["board", bare]]));
    const result = await manualSchedulerFire({
      canvasName: "board",
      sourceNodeId: "r-empty",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toBe(0);
    expect(result.message).toMatch(/No effect wires/i);
  });
});
