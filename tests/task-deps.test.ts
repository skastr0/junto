import { describe, expect, it } from "vitest";
import {
  normalizeDependsOn,
  taskDepStatus,
  taskIndexById,
  taskIsClaimReady,
  validateAuthoredTaskDependsOn,
  validateTaskDependsOn,
} from "../src/shared/task-deps";
import type { Task, TaskState } from "../src/shared/work-model";
import { taskItem } from "./helpers/task-fixtures";

const seat = `seat_${"b".repeat(64)}`;

const withDeps = (
  task: Task,
  dependsOn: ReadonlyArray<string>,
  state: TaskState = task.state,
): Task => ({
  ...task,
  state,
  dependsOn: [...dependsOn],
  ...(state === "working" ||
  state === "input-required" ||
  state === "auth-required"
    ? { claimedBy: seat as Task["claimedBy"] }
    : {}),
});

const active = (id: string, brief: string, state: TaskState): Task => ({
  ...taskItem(id, brief, state),
  claimedBy: seat as Task["claimedBy"],
});

describe("task-deps", () => {
  it("normalizes empty / blank dependsOn to undefined", () => {
    expect(normalizeDependsOn(undefined)).toBeUndefined();
    expect(normalizeDependsOn([])).toBeUndefined();
    expect(normalizeDependsOn(["  ", ""])).toBeUndefined();
    expect(normalizeDependsOn(["a", "a", " b "])).toEqual(["a", "b"]);
  });

  it("rejects noncanonical authoring dependency ids before compatibility normalization", () => {
    expect(validateAuthoredTaskDependsOn(undefined)).toBeUndefined();
    expect(validateAuthoredTaskDependsOn([])).toBeUndefined();
    expect(validateAuthoredTaskDependsOn(["   "])).toMatch(/non-empty/);
    expect(validateAuthoredTaskDependsOn([" task-a "])).toMatch(/not canonical/);
    expect(validateAuthoredTaskDependsOn(["task-a", "task-a"])).toMatch(
      /duplicate/,
    );
    expect(validateAuthoredTaskDependsOn(["x".repeat(257)])).toMatch(/too long/);
    expect(
      validateAuthoredTaskDependsOn(
        Array.from({ length: 257 }, (_, index) => `task-${index}`),
      ),
    ).toMatch(/maximum is 256/);
    expect(validateAuthoredTaskDependsOn(["x".repeat(256)])).toBeUndefined();
  });

  it("empty dependsOn is claim-ready when submitted", () => {
    const t = taskItem("s1", "start");
    const byId = taskIndexById([t]);
    expect(taskIsClaimReady(t, byId)).toBe(true);
    expect(taskDepStatus(t, byId)).toEqual({ kind: "ready" });
  });

  it("chain S1..S10 only unlocks the next after completed", () => {
    const items: Task[] = [];
    for (let i = 1; i <= 10; i += 1) {
      const id = `s${i}`;
      items.push(
        i === 1
          ? taskItem(id, id)
          : withDeps(taskItem(id, id), [`s${i - 1}`]),
      );
    }
    const byId = taskIndexById(items);
    expect(taskIsClaimReady(byId.get("s1")!, byId)).toBe(true);
    expect(taskIsClaimReady(byId.get("s2")!, byId)).toBe(false);
    expect(taskDepStatus(byId.get("s10")!, byId)).toEqual({
      kind: "waiting",
      frontier: ["s1"],
    });

    byId.set("s1", { ...byId.get("s1")!, state: "completed" });
    expect(taskIsClaimReady(byId.get("s2")!, byId)).toBe(true);
    expect(taskDepStatus(byId.get("s10")!, byId)).toEqual({
      kind: "waiting",
      frontier: ["s2"],
    });
  });

  it("fan-out after spine end waits only on S10", () => {
    const s10 = { ...taskItem("s10", "spine"), state: "completed" as const };
    const f1 = withDeps(taskItem("f1", "fan"), ["s10"]);
    const f2 = withDeps(taskItem("f2", "fan"), ["s10"]);
    const byId = taskIndexById([s10, f1, f2]);
    expect(taskIsClaimReady(f1, byId)).toBe(true);
    expect(taskIsClaimReady(f2, byId)).toBe(true);

    const s10open = taskItem("s10", "spine");
    const waiting = taskIndexById([s10open, f1, f2]);
    expect(taskDepStatus(f1, waiting)).toEqual({
      kind: "waiting",
      frontier: ["s10"],
    });
  });

  it("join waits for ALL parents", () => {
    const fa = { ...taskItem("fa", "a"), state: "completed" as const };
    const fb = active("fb", "b", "working");
    const merge = withDeps(taskItem("merge", "join"), ["fa", "fb"]);
    const byId = taskIndexById([fa, fb, merge]);
    expect(taskIsClaimReady(merge, byId)).toBe(false);
    expect(taskDepStatus(merge, byId)).toEqual({
      kind: "waiting",
      frontier: ["fb"],
    });
  });

  it("broken ancestor yields blocked, not frontier", () => {
    const s1 = { ...taskItem("s1", "s1"), state: "failed" as const };
    const s2 = withDeps(taskItem("s2", "s2"), ["s1"]);
    const s3 = withDeps(taskItem("s3", "s3"), ["s2"]);
    const byId = taskIndexById([s1, s2, s3]);
    expect(taskIsClaimReady(s3, byId)).toBe(false);
    expect(taskDepStatus(s3, byId)).toEqual({
      kind: "blocked",
      roots: ["s1"],
    });
  });

  it("canceled does not satisfy; completed does", () => {
    const a = { ...taskItem("a", "a"), state: "canceled" as const };
    const b = withDeps(taskItem("b", "b"), ["a"]);
    const byId = taskIndexById([a, b]);
    expect(taskIsClaimReady(b, byId)).toBe(false);
    expect(taskDepStatus(b, byId).kind).toBe("blocked");
  });

  it("diamond collapses frontier to shared ancestor", () => {
    const c = active("c", "c", "working");
    const a = withDeps(taskItem("a", "a"), ["c"]);
    const b = withDeps(taskItem("b", "b"), ["c"]);
    const t = withDeps(taskItem("t", "t"), ["a", "b"]);
    const byId = taskIndexById([c, a, b, t]);
    expect(taskDepStatus(t, byId)).toEqual({
      kind: "waiting",
      frontier: ["c"],
    });
  });

  it("validate rejects self, duplicate, missing, and cycles", () => {
    const a = withDeps(taskItem("a", "a"), ["b"]);
    const b = taskItem("b", "b");
    const byId = taskIndexById([a, b]);
    expect(
      validateTaskDependsOn({ taskId: "x", dependsOn: ["x"], byId }),
    ).toMatch(/itself/);
    expect(
      validateTaskDependsOn({ taskId: "x", dependsOn: ["a", " a "], byId }),
    ).toMatch(/duplicate/);
    expect(
      validateTaskDependsOn({ taskId: "x", dependsOn: ["missing"], byId }),
    ).toMatch(/missing/);
    // b → a → b cycle if b depends on a
    expect(
      validateTaskDependsOn({
        taskId: "b",
        dependsOn: ["a"],
        byId,
      }),
    ).toMatch(/cycle/);
  });

  it("orphan missing dep", () => {
    const t = withDeps(taskItem("t", "t"), ["ghost"]);
    expect(taskDepStatus(t, taskIndexById([t]))).toEqual({
      kind: "orphan",
      missing: ["ghost"],
    });
  });

  it("a sent-on task's completed row stays satisfied for dependents regardless of document order", () => {
    // Send-on leaves two rows sharing a task id: the completed visit and the
    // re-homed successor (submitted). Either
    // document order must resolve the dependency as satisfied.
    const completedSource = taskItem("t", "t", "completed");
    const submittedDestination = taskItem("t", "t", "submitted");
    const dependent = withDeps(taskItem("x", "x"), ["t"]);

    const sourceFirst = taskIndexById([
      completedSource,
      submittedDestination,
      dependent,
    ]);
    expect(taskIsClaimReady(dependent, sourceFirst)).toBe(true);

    const destinationFirst = taskIndexById([
      submittedDestination,
      completedSource,
      dependent,
    ]);
    expect(taskIsClaimReady(dependent, destinationFirst)).toBe(true);
  });
});
