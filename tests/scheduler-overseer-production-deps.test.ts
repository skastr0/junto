import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { CanvasDoc } from "../src/shared/canvas";
import { callerGrantLive } from "../src/shared/overseer-authoring";
import { managedAgentEther } from "./helpers/managed-agent-ether";
import {
  __resetKernelMemoryForTest,
  __setAutomationGateForTest,
  __setDocsForTest,
  manualSchedulerFire,
  overseerSchedulerFire,
} from "../src/main/junto/kernel/cycle";
import { __setSchedulerEffectDepsForTest } from "../src/main/junto/kernel/effects";
import { makeSchedulerProductionEffectDeps } from "../src/main/junto/kernel/service";
import { CRON_ENABLED } from "../src/shared/features";
import type { Task } from "../src/shared/work-model";

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
        ether: { ...managedAgentEther("local:a"), overseer: true },
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
      return {
        id: "e-cron-wakes",
        fromNode: "cron1",
        toNode: "agent1",
        ether: { verb: "wakes" as const },
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

const CALLER = { canvasName: "board", nodeId: "agent1" };

const overseerFire = (input: {
  readonly canvasName: string;
  readonly sourceNodeId: string;
  readonly liveGrant: () => Promise<boolean>;
  readonly commitGrantLive?: (
    documents: ReadonlyMap<string, CanvasDoc>,
  ) => boolean;
}) =>
  overseerSchedulerFire({
    canvasName: input.canvasName,
    sourceNodeId: input.sourceNodeId,
    liveGrant: input.liveGrant,
    commitGrantLive:
      input.commitGrantLive ??
      ((documents) => callerGrantLive(documents, CALLER)),
  });

const wireProduction = (input: {
  readonly playing: boolean;
  readonly stationRole: "" | "command-center" | "remote";
  readonly docs: Map<string, CanvasDoc>;
  readonly enqueues: string[];
  readonly prompts: string[];
  readonly enqueueResult?: "ok" | "fail";
}) => {
  const { canAutomateCanvas, effectDeps } =
    makeSchedulerProductionEffectDeps({
      pause: {
        stateFor: () => ({ playing: input.playing, everPlayed: true }),
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
      run: (effect) => Effect.runPromise(effect),
      getStationRole: () => input.stationRole,
      effectReceipts: new Set<string>(),
    });
  __setAutomationGateForTest({ canAutomateCanvas });
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

      const overseer = await overseerFire({
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
    "revoked overseer applies no later effect and refuses honestly",
    async () => {
      wireProduction({
        playing: false,
        stationRole: "command-center",
        docs,
        enqueues,
        prompts,
      });
      const first = await overseerFire({
        canvasName: "board",
        sourceNodeId: "cron1",
        liveGrant: async () => true,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.applied).toBe(2);

      enqueues.length = 0;
      prompts.length = 0;
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
      expect(prompts).toEqual([]);
    },
  );

  it.runIf(CRON_ENABLED)(
    "cascade grant drop is not reported as success",
    async () => {
      const chained: CanvasDoc = {
        ...board(["enqueues"]),
        nodes: [
          ...board(["enqueues"]).nodes,
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
            id: "tasks-relay",
            type: "text",
            text: "relay tasks",
            x: 200,
            y: 100,
            width: 100,
            height: 40,
            ether: { entity: { kind: "task" }, tasks: { items: [] } },
          },
        ],
        edges: [
          ...board(["enqueues"]).edges,
          {
            id: "e-chain",
            fromNode: "cron1",
            toNode: "relay1",
            ether: { verb: "chains" },
          },
          {
            id: "e-relay-enqueues",
            fromNode: "relay1",
            toNode: "tasks-relay",
            ether: { verb: "enqueues" },
          },
        ],
      } as CanvasDoc;
      docs = new Map([["board", chained]]);
      wireProduction({
        playing: false,
        stationRole: "command-center",
        docs,
        enqueues,
        prompts,
      });
      const result = await overseerFire({
        canvasName: "board",
        sourceNodeId: "cron1",
        liveGrant: async () => enqueues.length === 0,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).not.toMatch(/No effect wires/i);
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
      const result = await overseerFire({
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
      const result = await overseerFire({
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
