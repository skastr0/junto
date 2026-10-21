import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { automationMailId, changesBetween, conditionHolds, performAction, signalChange, taskChangesOf, type ConditionView } from "../src/main/junto/automation/live";
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
      { taskId: "01M5ESKJFC1A88R1MH1NEZWJ50", node: "tasks-1", state: "working", since: 1 },
      { taskId: "01M5ESKJFC1A88R1MH1NEZWJ51", node: "tasks-1", state: "backlog", since: 1 },
    ],
    seatTasks: { "agent-busy": { blocked: false }, "agent-waiting": { blocked: true } },
    seatOnCanvas: (seat) => seat !== "agent-left",
    seats: ["agent-free", "agent-busy", "agent-waiting"],
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

describe("taskChangesOf", () => {
  const T = "01M5ESKJFC1A88R1MH1NEZWJ50";
  const ruling = (opId: string, became: string, byAutomation = false) => ({ opId, taskId: T, node: "tasks-1", became, byAutomation });

  it("says one change per ruling, in order, keyed by its op, so working then done says both", () => {
    expect(taskChangesOf([ruling("01M5ESKJFC1A88R1MH1NEZWJ60", "working"), ruling("01M5ESKJFC1A88R1MH1NEZWJ61", "done")])).toEqual([
      { kind: "task", key: `task:${T}:working:01M5ESKJFC1A88R1MH1NEZWJ60`, nodeId: "tasks-1", taskId: T, becomes: "working", byAutomation: false },
      { kind: "task", key: `task:${T}:done:01M5ESKJFC1A88R1MH1NEZWJ61`, nodeId: "tasks-1", taskId: T, becomes: "done", byAutomation: false },
    ]);
  });

  it("marks a ruling on an automation's command, so no automation fires on it", () => {
    expect(taskChangesOf([ruling("01M5ESKJFC1A88R1MH1NEZWJ60", "backlog", true)])).toMatchObject([{ byAutomation: true }]);
  });
});

describe("changesBetween", () => {
  const view = (tasks: ConditionView["tasks"], seatTasks: ConditionView["seatTasks"] = {}, seats = ["agent-a"]): ConditionView => ({
    tasks,
    seatTasks,
    seatOnCanvas: (seat) => seats.includes(seat),
    seats,
  });
  it("fires nothing on the first pass: it is the baseline", () => {
    expect(changesBetween(undefined, view([], { "agent-a": { blocked: false, since: 7 } }))).toEqual([]);
  });

  it("says no task change: task changes are rulings, never a diff of two snapshots", () => {
    const T = "01M5ESKJFC1A88R1MH1NEZWJ50";
    expect(changesBetween(view([]), view([{ taskId: T, node: "tasks-1", state: "backlog", since: 5 }]))).toEqual([]);
  });

  it("says a seat that started working, waits, and left", () => {
    const idle = view([]);
    const working = view([], { "agent-a": { blocked: false, since: 7 } });
    const waiting = view([], { "agent-a": { blocked: true, since: 9 } });
    const gone = view([], {}, []);
    expect(changesBetween(idle, working)).toEqual([{ kind: "seat", key: "seat:agent-a:working:7", seat: "agent-a", becomes: "working" }]);
    expect(changesBetween(working, waiting)).toMatchObject([{ becomes: "attention" }]);
    expect(changesBetween(idle, gone)).toMatchObject([{ seat: "agent-a", becomes: "gone" }]);
  });

  it("says no seat change when the runtime seat-state source says them", () => {
    expect(changesBetween(view([]), view([], { "agent-a": { blocked: false, since: 7 } }), false)).toEqual([]);
  });
});

describe("changesBetween, artifacts", () => {
  const view = (artifacts: ConditionView["artifacts"]): ConditionView => ({ tasks: [], seatTasks: {}, seatOnCanvas: () => false, seats: [], artifacts });
  const A = "01M5ESKJFC1A88R1MH1NEZWJ70";

  it("says an edit when a known artifact's head moves, and nothing for a new one", () => {
    const one = view([{ artifactId: A, node: "artifacts-1", version: 1 }]);
    const two = view([{ artifactId: A, node: "artifacts-1", version: 2 }]);
    expect(changesBetween(view([]), one)).toEqual([]);
    expect(changesBetween(one, two)).toEqual([
      { kind: "artifact", key: `artifact:${A}:edited:2`, nodeId: "artifacts-1", artifactId: A, event: "edited", byAutomation: false },
    ]);
  });
});

describe("signalChange", () => {
  it("hears a signal when it is raised, keyed by its id, and never when it closes", () => {
    const raised = { signalId: "sig-1", nodeId: "agent-a", kind: "blocked", state: "open" } as const;
    expect(signalChange(raised)).toEqual({ kind: "signal", key: "signal:sig-1", seat: "agent-a", signal: "blocked" });
    expect(signalChange({ ...raised, state: "answered" })).toBeUndefined();
    expect(signalChange({ ...raised, state: "withdrawn" })).toBeUndefined();
  });
});

describe("changesBetween, comments", () => {
  const view = (comments: ConditionView["comments"]): ConditionView => ({ tasks: [], seatTasks: {}, seatOnCanvas: () => false, seats: [], comments });
  const A = "01M5ESKJFC1A88R1MH1NEZWJ70";
  const old = { messageId: "01M5ESKJFC1A88R1MH1NEZWJ80", artifactId: A, node: "artifacts-1", byAutomation: false };
  const fresh = { ...old, messageId: "01M5ESKJFC1A88R1MH1NEZWJ81" };

  it("says a comment the pass before did not hold, once, and none of the old ones", () => {
    expect(changesBetween(view([old]), view([old, fresh]))).toEqual([
      { kind: "artifact", key: `artifact:${A}:commented:${fresh.messageId}`, nodeId: "artifacts-1", artifactId: A, event: "commented", byAutomation: false },
    ]);
    expect(changesBetween(view([old, fresh]), view([old, fresh]))).toEqual([]);
  });

  it("marks a comment an automation posted, so no automation fires on it", () => {
    expect(changesBetween(view([]), view([{ ...fresh, byAutomation: true }]))).toMatchObject([{ byAutomation: true }]);
  });
});
