import { describe, expect, it } from "vitest";
import { decodeCanvasDoc } from "./canvas";
import {
  defaultTaskInsert,
  migrateEnqueueBriefToTaskInsert,
  scrubDoesEffect,
  setTaskInsertField,
  taskInsertToCreateArgs,
  taskInsertValid,
} from "./effect-insert";

describe("effect-insert", () => {
  it("maps TaskInsert to work create args", () => {
    const args = taskInsertToCreateArgs({
      title: "Ship wire form",
      details: "Title + description on the effect wire",
      reason: "scheduler",
      finishCriteria: { description: "form saves", git: { minCommits: 1 } },
    });
    expect(args.brief).toBe("Ship wire form");
    expect(args.metadata).toEqual({
      title: "Ship wire form",
      details: "Title + description on the effect wire",
    });
    expect(args.reason).toBe("scheduler");
    expect(args.finishCriteria).toEqual({
      description: "form saves",
      git: { minCommits: 1 },
    });
  });

  it("rejects empty title or details", () => {
    expect(taskInsertValid({ title: "", details: "x" })).toBe(false);
    expect(taskInsertValid({ title: "x", details: "  " })).toBe(false);
    expect(taskInsertValid(defaultTaskInsert("cron"))).toBe(true);
  });

  it("migrates legacy brief wire shape", () => {
    expect(
      migrateEnqueueBriefToTaskInsert({
        mode: "enqueue_task",
        brief: "legacy ask",
        reason: "scheduler",
      }),
    ).toEqual({
      title: "legacy ask",
      details: "legacy ask",
      reason: "scheduler",
    });
    expect(
      migrateEnqueueBriefToTaskInsert({
        mode: "enqueue_task",
        task: { title: "n", details: "d" },
      }),
    ).toBeUndefined();
  });

  it("scrubs does on canvas decode so old boards open", () => {
    const result = decodeCanvasDoc({
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
            does: { mode: "enqueue_task", brief: "old board brief", reason: "scheduler" },
          },
        },
      ],
    });
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    const does = result.success.edges[0]?.ether?.does;
    expect(does).toEqual({
      mode: "enqueue_task",
      task: {
        title: "old board brief",
        details: "old board brief",
        reason: "scheduler",
      },
    });
  });

  it("setTaskInsertField updates nested finish criteria", () => {
    let task = defaultTaskInsert("relay");
    task = setTaskInsertField(task, "title", "Review");
    task = setTaskInsertField(task, "details", "Check the board");
    task = setTaskInsertField(task, "finishCriteria.description", "green");
    task = setTaskInsertField(task, "finishCriteria.git.minCommits", "2");
    expect(task.finishCriteria).toEqual({
      description: "green",
      git: { minCommits: 2 },
    });
    expect(scrubDoesEffect({ mode: "set_flag", flag: "attention", enabled: true })).toEqual({
      mode: "set_flag",
      flag: "attention",
      enabled: true,
    });
  });
});
