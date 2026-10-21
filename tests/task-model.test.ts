import { describe, expect, expectTypeOf, it } from "vitest";
import { asNodeId } from "../src/shared/model";
import {
  ASSIGNEE_ONLY,
  blocksAssignee,
  CLOSED_TASK_STATES,
  formatTaskNumber,
  isClosedTaskState,
  isOpenTaskState,
  LEGACY_TASK_STATES,
  OPEN_TASK_STATES,
  parseTaskId,
  parseTaskNumber,
  remapLegacyTaskState,
  reviewerKey,
  seatNodeId,
  reachExempt,
  TASK_REFUSAL_REASON,
  taskNodeId,
  taskRefusal,
  TASK_STATES,
  taskNumber,
  type SeatNodeId,
  type TaskCommandKind,
  type TaskId,
  type TaskNodeId,
  type TaskNumber,
  type TaskCore,
  type TaskRefusalKind,
  type TaskState,
} from "../src/shared/task-model";
import { RefusalReason } from "../src/shared/resource-command";

describe("task model", () => {
  it("splits every state into open, closed or backlog, once each", () => {
    for (const state of TASK_STATES) {
      const kinds = [isOpenTaskState(state), isClosedTaskState(state), state === "backlog"].filter(Boolean);
      expect(kinds, state).toHaveLength(1);
    }
    expect(OPEN_TASK_STATES.length + CLOSED_TASK_STATES.length + 1).toBe(TASK_STATES.length);
  });

  it("blocks the assignee only while it waits for input", () => {
    expect(TASK_STATES.filter(blocksAssignee)).toEqual(["input-required"]);
  });

  it("lets only the assignee start, pause, resume and finish", () => {
    const only = (Object.keys(ASSIGNEE_ONLY) as TaskCommandKind[]).filter((kind) => ASSIGNEE_ONLY[kind]);
    expect(only.sort()).toEqual(["finish", "pause", "resume", "start"]);
  });

  it("sends every task refusal under one of the shared wire reasons", () => {
    for (const reason of Object.values(TASK_REFUSAL_REASON)) expect(RefusalReason.literals).toContain(reason);
    expect(taskRefusal({ kind: "stale-epoch", expected: 3 })).toEqual({
      reason: "stale",
      detail: { kind: "stale-epoch", expected: 3 },
    });
  });

  it("exempts only the assignee's own transitions on its open task from reach", () => {
    const seat = seatNodeId(asNodeId("agent-1"));
    const other = seatNodeId(asNodeId("agent-2"));
    const task = (state: TaskCore["state"]): Pick<TaskCore, "state" | "assignee"> => ({ state, assignee: seat });
    expect(reachExempt(task("working"), { kind: "seat", seat }, { kind: "finish" })).toBe(true);
    expect(reachExempt(task("working"), { kind: "seat", seat }, { kind: "cancel" })).toBe(false);
    expect(reachExempt(task("working"), { kind: "seat", seat: other }, { kind: "finish" })).toBe(false);
    expect(reachExempt(task("done"), { kind: "seat", seat }, { kind: "start" })).toBe(false);
    expect(reachExempt(task("working"), { kind: "operator" }, { kind: "finish" })).toBe(false);
    void taskNodeId;
  });

  it("reads and writes task numbers as people type them", () => {
    const n = taskNumber(42)!;
    expect(formatTaskNumber(n)).toBe("T-42");
    expect(parseTaskNumber("T-42")).toBe(42);
    expect(parseTaskNumber(" t-7 ")).toBe(7);
    expect(parseTaskNumber("42")).toBe(42);
    for (const bad of ["T-0", "T-", "T-4.2", "-3", "T42x", ""]) expect(parseTaskNumber(bad), bad).toBeUndefined();
    expect(taskNumber(0)).toBeUndefined();
    expect(taskNumber(1.5)).toBeUndefined();
  });

  it("accepts only ULIDs as task ids", () => {
    expect(parseTaskId("01M5ETKKW2KX682NBXQZYA69MY")).toBe("01M5ETKKW2KX682NBXQZYA69MY");
    expect(parseTaskId("01m5etkkw2kx682nbxqzya69my")).toBeUndefined();
    expect(parseTaskId("T-42")).toBeUndefined();
  });

  it("keys reviewers so the operator and a seat never collide", () => {
    expect(reviewerKey({ kind: "operator" })).toBe("operator");
    expect(reviewerKey({ kind: "seat", seat: seatNodeId(asNodeId("operator")) })).toBe("seat:operator");
  });

  it("remaps every stored state", () => {
    const remapped = Object.fromEntries(
      LEGACY_TASK_STATES.map((state) => [state, [remapLegacyTaskState(state, false), remapLegacyTaskState(state, true)]]),
    );
    expect(remapped).toEqual({
      submitted: ["backlog", "assigned"],
      working: ["working", "working"],
      "input-required": ["input-required", "input-required"],
      completed: ["done", "done"],
      canceled: ["canceled", "canceled"],
      failed: ["canceled", "canceled"],
      rejected: ["canceled", "canceled"],
      "auth-required": ["input-required", "input-required"],
      archived: ["archived", "archived"],
    });
  });
});

describe("task model types", () => {
  it("closes the contract at compile time", () => {
    const seat = seatNodeId(asNodeId("agent-1"));
    const asTaskNode = (id: TaskNodeId) => id;
    // @ts-expect-error: a seat is not a task node.
    asTaskNode(seat);
    const asSeat = (id: SeatNodeId) => id;
    // @ts-expect-error: a bare node id is not a seat until checked.
    asSeat(asNodeId("agent-1"));
    const asTaskId = (id: TaskId) => id;
    // @ts-expect-error: a string is not a task id until parsed.
    asTaskId("01M5ETKKW2KX682NBXQZYA69MY");
    const asNumber = (n: TaskNumber) => n;
    // @ts-expect-error: a number is not a task number until checked.
    asNumber(42);
    // @ts-expect-error: the old states are gone from the model.
    const old: TaskState = "submitted";
    void old;
    expectTypeOf<keyof typeof TASK_REFUSAL_REASON>().toEqualTypeOf<TaskRefusalKind>();
    expectTypeOf<keyof typeof ASSIGNEE_ONLY>().toEqualTypeOf<TaskCommandKind>();
  });
});
