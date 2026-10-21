import { Result, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { asNodeId } from "../src/shared/model";
import { refusalError, type ResourceCommand } from "../src/shared/resource-command";
import {
  RESOURCE_IPC_CHANNELS,
  TaskApplyInput,
  TaskCommandWire,
  taskCanvasFactsOf,
  taskEnvOf,
  taskRefusalOf,
} from "../src/shared/resource-ipc";
import { emptyTaskBoard, taskDomain } from "../src/shared/task-machine";
import { seatNodeId, taskNodeId, TaskCommandWire as ModelWire, type TaskCommand, type TaskCommandKind } from "../src/shared/task-model";
import { ItemId, OpId } from "../src/shared/work-ids";

const TASK = ItemId.make("01M5ESZPWMZZM3TZ88P6FVVK33");
const OTHER = ItemId.make("01M5ESZPWMZZM3TZ88P6FVVK34");
const OP = OpId.make("01M5ESZPWMZZM3TZ88P6FVVK35");
const decode = (input: unknown) => Schema.decodeUnknownResult(TaskCommandWire)(input, { onExcessProperty: "error" });

describe("the task command on the wire", () => {
  it("is the task model's own wire: every command the domain takes, and only those", () => {
    expectTypeOf<TaskCommand>().toExtend<TaskCommandWire>();
    expectTypeOf<TaskCommandWire["kind"]>().toEqualTypeOf<TaskCommandKind>();
    expect(TaskCommandWire).toBe(ModelWire);
  });

  it("keeps the model's bounds: a title, a stamp count", () => {
    for (const bad of [
      { kind: "create", taskId: TASK, title: "" },
      { kind: "create", taskId: TASK, title: "x".repeat(201) },
      { kind: "stamp-policy", required: -1 },
      { kind: "stamp-policy", required: 2.5 },
      { kind: "create", taskId: TASK, title: "Import", stampPolicy: { required: 17 } },
    ]) expect(Result.isFailure(decode(bad)), JSON.stringify(bad).slice(0, 60)).toBe(true);
  });

  it("decodes each kind, and refuses an unknown kind or an excess key", () => {
    const commands: ReadonlyArray<TaskCommand> = [
      { kind: "create", taskId: TASK, title: "Import", stampPolicy: { required: 1 } },
      { kind: "assign", seat: seatNodeId(asNodeId("S")) },
      { kind: "finish", next: taskNodeId(asNodeId("T2")) },
      { kind: "reviewer-add", reviewer: { kind: "operator" } },
      { kind: "stamp", verdict: "approve", text: "ok" },
      { kind: "archive" },
    ];
    for (const command of commands) expect(decode(command), command.kind).toEqual(Result.succeed(command));
    expect(Result.isFailure(decode({ kind: "explode" }))).toBe(true);
    expect(Result.isFailure(decode({ kind: "start", extra: 1 }))).toBe(true);
    expect(Result.isFailure(Schema.decodeUnknownResult(TaskApplyInput)({
      canvasName: "factory",
      nodeId: "T",
      taskId: TASK,
      opId: OP,
      command: { kind: "start", extra: 1 },
    }, { onExcessProperty: "error" }))).toBe(true);
    expect(Result.isFailure(Schema.decodeUnknownResult(TaskApplyInput)({
      canvasName: "factory",
      nodeId: "T",
      taskId: TASK,
      opId: OP,
      command: { kind: "start" },
      actor: { kind: "seat" },
    }))).toBe(true);
  });
});

describe("a refused task write", () => {
  it("gives the pane the domain's own refusal back", () => {
    const env = { at: 0, downstream: () => [], stampDefaultOf: () => ({ required: 0 }), seatReaches: () => true };
    const command: ResourceCommand<TaskCommand> = {
      opId: OP,
      canvasName: "factory",
      actor: { kind: "operator" },
      target: { kind: "task", nodeId: asNodeId("T"), itemId: OTHER },
      basis: null,
      after: [],
      op: { kind: "create", taskId: TASK, title: "Import" },
    };
    const verdict = taskDomain(env).rule(emptyTaskBoard(), command);
    expect(verdict.kind).toBe("refuse");
    if (verdict.kind === "refuse") {
      expect(taskRefusalOf(refusalError(verdict.refusal))).toEqual({
        reason: "invalid_input",
        detail: { kind: "target-mismatch", target: OTHER, taskId: TASK },
      });
      // A refusal before the domain names no task detail.
      expect(taskRefusalOf(refusalError({ reason: "not_in_reach", message: "out of reach" }))).toBeUndefined();
    }
  });
});

describe("the task ruling context as data", () => {
  it("answers as the env it was read from", () => {
    const [T1, T2, T3] = ["T1", "T2", "T3"].map((id) => taskNodeId(asNodeId(id))) as [ReturnType<typeof taskNodeId>, ReturnType<typeof taskNodeId>, ReturnType<typeof taskNodeId>];
    const S = seatNodeId(asNodeId("S"));
    const facts = taskCanvasFactsOf(
      {
        downstream: (node) => (node === T1 ? [T2, T3] : []),
        stampDefaultOf: (node) => ({ required: node === T2 ? 2 : 0 }),
        seatReaches: (_seat, node) => node !== T3,
      },
      [T1, T2, T3],
      [S],
    );
    const env = taskEnvOf(JSON.parse(JSON.stringify(facts)));
    expect(env.downstream(T1)).toEqual([T2, T3]);
    expect(env.stampDefaultOf(T2)).toEqual({ required: 2 });
    expect(env.seatReaches(S, T1)).toBe(true);
    expect(env.seatReaches(S, T3)).toBe(false);
    expect(env.seatReaches(seatNodeId(asNodeId("X")), T1)).toBe(false);
  });
});

describe("the channels", () => {
  it("are distinct", () => {
    const all = Object.values(RESOURCE_IPC_CHANNELS).flatMap((domain) => Object.values(domain));
    expect(new Set(all).size).toBe(all.length);
  });
});
