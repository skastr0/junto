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
} from "../src/main/vellum-command/kernel/effects";
import { CRON_ENABLED } from "../src/shared/features";

const board = (
  edges: ReadonlyArray<"enqueues" | "wakes"> = ["enqueues", "wakes"],
): CanvasDoc =>
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
    edges: edges.map((verb) =>
      verb === "enqueues"
        ? {
            id: "e-cron-enqueues",
            fromNode: "cron1",
            toNode: "tasks-cron",
            ether: { verb: "enqueues" },
          }
        : {
            id: "e-cron-wakes",
            fromNode: "cron1",
            toNode: "agent1",
            ether: { verb: "wakes" },
          },
    ),
  }) as CanvasDoc;

/**
 * Production KernelService enqueue/inject admission: real canAutomateCanvas
 * (playing + station role), not a stub that ignores pause.
 */
const wireProductionDeps = (input: {
  readonly playing: boolean;
  readonly stationRole: "" | "command-center" | "remote";
  readonly enqueues: string[];
  readonly prompts: string[];
  readonly enqueueResult?: () => { readonly ok: boolean; readonly message?: string };
}) => {
  const canAutomateCanvas = (): boolean =>
    input.stationRole !== "" && input.playing;
  __setAutomationGateForTest({
    canAutomateCanvas,
    canApplyFlagEffects: () => input.stationRole === "command-center",
  });
  __setSchedulerEffectDepsForTest({
    canAutomateCanvas,
    canApplyFlagEffects: () => input.stationRole === "command-center",
    hasReceipt: () => false,
    recordReceipt: () => undefined,
    enqueueTask: async ({ payload, overseer }) => {
      const admitted = await admitSchedulerEffectAutomation({
        canvasName: "board",
        canAutomateCanvas,
        stationRole: input.stationRole,
        ...(overseer !== undefined ? { overseer } : {}),
      });
      if (!admitted.ok) return admitted;
      if (input.enqueueResult !== undefined) return input.enqueueResult();
      input.enqueues.push(payload.brief);
      return { ok: true };
    },
    setFlag: async () => ({ ok: true }),
    injectPrompt: async ({ text, overseer }) => {
      const admitted = await admitSchedulerEffectAutomation({
        canvasName: "board",
        canAutomateCanvas,
        stationRole: input.stationRole,
        requireCommandCenter: true,
        ...(overseer !== undefined ? { overseer } : {}),
      });
      if (!admitted.ok) return admitted;
      input.prompts.push(text);
      return { ok: true };
    },
  });
};

describe("overseer scheduler production effect deps", () => {
  const enqueues: string[] = [];
  const prompts: string[] = [];

  beforeEach(() => {
    enqueues.length = 0;
    prompts.length = 0;
    __resetKernelMemoryForTest();
    __setDocsForTest(new Map([["board", board()]]));
  });

  afterEach(() => {
    __setAutomationGateForTest(undefined);
    __setSchedulerEffectDepsForTest(undefined);
  });

  it.runIf(CRON_ENABLED)(
    "paused canvas with scheduler edges dispatches authorized overseer enqueue and prompt",
    async () => {
      wireProductionDeps({
        playing: false,
        stationRole: "command-center",
        enqueues,
        prompts,
      });

      const ordinary = await manualSchedulerFire({
        canvasName: "board",
        sourceNodeId: "cron1",
      });
      expect(ordinary.ok).toBe(false);
      if (ordinary.ok) return;
      expect(ordinary.message).toMatch(/playing/u);
      expect(enqueues).toEqual([]);
      expect(prompts).toEqual([]);

      const overseer = await overseerSchedulerFire({
        canvasName: "board",
        sourceNodeId: "cron1",
        liveGrant: async () => true,
      });
      expect(overseer.ok).toBe(true);
      if (!overseer.ok) return;
      expect(overseer.applied).toBe(2);
      expect(enqueues).toEqual(["From morning"]);
      expect(prompts).toHaveLength(1);
    },
  );

  it.runIf(CRON_ENABLED)(
    "revoked overseer applies no later effect on a paused canvas",
    async () => {
      wireProductionDeps({
        playing: false,
        stationRole: "command-center",
        enqueues,
        prompts,
      });
      const first = await overseerSchedulerFire({
        canvasName: "board",
        sourceNodeId: "cron1",
        liveGrant: async () => true,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.applied).toBe(2);
      expect(enqueues).toEqual(["From morning"]);
      expect(prompts).toHaveLength(1);

      enqueues.length = 0;
      prompts.length = 0;
      const revoked = await overseerSchedulerFire({
        canvasName: "board",
        sourceNodeId: "cron1",
        liveGrant: async () => false,
      });
      expect(revoked.ok).toBe(true);
      if (!revoked.ok) return;
      expect(revoked.applied).toBe(0);
      expect(enqueues).toEqual([]);
      expect(prompts).toEqual([]);
    },
  );

  it.runIf(CRON_ENABLED)(
    "wired downstream failure is not reported as no effect wires",
    async () => {
      __setDocsForTest(new Map([["board", board(["enqueues"])]]));
      wireProductionDeps({
        playing: true,
        stationRole: "command-center",
        enqueues,
        prompts,
        enqueueResult: () => ({
          ok: false,
          message: "work refused the enqueue",
        }),
      });
      const result = await overseerSchedulerFire({
        canvasName: "board",
        sourceNodeId: "cron1",
        liveGrant: async () => true,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).not.toMatch(/No effect wires/i);
      expect(result.message).toMatch(/failed to apply/i);
      expect(enqueues).toEqual([]);
    },
  );

  it.runIf(CRON_ENABLED)(
    "overseer inject still requires Command Center",
    async () => {
      __setDocsForTest(new Map([["board", board(["wakes"])]]));
      wireProductionDeps({
        playing: false,
        stationRole: "remote",
        enqueues,
        prompts,
      });
      const result = await overseerSchedulerFire({
        canvasName: "board",
        sourceNodeId: "cron1",
        liveGrant: async () => true,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).not.toMatch(/No effect wires/i);
      expect(prompts).toEqual([]);
      expect(enqueues).toEqual([]);
    },
  );
});
