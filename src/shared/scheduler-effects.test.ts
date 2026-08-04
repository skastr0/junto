import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "./canvas";
import {
  collectEffectEdgesFrom,
  defaultEnqueueBrief,
  evaluateRelay,
  evaluateWatchWhen,
  inferSchedulerEdgeEffect,
  validateEffectTarget,
} from "./scheduler-effects";

const doc = (partial: Partial<CanvasDoc> & Pick<CanvasDoc, "nodes" | "edges">): CanvasDoc =>
  ({
    nodes: partial.nodes,
    edges: partial.edges,
  }) as CanvasDoc;

describe("scheduler-effects", () => {
  it("collects only directed scheduler→target effect edges", () => {
    const canvas = doc({
      nodes: [
        {
          id: "c1",
          type: "text",
          text: "morning review",
          x: 0,
          y: 0,
          width: 100,
          height: 40,
          ether: { entity: { kind: "cron" }, timer: { everyMinutes: 30 } },
        },
        {
          id: "t1",
          type: "text",
          text: "tasks",
          x: 0,
          y: 0,
          width: 100,
          height: 40,
          ether: { entity: { kind: "task" }, tasks: { items: [] } },
        },
      ],
      edges: [
        {
          id: "e1",
          fromNode: "c1",
          toNode: "t1",
          ether: {
            effect: { mode: "enqueue_task", brief: "review overnight" },
          },
        },
        {
          id: "e2",
          fromNode: "t1",
          toNode: "c1",
          ether: {
            effect: { mode: "enqueue_task", brief: "wrong way" },
          },
        },
      ],
    });
    const edges = collectEffectEdgesFrom(canvas, "c1");
    expect(edges).toHaveLength(1);
    expect(edges[0]?.edge.id).toBe("e1");
  });

  it("validates enqueue targets a task sink", () => {
    const task = {
      id: "t1",
      type: "text" as const,
      text: "tasks",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      ether: { entity: { kind: "task" as const } },
    };
    const agent = {
      id: "a1",
      type: "text" as const,
      text: "agent",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      ether: { entity: { kind: "agent" as const, name: "local:x" } },
    };
    expect(
      validateEffectTarget(
        { mode: "enqueue_task", brief: "hi" },
        task,
      ),
    ).toBeUndefined();
    expect(
      validateEffectTarget(
        { mode: "enqueue_task", brief: "hi" },
        agent,
      ),
    ).toBe("target_not_task_sink");
    expect(
      validateEffectTarget(
        { mode: "enqueue_task", brief: "  " },
        task,
      ),
    ).toBe("empty_brief");
  });

  it("infers enqueue when connecting cron to task", () => {
    const cron = {
      id: "c1",
      type: "text" as const,
      text: "nightly harvest",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      ether: { entity: { kind: "cron" as const }, timer: { everyMinutes: 60 } },
    };
    const task = {
      id: "t1",
      type: "text" as const,
      text: "tasks",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      ether: { entity: { kind: "task" as const } },
    };
    expect(inferSchedulerEdgeEffect(cron, task)).toEqual({
      mode: "enqueue_task",
      brief: "nightly harvest",
      reason: "scheduler",
    });
    expect(inferSchedulerEdgeEffect(task, cron)).toBeUndefined();
    const agent = {
      id: "a1",
      type: "text" as const,
      text: "agent",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      ether: { entity: { kind: "agent" as const } },
    };
    expect(inferSchedulerEdgeEffect(cron, agent)).toEqual({
      mode: "inject_prompt",
    });
  });

  it("OR-evaluates multi-select watch any", () => {
    const flagged = {
      id: "n1",
      type: "text" as const,
      text: "x",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      ether: {
        entity: { kind: "task" as const },
        flags: ["attention" as const],
        tasks: { items: [] },
      },
    };
    expect(
      evaluateWatchWhen(flagged, {
        word: "any",
        any: [
          { word: "completes", equals: "completed" },
          { word: "flagged", flag: "attention" },
        ],
      }).status,
    ).toBe("satisfied");
  });

  it("keeps page ready and page failed as independent completes equals", () => {
    const page = {
      id: "p1",
      type: "link" as const,
      url: "https://example.com",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      ether: { entity: { kind: "page" as const } },
    };
    const ready = evaluateWatchWhen(page, {
      word: "completes",
      equals: "ready",
    });
    const failed = evaluateWatchWhen(page, {
      word: "completes",
      equals: "failed",
    });
    expect(ready.detail).toMatch(/ready/i);
    expect(failed.detail).toMatch(/failed/i);
    expect(ready.detail).not.toBe(failed.detail);
    // OR of both still pending until observed
    expect(
      evaluateWatchWhen(page, {
        word: "any",
        any: [
          { word: "completes", equals: "ready" },
          { word: "completes", equals: "failed" },
        ],
      }).status,
    ).toBe("pending");
  });

  it("evaluates relay task_state", () => {
    const canvas = doc({
      nodes: [
        {
          id: "t1",
          type: "text",
          text: "tasks",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          ether: {
            entity: { kind: "task" },
            tasks: {
              items: [
                {
                  id: "item-1",
                  state: "submitted",
                  history: [],
                },
              ],
            },
          },
        },
      ],
      edges: [],
    });
    expect(
      evaluateRelay(canvas, {
        sourceNodeId: "t1",
        path: "task_state",
        equals: "completed",
      }).status,
    ).toBe("pending");
    const done = doc({
      nodes: [
        {
          id: "t1",
          type: "text",
          text: "tasks",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          ether: {
            entity: { kind: "task" },
            tasks: {
              items: [
                {
                  id: "item-1",
                  state: "completed",
                  history: [],
                },
              ],
            },
          },
        },
      ],
      edges: [],
    });
    expect(
      evaluateRelay(done, {
        sourceNodeId: "t1",
        path: "task_state",
        equals: "completed",
      }).status,
    ).toBe("satisfied");
  });

  it("default brief falls back to kind", () => {
    expect(
      defaultEnqueueBrief({
        id: "c",
        type: "text",
        text: "  ",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        ether: { entity: { kind: "cron" } },
      }),
    ).toContain("cron");
  });
});
