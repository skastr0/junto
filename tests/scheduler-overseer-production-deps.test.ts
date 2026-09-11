import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  __resetKernelMemoryForTest,
  __setAutomationGateForTest,
  __setDocsForTest,
  manualSchedulerFire,
  overseerSchedulerFire,
} from "../src/main/vellum-command/kernel/cycle";
import { __setSchedulerEffectDepsForTest } from "../src/main/vellum-command/kernel/effects";
import { makeSchedulerProductionEffectDeps } from "../src/main/vellum-command/kernel/service";
import { mainAuthoringGate } from "../src/main/vellum-command/main-authoring-gate";
import { CRON_ENABLED } from "../src/shared/features";
import type { Task } from "../src/shared/work-model";

const board = (
  edges: ReadonlyArray<"enqueues" | "wakes" | "flags"> = ["enqueues", "wakes"],
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
    edges: edges.map((verb) => {
      if (verb === "enqueues") {
        return {
          id: "e-cron-enqueues",
          fromNode: "cron1",
          toNode: "tasks-cron",
          ether: { verb: "enqueues" as const },
        };
      }
      if (verb === "wakes") {
        return {
          id: "e-cron-wakes",
          fromNode: "cron1",
          toNode: "agent1",
          ether: { verb: "wakes" as const },
        };
      }
      return {
        id: "e-cron-flags",
        fromNode: "cron1",
        toNode: "agent1",
        ether: { verb: "flags" as const },
      };
    }),
  }) as CanvasDoc;

const workOk = <T>(data: T, doc: CanvasDoc) =>
  ({
    ok: true as const,
    data,
    doc,
    revision: "rev-1",
    disposition: "applied" as const,
  });

const workFail = (message: string) =>
  ({
    ok: false as const,
    code: "invalid" as const,
    message,
  });

const wireProduction = (input: {
  readonly playing: boolean;
  readonly stationRole: "" | "command-center" | "remote";
  readonly docs: Map<string, CanvasDoc>;
  readonly enqueues: string[];
  readonly prompts: string[];
  readonly enqueueResult?: "ok" | "fail";
}) => {
  const { canAutomateCanvas, canApplyFlagEffects, effectDeps } =
    makeSchedulerProductionEffectDeps({
      pause: {
        stateFor: () => ({
          playing: input.playing,
          everPlayed: true,
          pausedNodes: [],
          pausedRegions: [],
        }),
      },
      work: {
        workTaskCreate: (canvas, _sink, brief) =>
          Effect.sync(() => {
            if (input.enqueueResult === "fail") {
              return workFail("work refused the enqueue");
            }
            input.enqueues.push(brief);
            return workOk({} as Task, input.docs.get(canvas) ?? board());
          }),
        workSystemMailboxNotify: (canvas, _nodeId, message) =>
          Effect.sync(() => {
            const text =
              message.parts.find((part) => part.kind === "text")?.text ?? "";
            input.prompts.push(text);
            return workOk(message, input.docs.get(canvas) ?? board());
          }),
      },
      canvases: {
        mutate: (name, fn) =>
          Effect.sync(() => {
            const current = input.docs.get(name);
            if (current === undefined) {
              throw new Error(`canvas "${name}" missing`);
            }
            input.docs.set(name, fn(current));
          }),
      },
      docs: input.docs,
      run: (effect) => Effect.runPromise(effect),
      getStationRole: () => input.stationRole,
      effectReceipts: new Set<string>(),
    });
  __setAutomationGateForTest({ canAutomateCanvas, canApplyFlagEffects });
  __setSchedulerEffectDepsForTest(effectDeps);
  __setDocsForTest(input.docs);
};

describe("overseer scheduler production effect deps", () => {
  const enqueues: string[] = [];
  const prompts: string[] = [];
  let docs: Map<string, CanvasDoc>;

  beforeEach(() => {
    enqueues.length = 0;
    prompts.length = 0;
    docs = new Map([["board", board()]]);
    __resetKernelMemoryForTest();
  });

  afterEach(() => {
    __setAutomationGateForTest(undefined);
    __setSchedulerEffectDepsForTest(undefined);
  });

  it.runIf(CRON_ENABLED)(
    "paused canvas with scheduler edges dispatches authorized overseer enqueue and prompt",
    async () => {
      wireProduction({
        playing: false,
        stationRole: "command-center",
        docs,
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
    "paused overseer flags mutate through production setFlag; ordinary flags stay gated",
    async () => {
      docs = new Map([["board", board(["flags"])]]);
      wireProduction({
        playing: false,
        stationRole: "command-center",
        docs,
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
      expect(docs.get("board")?.nodes.find((n) => n.id === "agent1")?.ether?.flags).toBeUndefined();

      const overseer = await mainAuthoringGate.run("control.overseer", () =>
        overseerSchedulerFire({
          canvasName: "board",
          sourceNodeId: "cron1",
          liveGrant: async () => true,
        }),
      );
      expect(overseer.ok).toBe(true);
      if (!overseer.ok) return;
      expect(overseer.applied).toBe(1);
      expect(
        docs.get("board")?.nodes.find((n) => n.id === "agent1")?.ether?.flags,
      ).toEqual(["attention"]);
    },
  );

  it.runIf(CRON_ENABLED)(
    "revoked overseer applies no later effect and refuses honestly",
    async () => {
      wireProduction({
        playing: false,
        stationRole: "command-center",
        docs,
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

      enqueues.length = 0;
      prompts.length = 0;
      const revoked = await overseerSchedulerFire({
        canvasName: "board",
        sourceNodeId: "cron1",
        liveGrant: async () => false,
      });
      expect(revoked.ok).toBe(false);
      if (revoked.ok) return;
      expect(revoked.message).toMatch(/grant revoked/i);
      expect(revoked.message).not.toMatch(/No effect wires/i);
      expect(enqueues).toEqual([]);
      expect(prompts).toEqual([]);
    },
  );

  it.runIf(CRON_ENABLED)(
    "grant drop after authoring await refuses the mutation",
    async () => {
      docs = new Map([["board", board(["flags"])]]);
      // Entry + applyOne + setFlag admit succeed; in-gate recheck (after
      // authoring-queue await, before mutate) refuses.
      let remaining = 3;
      wireProduction({
        playing: false,
        stationRole: "command-center",
        docs,
        enqueues,
        prompts,
      });
      const result = await overseerSchedulerFire({
        canvasName: "board",
        sourceNodeId: "cron1",
        liveGrant: async () => {
          if (remaining <= 0) return false;
          remaining -= 1;
          return true;
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).not.toMatch(/No effect wires/i);
      expect(
        docs.get("board")?.nodes.find((n) => n.id === "agent1")?.ether?.flags,
      ).toBeUndefined();
    },
  );

  it.runIf(CRON_ENABLED)(
    "wired downstream failure is not reported as no effect wires",
    async () => {
      docs = new Map([["board", board(["enqueues"])]]);
      wireProduction({
        playing: true,
        stationRole: "command-center",
        docs,
        enqueues,
        prompts,
        enqueueResult: "fail",
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
      docs = new Map([["board", board(["wakes"])]]);
      wireProduction({
        playing: false,
        stationRole: "remote",
        docs,
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
