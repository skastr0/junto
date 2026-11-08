import { Result, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { asNodeId } from "../src/shared/model";
import {
  ASSIGNEE_ONLY,
  checkTaskCommand,
  TaskCommandWire,
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

  it("lets only the assignee start, pause, resume, check and finish", () => {
    const only = (Object.keys(ASSIGNEE_ONLY) as TaskCommandKind[]).filter((kind) => ASSIGNEE_ONLY[kind]);
    expect(only.sort()).toEqual(["check", "finish", "pause", "resume", "start"]);
  });

  it("sends every task refusal under one of the shared wire reasons", () => {
    for (const reason of Object.values(TASK_REFUSAL_REASON)) expect(RefusalReason.literals).toContain(reason);
    expect(taskRefusal({ kind: "stale-epoch", expected: 3 })).toEqual({
      reason: "stale",
      detail: { kind: "stale-epoch", expected: 3 },
    });
    expect(taskRefusal({ kind: "not-in-reach", nodeId: asNodeId("task-9") }).reason).toBe("not_in_reach");
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
    expect(formatTaskNumber(n)).toBe("#42");
    expect(parseTaskNumber("#42")).toBe(42);
    expect(parseTaskNumber(" #7 ")).toBe(7);
    expect(parseTaskNumber("42")).toBe(42);
    for (const bad of ["#0", "#", "#4.2", "-3", "T-42", "42x", ""]) expect(parseTaskNumber(bad), bad).toBeUndefined();
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

  it("never remaps a row to an open state with nobody to move it", () => {
    for (const state of LEGACY_TASK_STATES) expect(isOpenTaskState(remapLegacyTaskState(state, false)), state).toBe(false);
  });

  it("remaps every stored state", () => {
    const remapped = Object.fromEntries(
      LEGACY_TASK_STATES.map((state) => [state, [remapLegacyTaskState(state, false), remapLegacyTaskState(state, true)]]),
    );
    expect(remapped).toEqual({
      submitted: ["backlog", "assigned"],
      working: ["backlog", "working"],
      "input-required": ["backlog", "input-required"],
      completed: ["done", "done"],
      canceled: ["canceled", "canceled"],
      failed: ["canceled", "canceled"],
      rejected: ["canceled", "canceled"],
      "auth-required": ["backlog", "input-required"],
      archived: ["archived", "archived"],
    });
  });
});

describe("task command wire", () => {
  const decode = Schema.decodeUnknownResult(TaskCommandWire, { onExcessProperty: "error" });
  const kinds = new Map<string, "agent" | "task" | "region">([["agent-1", "agent"], ["task-2", "task"], ["region-3", "region"]]);
  const kindOf = (id: string) => kinds.get(id);

  it("decodes a finish's handoff note up to 4096 characters, and refuses an empty or longer one", () => {
    expect(Result.isSuccess(decode({ kind: "finish", handoff: "x".repeat(4096) }))).toBe(true);
    expect(Result.isFailure(decode({ kind: "finish", handoff: "x".repeat(4097) }))).toBe(true);
    expect(Result.isFailure(decode({ kind: "finish", handoff: "" }))).toBe(true);
  });

  it("decodes a create with a caller-minted id and refuses an empty title or an extra key", () => {
    expect(Result.isSuccess(decode({ kind: "create", taskId: "01M5ETKKW2KX682NBXQZYA69MY", title: "Fix tabs" }))).toBe(true);
    expect(Result.isFailure(decode({ kind: "create", taskId: "01M5ETKKW2KX682NBXQZYA69MY", title: "" }))).toBe(true);
    expect(Result.isFailure(decode({ kind: "start", by: "me" }))).toBe(true);
    expect(Result.isFailure(decode({ kind: "stamp-policy", required: 17 }))).toBe(true);
  });

  it("narrows seats and next nodes against the canvas, refusing the wrong kind", () => {
    const assign = Result.getOrThrow(decode({ kind: "assign", seat: "agent-1" }));
    expect(checkTaskCommand(assign, kindOf)).toEqual({ ok: true, command: { kind: "assign", seat: "agent-1" } });
    const wrong = Result.getOrThrow(decode({ kind: "assign", seat: "region-3" }));
    expect(checkTaskCommand(wrong, kindOf)).toEqual({
      ok: false,
      refusal: { reason: "invalid_input", detail: { kind: "wrong-node", nodeId: "region-3", expected: "agent" } },
    });
    const next = Result.getOrThrow(decode({ kind: "finish", next: "agent-1" }));
    expect(checkTaskCommand(next, kindOf).ok).toBe(false);
    const evidence = { artifacts: [], claims: [{ ruleId: "r1", text: "Tests pass" }] };
    const answered = Result.getOrThrow(decode({ kind: "finish", next: "task-2", evidence }));
    expect(checkTaskCommand(answered, kindOf)).toEqual({ ok: true, command: { kind: "finish", next: "task-2", evidence } });
    expect(Result.isFailure(decode({ kind: "finish", evidence: { claims: [] } }))).toBe(true);
    const operator = Result.getOrThrow(decode({ kind: "reviewer-add", reviewer: { kind: "operator" } }));
    expect(checkTaskCommand(operator, kindOf)).toEqual({ ok: true, command: { kind: "reviewer-add", reviewer: { kind: "operator" } } });
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
