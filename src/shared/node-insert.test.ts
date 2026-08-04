import { describe, expect, it } from "vitest";
import { decodeCanvasDoc } from "./canvas";
import {
  defaultInsertData,
  insertDataToTaskCreateArgs,
  insertDataValid,
  insertFieldsFor,
  migrateBriefToInsertData,
  setInsertField,
} from "./node-insert";

describe("node-insert", () => {
  it("publishes fields for task enqueue, not other kinds", () => {
    expect(insertFieldsFor("task", "enqueue_task").map((f) => f.key)).toContain(
      "title",
    );
    expect(insertFieldsFor("board", "enqueue_task")).toEqual([]);
  });

  it("validates required keys for target kind", () => {
    expect(insertDataValid("task", "enqueue_task", { title: "a" })).toBe(false);
    expect(
      insertDataValid("task", "enqueue_task", {
        title: "a",
        details: "b",
      }),
    ).toBe(true);
  });

  it("maps data to task create only at the adapter boundary", () => {
    const args = insertDataToTaskCreateArgs({
      title: "Ship",
      details: "Full description",
      reason: "scheduler",
      "finishCriteria.description": "done",
      "finishCriteria.git.minCommits": "2",
    });
    expect(args.brief).toBe("Ship");
    expect(args.metadata).toEqual({ title: "Ship", details: "Full description" });
    expect(args.finishCriteria).toEqual({
      description: "done",
      git: { minCommits: 2 },
    });
  });

  it("scrubs legacy brief and mistaken task shapes on decode", () => {
    const fromBrief = decodeCanvasDoc({
      nodes: [
        {
          id: "c1",
          type: "text",
          text: "cron",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          ether: { entity: { kind: "cron" }, timer: { everyMinutes: 15 } },
        },
        {
          id: "t1",
          type: "text",
          text: "tasks",
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          ether: { entity: { kind: "task" } },
        },
      ],
      edges: [
        {
          id: "e1",
          fromNode: "c1",
          toNode: "t1",
          ether: {
            does: {
              mode: "enqueue_task",
              brief: "old brief",
              reason: "scheduler",
            },
          },
        },
      ],
    });
    expect(fromBrief._tag).toBe("Success");
    if (fromBrief._tag !== "Success") return;
    expect(fromBrief.success.edges[0]?.ether?.does).toEqual({
      mode: "enqueue_task",
      data: {
        title: "old brief",
        details: "old brief",
        reason: "scheduler",
      },
    });

    expect(
      migrateBriefToInsertData({
        mode: "enqueue_task",
        task: { title: "T", details: "D", reason: "r" },
      }),
    ).toEqual({ title: "T", details: "D", reason: "r" });
  });

  it("default data is kind-aware", () => {
    expect(defaultInsertData("task", "morning").title).toContain("morning");
    expect(defaultInsertData("page", "x")).toEqual({});
    let data = defaultInsertData("task", "x");
    data = setInsertField(data, "title", "Review");
    expect(data.title).toBe("Review");
  });
});
