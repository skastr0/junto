import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "./canvas";
import { defaultEffectTasksCreate } from "./node-insert";
import {
  collectEffectEdgesFrom,
  collectWatchEdgesInto,
  evaluateWatchWhen,
  mergePageLoadStatus,
  NO_WATCH_YET_DETAIL,
  pageLoadMapKey,
  schedulerSourceLabel,
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
        { id: "e1", fromNode: "c1", toNode: "t1", ether: { verb: "enqueues" } },
        // Pointing the other way is the sink announcing, never a fire action.
        { id: "e2", fromNode: "t1", toNode: "c1", ether: { verb: "announces" } },
      ],
    });
    const bindings = collectEffectEdgesFrom(canvas, "c1");
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.effect.mode).toBe("enqueue_task");
  });

  it("validates enqueue targets a task sink", () => {
    const task: import("./canvas").CanvasNode = {
      id: "t1",
      type: "text",
      text: "tasks",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      ether: { entity: { kind: "task" } },
    };
    const agent: import("./canvas").CanvasNode = {
      id: "a1",
      type: "text",
      text: "agent",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      ether: { entity: { kind: "agent" } },
    };
    expect(
      validateEffectTarget(
        { mode: "enqueue_task", data: { brief: "hi", metadata: { title: "hi", details: "hi" } } },
        task,
      ),
    ).toBeUndefined();
    expect(
      validateEffectTarget(
        { mode: "enqueue_task", data: { brief: "hi", metadata: { title: "hi", details: "hi" } } },
        agent,
      ),
    ).toBe("target_not_task_sink");
  });

  it("OR-evaluates multi-select watch any", () => {
    const page: import("./canvas").CanvasNode = {
      id: "p1",
      type: "link",
      url: "https://example.com",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      ether: { entity: { kind: "page" } },
    };
    expect(
      evaluateWatchWhen(page, {
        word: "any",
        any: [
          { word: "completes", equals: "ready" },
          { word: "completes", equals: "failed" },
        ],
      }).status,
    ).toBe("unknown");
  });

  it("mergePageLoadStatus prefers ready/failed over loading", () => {
    expect(mergePageLoadStatus(undefined, "loading")).toBe("loading");
    expect(mergePageLoadStatus("loading", "ready")).toBe("ready");
    expect(mergePageLoadStatus("ready", "loading")).toBe("ready");
    expect(mergePageLoadStatus("loading", "failed")).toBe("failed");
    expect(pageLoadMapKey("board", "p1")).toBe("board::p1");
  });

  it("keeps page ready and page failed as independent completes equals without sensor", () => {
    const page: import("./canvas").CanvasNode = {
      id: "p1",
      type: "link",
      url: "https://example.com",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      ether: { entity: { kind: "page" } },
    };
    const ready = evaluateWatchWhen(page, {
      word: "completes",
      equals: "ready",
    });
    const failed = evaluateWatchWhen(page, {
      word: "completes",
      equals: "failed",
    });
    // Not pending — pending spins the card forever for an unconnected sensor.
    expect(ready.status).toBe("unknown");
    expect(failed.status).toBe("unknown");
    expect(ready.detail).toMatch(/watch for load/);
    expect(failed.detail).toMatch(/load failure/);
  });

  it("satisfies page ready/failed from live browser load map", () => {
    const page: import("./canvas").CanvasNode = {
      id: "p1",
      type: "link",
      url: "https://example.com",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      ether: { entity: { kind: "page" } },
    };
    const loads = new Map([["p1", "ready" as const]]);
    expect(
      evaluateWatchWhen(
        page,
        { word: "completes", equals: "ready" },
        { pageLoadByNodeId: loads },
      ).status,
    ).toBe("satisfied");
    expect(
      evaluateWatchWhen(
        page,
        { word: "completes", equals: "failed" },
        { pageLoadByNodeId: loads },
      ).status,
    ).toBe("pending");

    const failedLoads = new Map([["p1", "failed" as const]]);
    expect(
      evaluateWatchWhen(
        page,
        { word: "completes", equals: "failed" },
        { pageLoadByNodeId: failedLoads },
      ).status,
    ).toBe("satisfied");
    expect(
      evaluateWatchWhen(
        page,
        { word: "completes", equals: "ready" },
        { pageLoadByNodeId: failedLoads },
      ).status,
    ).toBe("pending");
  });

  it("treats page loading as pending and missing session as unknown", () => {
    const page: import("./canvas").CanvasNode = {
      id: "p1",
      type: "link",
      url: "https://example.com",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      ether: { entity: { kind: "page" } },
    };
    expect(
      evaluateWatchWhen(
        page,
        { word: "completes", equals: "ready" },
        { pageLoadByNodeId: new Map([["p1", "loading"]]) },
      ).status,
    ).toBe("pending");
    expect(
      evaluateWatchWhen(
        page,
        { word: "completes", equals: "ready" },
        { pageLoadByNodeId: new Map() },
      ).status,
    ).toBe("unknown");
  });

  it("OR-evaluates page ready|failed when either load outcome lands", () => {
    const page: import("./canvas").CanvasNode = {
      id: "p1",
      type: "link",
      url: "https://example.com",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      ether: { entity: { kind: "page" } },
    };
    const when = {
      word: "any" as const,
      any: [
        { word: "completes" as const, equals: "ready" },
        { word: "completes" as const, equals: "failed" },
      ],
    };
    expect(
      evaluateWatchWhen(page, when, {
        pageLoadByNodeId: new Map([["p1", "ready"]]),
      }).status,
    ).toBe("satisfied");
    expect(
      evaluateWatchWhen(page, when, {
        pageLoadByNodeId: new Map([["p1", "failed"]]),
      }).status,
    ).toBe("satisfied");
  });

  it("evaluates watch completes on task wire (no node body)", () => {
    const source: import("./canvas").CanvasNode = {
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
    };
    expect(
      evaluateWatchWhen(source, {
        word: "completes",
        equals: "completed",
      }).status,
    ).toBe("pending");
    const done = {
      ...source,
      ether: {
        entity: { kind: "task" as const },
        tasks: {
          items: [
            {
              id: "item-1",
              state: "completed" as const,
              history: [],
            },
          ],
        },
      },
    };
    expect(
      evaluateWatchWhen(done, {
        word: "completes",
        equals: "completed",
      }).status,
    ).toBe("satisfied");
  });

  it("collectWatchEdgesInto compiles the sink's headline event off announces", () => {
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
              items: [{ id: "item-1", state: "completed", history: [] }],
            },
          },
        },
        {
          id: "r1",
          type: "text",
          text: "relay",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          ether: {
            entity: { kind: "relay" },
          },
        },
      ],
      edges: [{ id: "e1", fromNode: "t1", toNode: "r1", ether: { verb: "announces" } }],
    });
    const edges = collectWatchEdgesInto(canvas, "r1");
    expect(edges).toHaveLength(1);
    expect(edges[0]!.when).toEqual({ word: "completes" });
    expect(evaluateWatchWhen(edges[0]!.source, edges[0]!.when).status).toBe(
      "satisfied",
    );
  });

  it("collectWatchEdgesInto keeps announces and skips every other relay wire", () => {
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
          ether: { entity: { kind: "task" }, tasks: { items: [] } },
        },
        {
          id: "a1",
          type: "text",
          text: "agent",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          ether: { entity: { kind: "agent", name: "local:a" } },
        },
        {
          id: "r1",
          type: "text",
          text: "relay",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          ether: { entity: { kind: "relay" } },
        },
      ],
      edges: [
        // The agent fires the relay by hand — a trigger, never a watch.
        { id: "e-fires", fromNode: "a1", toNode: "r1", ether: { verb: "fires" } },
        // No verb at all: the relationship says nothing to watch.
        { id: "e-bare", fromNode: "a1", toNode: "r1" },
        // Announcing agents and sinks are the watch inputs.
        { id: "e-agent", fromNode: "a1", toNode: "r1", ether: { verb: "announces" } },
        { id: "e-in", fromNode: "t1", toNode: "r1", ether: { verb: "announces" } },
      ],
    });
    const edges = collectWatchEdgesInto(canvas, "r1");
    expect(edges.map((e) => e.edge.id).sort()).toEqual(["e-agent", "e-in"]);
    // The agent's headline news is a raised hand, not a completion.
    expect(edges.find((e) => e.edge.id === "e-agent")?.when).toEqual({
      word: "signals",
    });
  });

  it("an agent announce is satisfied only while that seat has a raised hand", () => {
    const agent = {
      id: "a1",
      type: "text" as const,
      text: "Planner",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      ether: { entity: { kind: "agent", name: "local:planner" } },
    };
    const raised = evaluateWatchWhen(agent, { word: "signals" }, {
      raisedHandNodeIds: new Set(["a1"]),
    });
    expect(raised.status).toBe("satisfied");
    expect(raised.detail).toBe("Planner raised a hand");

    const other = evaluateWatchWhen(agent, { word: "signals" }, {
      raisedHandNodeIds: new Set(["someone-else"]),
    });
    expect(other.status).toBe("pending");
    expect(other.detail).toBe("watching Planner for blocked or escalate");

    // No raised-hand map at all is quiet, never satisfied.
    expect(evaluateWatchWhen(agent, { word: "signals" }).status).toBe("pending");
  });

  it("collectWatchEdgesInto keeps OR multi-input sinks", () => {
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
          ether: { entity: { kind: "task" }, tasks: { items: [] } },
        },
        {
          id: "p1",
          type: "text",
          text: "page",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          ether: { entity: { kind: "page" } },
        },
        {
          id: "r1",
          type: "text",
          text: "relay",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          ether: { entity: { kind: "relay" } },
        },
      ],
      edges: [
        { id: "e1", fromNode: "t1", toNode: "r1", ether: { verb: "announces" } },
        { id: "e2", fromNode: "p1", toNode: "r1", ether: { verb: "announces" } },
      ],
    });
    const edges = collectWatchEdgesInto(canvas, "r1");
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.when)).toEqual([
      { word: "completes" },
      { word: "completes", equals: "ready" },
    ]);
  });

  it("missing watch source reports reconnect copy, not node-body path", () => {
    expect(evaluateWatchWhen(undefined, { word: "completes" }).detail).toBe(
      "watch source gone — reconnect a sink",
    );
    expect(NO_WATCH_YET_DETAIL).toMatch(/draw a sink/);
  });

  it("default task effect payload uses scheduler label", () => {
    const source = {
      id: "c",
      type: "text" as const,
      text: "  ",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      ether: { entity: { kind: "cron" as const } },
    };
    const label = schedulerSourceLabel(source);
    expect(label).toBe("cron");
    const data = defaultEffectTasksCreate(label);
    expect(data.brief).toContain("cron");
    expect(String(data.metadata?.details)).toContain("cron");
  });
});
