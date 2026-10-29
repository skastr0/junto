import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { performAction } from "../src/main/junto/automation/live";
import { changeMatches, type ChangeEvent } from "../src/main/junto/automation/plan";
import { firedValue } from "../src/main/junto/automation/values";
import type { WorkServiceShape } from "../src/main/junto/work/service";
import {
  actionRefusal,
  type Automation,
  AutomationId,
  AutomationVersion,
  automationValuesOf,
  FiringId,
  resolveValues,
  valueNamesIn,
  valueRefusal,
} from "../src/shared/automation";
import { readMailExtension } from "../src/shared/crew";
import type { Canvas } from "../src/shared/model";
import { asNodeId } from "../src/shared/physics/schema";
import type { TaskView } from "../src/shared/task-model";
import { ItemId } from "../src/shared/work-ids";

const BOARD = asNodeId("tasks-release");
const TASK = ItemId.make("01M5ESKJFC1A88R1MH1NEZWJ50");
const taskDone: ChangeEvent = { kind: "task", key: "k", nodeId: BOARD, taskId: TASK, becomes: "done", byAutomation: false };
const onTaskDone = { kind: "change", on: { kind: "task", task: { node: BOARD }, becomes: "done" } } as const;

describe("automation values", () => {
  it("each trigger carries its own values, and fired.at everywhere", () => {
    expect(automationValuesOf(onTaskDone)).toEqual(["task.title", "task.state", "task.link", "task.assignee", "board.title", "fired.at"]);
    expect(automationValuesOf({ kind: "poll", everyMs: 60_000 })).toEqual(["fired.at"]);
    expect(automationValuesOf({ kind: "change", on: { kind: "signal", signal: "blocked" } })).toEqual([
      "signal.kind",
      "signal.from",
      "signal.text",
      "fired.at",
    ]);
  });

  it("reads only {{word.word}} as a value; anything else in braces is text", () => {
    expect(valueNamesIn("{{task.title}} by {{ task.assignee }}, {{x}}, {{task.title}}")).toEqual(["task.title", "task.title"]);
  });

  it("resolves in one pass, so a value holding a token is never read again", () => {
    const said = resolveValues("Done: {{task.title}} ({{task.state}}) {{nope.name}}", (name) =>
      name === "task.title" ? "fix {{task.state}}" : "done");
    expect(said).toBe("Done: fix {{task.state}} (done) {{nope.name}}");
  });

  it("refuses at save a value the trigger does not carry, naming the ones it does", () => {
    const mail = (text: string) => ({ kind: "mail", to: { kind: "seat", nodeId: asNodeId("agent-a") }, text }) as const;
    expect(valueRefusal({ trigger: onTaskDone, then: [mail("{{task.title}} at {{fired.at}}")] })).toBeUndefined();
    expect(valueRefusal({ trigger: { kind: "poll", everyMs: 60_000 }, then: [mail("{{task.title}}")] })).toEqual({
      reason: "invalid_input",
      message: "this trigger carries no {{task.title}}",
      next_step: "Name only the values it carries: {{fired.at}}",
    });
    // A new task's title is a text an action writes too.
    expect(
      valueRefusal({ trigger: onTaskDone, then: [{ kind: "create-task", node: BOARD, title: "Check {{artifact.title}}" }] }),
    ).toMatchObject({ reason: "invalid_input", message: "this trigger carries no {{artifact.title}}" });
  });

  it("refuses at save a prompt to anything but a seat", () => {
    expect(actionRefusal({ kind: "prompt", to: { kind: "seat", nodeId: asNodeId("agent-a") }, text: "go" })).toBeUndefined();
    expect(actionRefusal({ kind: "prompt", to: { kind: "page", nodeId: asNodeId("p") }, text: "go" })).toMatchObject({
      reason: "invalid_input",
    });
  });

  it("says a task change's values from the task it read, and leaves what the firing lacks unsaid", () => {
    const task = { title: "Ship the parser", current: { state: "done", node: BOARD } } as unknown as TaskView;
    const say = (name: Parameters<typeof firedValue>[0], event?: ChangeEvent) =>
      firedValue(name, { event, at: Date.UTC(2026, 9, 28, 12) }, { task }, undefined, "factory");
    expect(say("task.title", taskDone)).toBe("Ship the parser");
    expect(say("task.state", taskDone)).toBe("done");
    expect(say("task.assignee", taskDone)).toBe("unassigned");
    expect(say("task.link", taskDone)).toMatch(/^\[Ship the parser\]\(.+\)$/);
    expect(say("fired.at")).toBe("2026-10-28T12:00:00.000Z");
    // A run of a change automation has no change to say.
    expect(say("task.title")).toBeUndefined();
    expect(say("signal.text", { kind: "signal", key: "s", seat: asNodeId("agent-a"), signal: "blocked", text: "stuck" })).toBe("stuck");
  });
});

describe("an artifact watch on a node", () => {
  it("fires for any artifact in that Artifacts node, never another node's or an automation's", () => {
    const watch = { kind: "artifact", artifact: { node: asNodeId("artifacts-1") }, event: "edited" } as const;
    const edited = (nodeId: string, byAutomation = false): ChangeEvent => ({
      kind: "artifact",
      key: "a",
      nodeId: asNodeId(nodeId),
      artifactId: ItemId.make("01M5ESKJFC1A88R1MH1NEZWJ51"),
      event: "edited",
      labels: [],
      gained: [],
      byAutomation,
    });
    expect(changeMatches(watch, edited("artifacts-1"), new Set())).toBe(true);
    expect(changeMatches(watch, edited("artifacts-2"), new Set())).toBe(false);
    expect(changeMatches(watch, edited("artifacts-1", true), new Set())).toBe(false);
  });

  it("sees an artifact by the node it is on when it fires: a moved one leaves the old node's watch for the new one's, and a watch on it follows it (0.11.1, 10)", () => {
    const DOC = ItemId.make("01M5ESKJFC1A88R1MH1NEZWJ51");
    const editedOn = (nodeId: string): ChangeEvent => ({ kind: "artifact", key: "a", nodeId: asNodeId(nodeId), artifactId: DOC, event: "edited", labels: [], gained: [], byAutomation: false });
    const onOld = { kind: "artifact", artifact: { node: asNodeId("artifacts-1") }, event: "edited" } as const;
    const onNew = { kind: "artifact", artifact: { node: asNodeId("artifacts-2") }, event: "edited" } as const;
    const onIt = { kind: "artifact", artifact: { kind: "artifact", nodeId: asNodeId("artifacts-1"), artifactId: DOC }, event: "edited" } as const;
    // After the move its edits come from artifacts-2.
    expect(changeMatches(onOld, editedOn("artifacts-2"), new Set())).toBe(false);
    expect(changeMatches(onNew, editedOn("artifacts-2"), new Set())).toBe(true);
    expect(changeMatches(onIt as never, editedOn("artifacts-2"), new Set())).toBe(true);
  });

  it("with a label: an edit to one carrying it, or the label gained, one under it included", () => {
    const node = { node: asNodeId("artifacts-1") };
    const change = (event: "edited" | "labelled", labels: ReadonlyArray<string>, gained: ReadonlyArray<string>): ChangeEvent => ({
      kind: "artifact",
      key: "a",
      nodeId: asNodeId("artifacts-1"),
      artifactId: ItemId.make("01M5ESKJFC1A88R1MH1NEZWJ51"),
      event,
      labels: labels as never,
      gained: gained as never,
      byAutomation: false,
    });
    const editedPublish = { kind: "artifact", artifact: node, event: "edited", label: "publish" } as never;
    expect(changeMatches(editedPublish, change("edited", ["publish"], []), new Set())).toBe(true);
    expect(changeMatches(editedPublish, change("edited", ["draft"], []), new Set())).toBe(false);
    const gainsRelease = { kind: "artifact", artifact: node, event: "labelled", label: "release" } as never;
    expect(changeMatches(gainsRelease, change("labelled", ["release/1.2"], ["release/1.2"]), new Set())).toBe(true);
    expect(changeMatches(gainsRelease, change("labelled", ["release", "draft"], ["draft"]), new Set())).toBe(false);
    const gainsAny = { kind: "artifact", artifact: node, event: "labelled" } as never;
    expect(changeMatches(gainsAny, change("labelled", ["draft"], ["draft"]), new Set())).toBe(true);
  });
});

describe("the prompt action", () => {
  it("sends the seat a prompt with its values said, where mail sends a notice", async () => {
    const sent: Array<{ readonly text: string; readonly kind: string | undefined }> = [];
    const work = {
      workSubjectNotice: (_canvas: string, _node: string, message: { readonly parts: ReadonlyArray<{ readonly text?: string }>; readonly metadata?: unknown }) =>
        Effect.sync(() => {
          sent.push({ text: message.parts[0]?.text ?? "", kind: readMailExtension(message.metadata)?.mailKind });
          return { ok: true, data: { messageId: "m", written: true } };
        }),
    } as unknown as WorkServiceShape;
    const automation: Automation = {
      automationId: AutomationId.make("01M5ESKJFC1A88R1MH1NEZWJ2Q"),
      nodeId: asNodeId("automations-1"),
      author: { kind: "operator" },
      version: AutomationVersion.make(1),
      name: "Verify on done",
      enabled: true,
      trigger: onTaskDone,
      then: [],
      limits: { minIntervalMs: 60_000, maxPerHour: 12 },
    };
    const canvas = { nodes: new Map(), wires: new Map() } as unknown as Canvas;
    const to = { kind: "seat", nodeId: asNodeId("agent-verify") } as const;
    const resolve = (text: string) => Effect.succeed(resolveValues(text, () => "Ship the parser"));
    const firing = FiringId.make("01M5ESKJFC1A88R1MH1NEZWJ30");
    const perform = (action: Automation["then"][number]) =>
      Effect.runPromise(performAction(Option.some(work), Option.none(), canvas, "factory", automation, action, 0, firing, resolve));

    expect(await perform({ kind: "prompt", to, text: "{{task.title}} is done, check it" })).toEqual({ index: 0, ruling: "applied" });
    expect(await perform({ kind: "mail", to, text: "{{task.title}} is done" })).toEqual({ index: 0, ruling: "applied" });
    expect(sent).toEqual([
      { text: "Ship the parser is done, check it", kind: "prompt" },
      { text: "Ship the parser is done", kind: "notice" },
    ]);
  });
});
