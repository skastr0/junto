import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { automationMailId, conditionHolds, performAction, type ConditionView } from "../src/main/junto/automation/live";
import { type Automation, AutomationId, AutomationVersion, FiringId } from "../src/shared/automation";
import type { Canvas } from "../src/shared/model";
import { asNodeId } from "../src/shared/physics/schema";

describe("automationMailId", () => {
  const firing = FiringId.make("01M5ESKJFC1A88R1MH1NEZWJ30");

  it("is a ULID with the firing's time, the same for the same firing and action", () => {
    const id = automationMailId(firing, 0);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(id.slice(0, 10)).toBe(firing.slice(0, 10));
    expect(automationMailId(firing, 0)).toBe(id);
  });

  it("differs per action and per firing", () => {
    expect(automationMailId(firing, 1)).not.toBe(automationMailId(firing, 0));
    expect(automationMailId(FiringId.make("01M5ESKJFC1A88R1MH1NEZWJ31"), 0)).not.toBe(automationMailId(firing, 0));
  });
});

describe("performAction", () => {
  const firing = FiringId.make("01M5ESKJFC1A88R1MH1NEZWJ30");
  const automation: Automation = {
    automationId: AutomationId.make("01M5ESKJFC1A88R1MH1NEZWJ2Q"),
    nodeId: asNodeId("automations-1"),
    author: { kind: "operator" },
    version: AutomationVersion.make(1),
    name: "Standup",
    enabled: true,
    trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" },
    then: [],
    limits: { minIntervalMs: 60_000, maxPerHour: 12 },
  };
  const perform = (action: Automation["then"][number], canvas = { nodes: new Map(), wires: new Map() } as unknown as Canvas) =>
    Effect.runPromise(performAction(Option.none(), Option.none(), canvas, "factory", automation, action, 0, firing));

  it("rules a comment on a page that is not on the canvas refused unknown_target, never applied", async () => {
    expect(await perform({ kind: "comment", on: { kind: "page", nodeId: asNodeId("gone") }, text: "Status?" })).toEqual({
      index: 0,
      ruling: "refused",
      reason: "unknown_target",
    });
  });

  it("rules a comment on a place in the resource, and mail without the work service, not_available", async () => {
    expect(
      await perform({ kind: "comment", on: { kind: "page", nodeId: asNodeId("p") }, anchor: { kind: "cells", range: "A1" }, text: "x" }),
    ).toMatchObject({ ruling: "refused", reason: "not_available" });
    expect(await perform({ kind: "mail", to: { kind: "seat", nodeId: asNodeId("agent-a") }, text: "Plan?" })).toMatchObject({
      ruling: "refused",
      reason: "not_available",
    });
  });

  it("rules create-task and assign-task not_available until their ports land", async () => {
    expect(await perform({ kind: "create-task", on: { kind: "task", nodeId: asNodeId("t") }, title: "x" } as never)).toMatchObject({
      reason: "not_available",
    });
  });
});

describe("conditionHolds", () => {
  const tasks: ConditionView = {
    tasks: [
      { taskId: "01M5ESKJFC1A88R1MH1NEZWJ50", node: "tasks-1", state: "working" },
      { taskId: "01M5ESKJFC1A88R1MH1NEZWJ51", node: "tasks-1", state: "backlog" },
    ],
    seatTasks: { "agent-busy": { blocked: false }, "agent-waiting": { blocked: true } },
    seatOnCanvas: (seat) => seat !== "agent-left",
  };
  const onTask = (taskId: string, becomes: string) =>
    ({ kind: "task", task: { kind: "task", nodeId: asNodeId("tasks-1"), taskId }, becomes, holds: true }) as never;
  const onNode = (node: string, becomes: string) => ({ kind: "task", task: { node: asNodeId(node) }, becomes, holds: true }) as never;

  it("holds for a named task in that state, and not in another", () => {
    expect(conditionHolds(onTask("01M5ESKJFC1A88R1MH1NEZWJ50", "working"), tasks)).toBe(true);
    expect(conditionHolds(onTask("01M5ESKJFC1A88R1MH1NEZWJ50", "backlog"), tasks)).toBe(false);
    expect(conditionHolds(onTask("01M5ESKJFC1A88R1MH1NEZWJ59", "working"), tasks)).toBe(false);
  });

  it("holds for a node when any task on it is in that state", () => {
    expect(conditionHolds(onNode("tasks-1", "backlog"), tasks)).toBe(true);
    expect(conditionHolds(onNode("tasks-1", "assigned"), tasks)).toBe(false);
    expect(conditionHolds(onNode("tasks-2", "working"), tasks)).toBe(false);
  });

  it("reads a seat's state from the task it holds", () => {
    const seat = (nodeId: string, becomes: string) =>
      conditionHolds({ kind: "seat", seat: { kind: "seat", nodeId: asNodeId(nodeId) }, becomes, holds: true } as never, tasks);
    expect(seat("agent-free", "idle")).toBe(true);
    expect(seat("agent-busy", "working")).toBe(true);
    expect(seat("agent-waiting", "attention")).toBe(true);
    expect(seat("agent-left", "gone")).toBe(true);
    expect(seat("agent-busy", "idle")).toBe(false);
  });
});
