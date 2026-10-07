import { describe, expect, it } from "vitest";
import type { Node } from "./model";
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
import type { Task } from "./work-model";
import type { WatchRead } from "./work-read";
import {
  canvasOf,
  cron,
  page,
  relay,
  seat,
  taskBoard,
  wire,
} from "../../tests/support/model-nodes";

/** The work a watched node holds: task rows by node, nothing else. */
const holding = (rows: Readonly<Record<string, ReadonlyArray<Task>>> = {}): WatchRead => ({
  itemsOf: (node) => rows[node] ?? [],
  board: () => undefined,
  artifacts: () => 0,
});

const watch = (
  source: Node | undefined,
  when: Parameters<typeof evaluateWatchWhen>[1],
  context?: Parameters<typeof evaluateWatchWhen>[3],
  work: WatchRead = holding(),
) => evaluateWatchWhen(source, when, work, context);

const row = (id: string, state: Task["state"]): Task => ({ id, state, history: [] });

describe("scheduler-effects", () => {
  it("collects only directed scheduler→target effect edges", () => {
    const canvas = canvasOf(
      [cron("c1", { label: "morning review", expression: "*/30 * * * *" }), taskBoard("t1")],
      [
        wire("e1", "c1", "t1", "enqueues"),
        // Pointing the other way is the sink announcing, never a fire action.
        wire("e2", "t1", "c1", "announces"),
      ],
    );
    const bindings = collectEffectEdgesFrom(canvas, "c1");
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.effect.mode).toBe("enqueue_task");
  });

  it("validates enqueue targets a task sink", () => {
    const effect = {
      mode: "enqueue_task" as const,
      data: { brief: "hi", metadata: { title: "hi", details: "hi" } },
    };
    expect(validateEffectTarget(effect, taskBoard("t1"))).toBeUndefined();
    expect(validateEffectTarget(effect, seat("a1"))).toBe("target_not_task_sink");
  });

  it("OR-evaluates multi-select watch any", () => {
    expect(
      watch(page("p1"), {
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
    const ready = watch(page("p1"), { word: "completes", equals: "ready" });
    const failed = watch(page("p1"), { word: "completes", equals: "failed" });
    // Not pending — pending spins the card forever for an unconnected sensor.
    expect(ready.status).toBe("unknown");
    expect(failed.status).toBe("unknown");
    expect(ready.detail).toMatch(/watch for load/);
    expect(failed.detail).toMatch(/load failure/);
  });

  it("satisfies page ready/failed from live browser load map", () => {
    const loads = new Map([["p1", "ready" as const]]);
    expect(
      watch(page("p1"), { word: "completes", equals: "ready" }, { pageLoadByNodeId: loads }).status,
    ).toBe("satisfied");
    expect(
      watch(page("p1"), { word: "completes", equals: "failed" }, { pageLoadByNodeId: loads }).status,
    ).toBe("pending");

    const failedLoads = new Map([["p1", "failed" as const]]);
    expect(
      watch(page("p1"), { word: "completes", equals: "failed" }, { pageLoadByNodeId: failedLoads }).status,
    ).toBe("satisfied");
    expect(
      watch(page("p1"), { word: "completes", equals: "ready" }, { pageLoadByNodeId: failedLoads }).status,
    ).toBe("pending");
  });

  it("treats page loading as pending and missing session as unknown", () => {
    expect(
      watch(
        page("p1"),
        { word: "completes", equals: "ready" },
        { pageLoadByNodeId: new Map([["p1", "loading"]]) },
      ).status,
    ).toBe("pending");
    expect(
      watch(
        page("p1"),
        { word: "completes", equals: "ready" },
        { pageLoadByNodeId: new Map() },
      ).status,
    ).toBe("unknown");
  });

  it("OR-evaluates page ready|failed when either load outcome lands", () => {
    const when = {
      word: "any" as const,
      any: [
        { word: "completes" as const, equals: "ready" },
        { word: "completes" as const, equals: "failed" },
      ],
    };
    expect(
      watch(page("p1"), when, { pageLoadByNodeId: new Map([["p1", "ready"]]) }).status,
    ).toBe("satisfied");
    expect(
      watch(page("p1"), when, { pageLoadByNodeId: new Map([["p1", "failed"]]) }).status,
    ).toBe("satisfied");
  });

  it("evaluates watch completes on the rows a task board holds", () => {
    const when = { word: "completes" as const, equals: "completed" };
    expect(watch(taskBoard("t1"), when).detail).toMatch(/has no tasks yet/);
    expect(
      watch(taskBoard("t1"), when, undefined, holding({ t1: [row("item-1", "submitted")] })).status,
    ).toBe("pending");
    expect(
      watch(taskBoard("t1"), when, undefined, holding({ t1: [row("item-1", "completed")] })).status,
    ).toBe("satisfied");
  });

  it("collectWatchEdgesInto compiles the sink's headline event off announces", () => {
    const tasks = taskBoard("t1");
    const canvas = canvasOf([tasks, relay("r1")], [wire("e1", "t1", "r1", "announces")]);
    const edges = collectWatchEdgesInto(canvas, "r1");
    expect(edges).toHaveLength(1);
    expect(edges[0]!.when).toEqual({ word: "completes" });
    expect(
      watch(edges[0]!.source, edges[0]!.when, undefined, holding({ t1: [row("item-1", "completed")] })).status,
    ).toBe("satisfied");
  });

  it("collectWatchEdgesInto keeps announces and skips every other relay wire", () => {
    const canvas = canvasOf(
      [taskBoard("t1"), seat("a1"), relay("r1")],
      [
        // The agent fires the relay by hand — a trigger, never a watch.
        wire("e-fires", "a1", "r1", "fires"),
        // Announcing agents and sinks are the watch inputs.
        wire("e-agent", "a1", "r1", "announces"),
        wire("e-in", "t1", "r1", "announces"),
      ],
    );
    const edges = collectWatchEdgesInto(canvas, "r1");
    expect(edges.map((e) => e.wire.id).sort()).toEqual(["e-agent", "e-in"]);
    // The agent's headline news is a raised hand, not a completion.
    expect(edges.find((e) => e.wire.id === "e-agent")?.when).toEqual({
      word: "signals",
    });
  });

  it("an agent announce is satisfied only while that seat has a raised hand", () => {
    const agent = seat("a1", { label: "Planner" });
    const raised = watch(agent, { word: "signals" }, {
      raisedHandNodeIds: new Set(["a1"]),
    });
    expect(raised.status).toBe("satisfied");
    expect(raised.detail).toBe("Planner raised a hand");

    const other = watch(agent, { word: "signals" }, {
      raisedHandNodeIds: new Set(["someone-else"]),
    });
    expect(other.status).toBe("pending");
    expect(other.detail).toBe("watching Planner for blocked or escalate");

    // No raised-hand map at all is quiet, never satisfied.
    expect(watch(agent, { word: "signals" }).status).toBe("pending");
  });

  it("collectWatchEdgesInto keeps OR multi-input sinks", () => {
    const canvas = canvasOf(
      [taskBoard("t1"), page("p1"), relay("r1")],
      [wire("e1", "t1", "r1", "announces"), wire("e2", "p1", "r1", "announces")],
    );
    const edges = collectWatchEdgesInto(canvas, "r1");
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.when)).toEqual([
      { word: "completes" },
      { word: "completes", equals: "ready" },
    ]);
  });

  it("missing watch source reports reconnect copy, not node-body path", () => {
    expect(watch(undefined, { word: "completes" }).detail).toBe(
      "watch source gone — reconnect a sink",
    );
    expect(NO_WATCH_YET_DETAIL).toMatch(/draw a sink/);
  });

  it("default task effect payload uses scheduler label", () => {
    const label = schedulerSourceLabel(cron("c"));
    expect(label).toBe("cron");
    const data = defaultEffectTasksCreate(label);
    expect(data.brief).toContain("cron");
    expect(String(data.metadata?.details)).toContain("cron");
  });
});
