import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  dependencyScopeIndex,
  dependencyScopeNodeIds,
  dependencyScopeTasks,
} from "../src/shared/task-dep-scope";
import {
  taskIsClaimReady,
  validateTaskDependsOn,
} from "../src/shared/task-deps";
import { workTaskClaim, workTaskCreate, WorkError } from "../src/shared/work";
import { taskItem } from "./helpers/task-fixtures";

const seat = `seat_${"d".repeat(64)}`;

const ids = (() => {
  let n = 0;
  return {
    id: () => `t${++n}`,
    messageId: () => `m${++n}`,
  };
})();

const regionDoc = (): CanvasDoc => ({
  nodes: [
    {
      id: "region-vellum",
      type: "group",
      x: 0,
      y: 0,
      width: 1000,
      height: 1000,
      label: "Vellum",
    },
    {
      id: "lane-a",
      type: "text",
      text: "lane a",
      x: 40,
      y: 40,
      width: 160,
      height: 100,
      ether: {
        entity: { kind: "task" },
        tasks: { items: [taskItem("a1", "prereq on lane a")] },
      },
    },
    {
      id: "lane-b",
      type: "text",
      text: "lane b",
      x: 240,
      y: 40,
      width: 160,
      height: 100,
      ether: { entity: { kind: "task" }, tasks: { items: [] } },
    },
    {
      id: "other-region",
      type: "group",
      x: 2000,
      y: 0,
      width: 500,
      height: 500,
      label: "Elsewhere",
    },
    {
      id: "lane-c",
      type: "text",
      text: "lane c",
      x: 2040,
      y: 40,
      width: 160,
      height: 100,
      ether: {
        entity: { kind: "task" },
        tasks: { items: [taskItem("c1", "foreign prereq")] },
      },
    },
  ],
  edges: [],
});

describe("dependencyScope", () => {
  it("includes co-region task sinks, not other regions", () => {
    const doc = regionDoc();
    const scope = dependencyScopeNodeIds(doc, "lane-b");
    expect(scope.has("lane-a")).toBe(true);
    expect(scope.has("lane-b")).toBe(true);
    expect(scope.has("lane-c")).toBe(false);

    const tasks = dependencyScopeTasks(doc, "lane-b");
    expect(tasks.map((t) => t.id).sort()).toEqual(["a1"]);
  });

  it("accepts cross-sink same-region dependsOn at create and unlocks claim", () => {
    let doc = regionDoc();
    // clear seeded item so create is the only path for a1 style
    doc = {
      ...doc,
      nodes: doc.nodes.map((n) =>
        n.id === "lane-a"
          ? {
              ...n,
              ether: { entity: { kind: "task" }, tasks: { items: [] } },
            }
          : n,
      ),
    };
    const a = workTaskCreate(doc, "factory", "lane-a", "spine", undefined, ids);
    doc = a.doc;
    const b = workTaskCreate(
      doc,
      "factory",
      "lane-b",
      "depends on other lane",
      undefined,
      ids,
      undefined,
      undefined,
      [a.task.id],
    );
    doc = b.doc;
    expect(b.task.dependsOn).toEqual([a.task.id]);

    const byId = dependencyScopeIndex(doc, "lane-b");
    expect(taskIsClaimReady(b.task, byId)).toBe(false);
    expect(
      validateTaskDependsOn({
        taskId: "x",
        dependsOn: [a.task.id],
        byId,
      }),
    ).toBeUndefined();

    // complete a, then b is claim-ready
    doc = {
      ...doc,
      nodes: doc.nodes.map((n) => {
        if (n.id !== "lane-a") return n;
        const items = (n.ether?.tasks?.items ?? []).map((t) =>
          t.id === a.task.id
            ? { ...t, state: "completed" as const, claimedBy: undefined }
            : t,
        );
        return {
          ...n,
          ether: { ...n.ether!, tasks: { items } },
        };
      }),
    };
    expect(
      taskIsClaimReady(
        doc.nodes.find((n) => n.id === "lane-b")!.ether!.tasks!.items[0]!,
        dependencyScopeIndex(doc, "lane-b"),
      ),
    ).toBe(true);

    const claimed = workTaskClaim(
      doc,
      "factory",
      "lane-b",
      b.task.id,
      { seatId: seat as never, canvasName: "factory", nodeId: "agent" },
      ids,
    );
    expect(claimed.task.state).toBe("working");
  });

  it("rejects cross-region dependsOn as missing", () => {
    const doc = regionDoc();
    expect(() =>
      workTaskCreate(
        doc,
        "factory",
        "lane-b",
        "bad",
        undefined,
        ids,
        undefined,
        undefined,
        ["c1"],
      ),
    ).toThrow(WorkError);
    expect(() =>
      workTaskCreate(
        doc,
        "factory",
        "lane-b",
        "bad",
        undefined,
        ids,
        undefined,
        undefined,
        ["c1"],
      ),
    ).toThrow(/missing/);
  });
});
