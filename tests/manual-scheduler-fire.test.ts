import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  __resetKernelMemoryForTest,
  __setAutomationGateForTest,
  __setDocsForTest,
  manualSchedulerFire,
  overseerSchedulerFire,
} from "../src/main/vellum-command/kernel/cycle";
import {
  __setSchedulerEffectDepsForTest,
  admitSchedulerEffectAutomation,
  applySchedulerFire,
  collectTriggerCascadeTargets,
} from "../src/main/vellum-command/kernel/effects";
import { CRON_ENABLED, RELAY_ENABLED } from "../src/shared/features";

const overseerFire = (input: {
  readonly canvasName: string;
  readonly sourceNodeId: string;
  readonly liveGrant: () => Promise<boolean>;
}) =>
  overseerSchedulerFire({
    ...input,
    commitGrantLive: () => true,
  });

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
      { id: "e-cron-enqueues", fromNode: "cron1", toNode: "tasks-cron", ether: { verb: "enqueues" } },
      { id: "e-relay-enqueues", fromNode: "relay1", toNode: "tasks-relay", ether: { verb: "enqueues" } },
      // Chain: a cron fire cascades into the relay's own enqueues edge.
      { id: "e-chain", fromNode: "cron1", toNode: "relay1", ether: { verb: "chains" } },
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
      setFlag: async () => ({ ok: true }),
    });
    __setDocsForTest(new Map([["board", board()]]));
  });

  afterEach(() => {
    __setAutomationGateForTest(undefined);
    __setSchedulerEffectDepsForTest(undefined);
  });

  it.runIf(CRON_ENABLED && RELAY_ENABLED)(
    "cron fire applies own does then cascades trigger→relay does",
    async () => {
      const result = await manualSchedulerFire({
        canvasName: "board",
        sourceNodeId: "cron1",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.kind).toBe("cron");
      // cron does + cascade into relay does
      expect(result.applied).toBe(2);
      expect(enqueues).toEqual(["From morning", "From relay"]);
    },
  );

  it.runIf(CRON_ENABLED)(
    "overseer fire succeeds while paused; ordinary manual fire stays paused",
    async () => {
      const canAutomateCanvas = () => false;
      __setSchedulerEffectDepsForTest({
        canAutomateCanvas,
        canApplyFlagEffects: () => true,
        hasReceipt: () => false,
        recordReceipt: () => undefined,
        enqueueTask: async ({ payload, overseer }) => {
          const admitted = await admitSchedulerEffectAutomation({
            canvasName: "board",
            canAutomateCanvas,
            stationRole: "command-center",
            ...(overseer !== undefined ? { overseer } : {}),
          });
          if (!admitted.ok) return admitted;
          enqueues.push(payload.brief);
          return { ok: true };
        },
        setFlag: async () => ({ ok: true }),
      });
      const ordinary = await manualSchedulerFire({
        canvasName: "board",
        sourceNodeId: "cron1",
      });
      expect(ordinary.ok).toBe(false);
      if (ordinary.ok) return;
      expect(ordinary.message).toMatch(/playing/u);
      expect(enqueues).toEqual([]);

      const overseer = await overseerFire({
        canvasName: "board",
        sourceNodeId: "cron1",
        liveGrant: async () => true,
      });
      expect(overseer.ok).toBe(true);
      if (!overseer.ok) return;
      expect(overseer.applied).toBeGreaterThan(0);
      expect(enqueues.length).toBeGreaterThan(0);

      enqueues.length = 0;
      const revoked = await overseerFire({
        canvasName: "board",
        sourceNodeId: "cron1",
        liveGrant: async () => false,
      });
      expect(revoked.ok).toBe(false);
      if (revoked.ok) return;
      expect(revoked.message).toMatch(/grant revoked/i);
      expect(revoked.message).not.toMatch(/No effect wires/i);
      expect(enqueues).toEqual([]);
    },
  );

  it.runIf(RELAY_ENABLED)(
    "relay fire applies only that relay's does (no reverse cascade)",
    async () => {
      const result = await manualSchedulerFire({
        canvasName: "board",
        sourceNodeId: "relay1",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.kind).toBe("relay");
      expect(result.applied).toBe(1);
      expect(enqueues).toEqual(["From relay"]);
    },
  );

  it("refuses non-scheduler sources", async () => {
    const result = await manualSchedulerFire({
      canvasName: "board",
      sourceNodeId: "agent1",
    });
    expect(result.ok).toBe(false);
    expect(enqueues).toEqual([]);
  });

  it.runIf(CRON_ENABLED)("reports paused factory honestly", async () => {
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

  it.runIf(CRON_ENABLED)(
    "reports a wired downstream refuse instead of no-wires success",
    async () => {
      __setSchedulerEffectDepsForTest({
        canAutomateCanvas: () => true,
        canApplyFlagEffects: () => true,
        hasReceipt: () => false,
        recordReceipt: () => undefined,
        enqueueTask: async () => ({
          ok: false,
          message: "work refused the enqueue",
        }),
        setFlag: async () => ({ ok: true }),
      });
      const result = await manualSchedulerFire({
        canvasName: "board",
        sourceNodeId: "cron1",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).not.toMatch(/No effect wires/i);
      expect(result.message).toMatch(/failed to apply/i);
      expect(enqueues).toEqual([]);
    },
  );

  it.runIf(RELAY_ENABLED)(
    "reports zero does edges without claiming work ran",
    async () => {
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
    },
  );

  it.runIf(CRON_ENABLED && !RELAY_ENABLED)(
    "fires cron effects without crossing into a disabled relay",
    async () => {
      const doc = board();
      expect(collectTriggerCascadeTargets(doc, "cron1")).toEqual([]);

      const result = await manualSchedulerFire({
        canvasName: "board",
        sourceNodeId: "cron1",
      });

      expect(result).toMatchObject({ ok: true, applied: 1 });
      expect(enqueues).toEqual(["From morning"]);
    },
  );

  it.runIf(RELAY_ENABLED && !CRON_ENABLED)(
    "does not cascade from an enabled relay into a disabled cron",
    async () => {
      const base = board();
      const doc: CanvasDoc = {
        ...base,
        edges: [
          ...base.edges,
          { id: "e-relay-chains-cron", fromNode: "relay1", toNode: "cron1", ether: { verb: "chains" } },
        ],
      };
      expect(collectTriggerCascadeTargets(doc, "relay1")).toEqual([]);

      await expect(
        applySchedulerFire(doc, {
          canvasName: "board",
          sourceNodeId: "relay1",
          kind: "relay",
          fireKey: "relay-to-disabled-cron",
        }),
      ).resolves.toMatchObject({ applied: 1, cascaded: 0 });
      expect(enqueues).toEqual(["From relay"]);
    },
  );

  it.runIf(RELAY_ENABLED && !CRON_ENABLED)(
    "rejects a direct disabled cron fire before it reaches an enabled relay",
    async () => {
      const doc = board();
      expect(collectTriggerCascadeTargets(doc, "cron1")).toEqual([]);

      await expect(
        applySchedulerFire(doc, {
          canvasName: "board",
          sourceNodeId: "cron1",
          kind: "cron",
          fireKey: "disabled-cron-direct-fire",
        }),
      ).resolves.toEqual({ applied: 0, skipped: "disabled" });
      expect(enqueues).toEqual([]);
    },
  );
});
