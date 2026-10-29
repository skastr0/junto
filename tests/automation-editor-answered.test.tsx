// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asCanvasName } from "../src/shared/model";
import { AutomationVersion, DEFAULT_AUTOMATION_LIMITS, formatProblem, VALUE_FORMATS, type Automation, type AutomationId } from "../src/shared/automation";
import { AUTOMATION_SIGNALS_ENABLED } from "../src/shared/features";
import { asNodeId } from "../src/shared/physics/schema";
import { AutomationEditor } from "../src/renderer/components/automations/AutomationEditor";
import {
  FORMAT_CHOICES,
  VALUE_FORMAT_KINDS,
  answeringAutomations,
  draftProblems,
  finishDraft,
  formatChoiceKind,
  mintStepId,
  newAnsweredDraft,
  newDraft,
  raisedValuesOf,
  triggerWords,
  valueWords,
  withFormat,
  withStepId,
  type ActionDraft,
  type AutomationDraft,
  type NameOf,
  type TriggerDraft,
} from "../src/renderer/lib/automation-editor";
import { modelStore } from "../src/renderer/lib/use-model";
import { artifacts, automations } from "./support/model-nodes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CANVAS = "automation-answered";
const home = asNodeId("automations-1");
const shelf = asNodeId("shelf-1");
const seat = { kind: "seat", nodeId: asNodeId("agent-a") } as const;
const nameOf: NameOf = (ref) => (!("kind" in ref) ? ref.node : ref.kind === "seat" ? `@${ref.nodeId}` : `#${ref.nodeId}`);
const raisingId = "01M62A1X7ABVZ8RQ15RJWCR84A" as AutomationId;
const answeringId = "01M62A1X7ABVZ8RQ15RJWCR84B" as AutomationId;
const schedule: TriggerDraft = { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" };

const draftWith = (trigger: TriggerDraft, then: ReadonlyArray<ActionDraft>, automationId: AutomationId = raisingId): AutomationDraft => ({
  ...newDraft(automationId, home, { kind: "operator" }, "UTC"),
  name: "Daily review",
  trigger,
  then,
  thenKeys: then.map((_, index) => `k${index}`),
});

const stored = (draft: AutomationDraft, more: Partial<Automation> = {}): Automation => {
  const finished = finishDraft(draft);
  if (!finished.ok) throw new Error(finished.problems.map((problem) => problem.message).join(" "));
  return {
    automationId: draft.automationId,
    nodeId: draft.nodeId,
    author: draft.author,
    version: AutomationVersion.make(1),
    enabled: false,
    ...finished.definition,
    limits: DEFAULT_AUTOMATION_LIMITS,
    ...more,
  };
};

const actionProblem = (draft: AutomationDraft): string | undefined => draftProblems(draft).find((problem) => problem.at === "action")?.message;

const onAnswered = (step?: string, signal?: "escalate" | "blocked" | "feedback"): TriggerDraft => ({
  kind: "change",
  on: {
    kind: "answered",
    automation: { node: home, automationId: raisingId },
    ...(step === undefined ? {} : { step }),
    ...(signal === undefined ? {} : { signal }),
  },
});

describe("answered back, the draft", () => {
  it("a step id is minted from the signal's title, values left out, and once only", () => {
    const draft = draftWith(schedule, [
      { kind: "signal", signal: "escalate", title: "Review {{fired.at|date:YYYY-MM-DD}} draft!" },
      { kind: "signal", signal: "blocked", id: "review-draft", title: "Other" },
      { kind: "signal", signal: "feedback", title: "{{fired.at}}" },
    ]);
    // Taken by the second step, so the first gets a number.
    expect(mintStepId(draft, 0)).toBe("review-draft-2");
    // A title with no words is "signal".
    expect(mintStepId(draft, 2)).toBe("signal");
    // A step that has one keeps it, and the draft is the same draft.
    const kept = withStepId(draft, 1);
    expect(kept?.id).toBe("review-draft");
    expect(kept?.draft).toBe(draft);
    const named = withStepId(draft, 0);
    expect(named?.draft.then[0]).toMatchObject({ id: "review-draft-2" });
    expect(withStepId(draftWith(schedule, [{ kind: "mail", to: seat, text: "x" }]), 0)).toBeUndefined();
    // Always within the contract's bound.
    const long = draftWith(schedule, [{ kind: "signal", signal: "escalate", title: "a".repeat(80) }]);
    expect(mintStepId(long, 0)).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/);
  });

  it("When answered makes an automation on this node whose trigger names the step, and says which signal in its name", () => {
    const draft = newAnsweredDraft(answeringId, home, { kind: "operator" }, { node: home, automationId: raisingId }, "review", "Review the draft");
    expect(draft.trigger).toEqual({ kind: "change", on: { kind: "answered", automation: { node: home, automationId: raisingId }, step: "review" } });
    expect(draft.name).toBe('When "Review the draft" is answered');
    expect(draft.enabled).toBe(false);
    expect(draft.nodeId).toBe(home);
    const long = newAnsweredDraft(answeringId, home, { kind: "operator" }, { node: home, automationId: raisingId }, "review", "x".repeat(300));
    expect(long.name.length).toBeLessThanOrEqual(120);
    expect(long.name.endsWith('…" is answered')).toBe(true);
  });

  it("a signal step and the automations that run on its answer show as linked: by step, by kind, or any", () => {
    const raising = draftWith(schedule, [
      { kind: "signal", id: "review", signal: "escalate", title: "Review" },
      { kind: "signal", id: "deploy", signal: "blocked", title: "Deploy" },
      { kind: "signal", signal: "notice", title: "Done" },
    ]);
    const byStep = stored(draftWith(onAnswered("review"), [{ kind: "mail", to: seat, text: "{{answer.text}}" }], answeringId), { name: "By step" });
    const byKind = stored(draftWith(onAnswered(undefined, "blocked"), [{ kind: "mail", to: seat, text: "x" }], "01M62A1X7ABVZ8RQ15RJWCR84C" as AutomationId), {
      name: "By kind",
    });
    const any = stored(draftWith(onAnswered(), [{ kind: "mail", to: seat, text: "x" }], "01M62A1X7ABVZ8RQ15RJWCR84D" as AutomationId), { name: "Any" });
    const all = [stored(raising), byStep, byKind, any];
    const names = (index: number) => answeringAutomations(all, raising, index).map((automation) => automation.name);
    expect(names(0)).toEqual(["By step", "Any"]);
    expect(names(1)).toEqual(["By kind", "Any"]);
    // A notice is never answered, so nothing runs on it.
    expect(names(2)).toEqual([]);
  });

  it("an answered trigger names the automation it hears, in the list's words", () => {
    const named = (raising: { readonly node: string; readonly automationId: string }) => (raising.automationId === raisingId ? "Daily review" : undefined);
    expect(triggerWords(onAnswered("review"), nameOf, named)).toBe("when a signal from Daily review is answered");
    expect(triggerWords(onAnswered(undefined, "escalate"), nameOf, named)).toBe("when an escalation from Daily review is answered");
    expect(triggerWords(onAnswered(undefined, "blocked"), nameOf)).toBe("when a blocked signal from another automation is answered");
  });

  it("an answered trigger carries the raising firing's values; any other trigger refuses them", () => {
    const raising = stored(draftWith({ kind: "change", on: { kind: "task", task: { node: asNodeId("board-1") }, becomes: "done" } }, [
      { kind: "signal", id: "review", signal: "escalate", title: "Review {{task.title}}" },
    ]));
    expect(raisedValuesOf(raising)).toContain("raised.task.title");
    expect(raisedValuesOf(undefined)).toEqual([]);
    expect(valueWords("raised.task.title")).toBe("the task's title, as it was when the signal was raised");
    expect(valueWords("answer.text")).toBe("what the answer says");
    const mail = (text: string): ActionDraft => ({ kind: "mail", to: seat, text });
    expect(actionProblem(draftWith(onAnswered("review"), [mail("{{answer.text}} on {{raised.task.title}}")], answeringId))).toBeUndefined();
    expect(actionProblem(draftWith(schedule, [mail("{{raised.task.title}}")]))).toBe("This trigger carries no {{raised.task.title}}. It carries {{fired.at}}.");
  });

  it("a format the set does not hold is refused in main's own words, before the save", () => {
    const mail = (text: string): ActionDraft => ({ kind: "mail", to: seat, text });
    const refusal = formatProblem("{{fired.at|dat:YYYY}}")!;
    expect(actionProblem(draftWith(schedule, [mail("On {{fired.at|dat:YYYY}}")]))).toBe(`${refusal.message}. ${refusal.next_step}.`);
    expect(actionProblem(draftWith(schedule, [mail("On {{fired.at|date:YYYY-MM-DD}} {{fired.at|slug|upper}}")]))).toBeUndefined();
    expect(actionProblem(draftWith(schedule, [mail("On {{fired.at|date:QQ}}")]))).toContain("has a date pattern this cannot write");
  });

  it("Format value offers the whole closed set, each choice one the save takes", () => {
    for (const choice of FORMAT_CHOICES) expect(formatProblem(`{{fired.at|${choice.format}}}`)).toBeUndefined();
    const offered = new Set(FORMAT_CHOICES.map(formatChoiceKind));
    expect(VALUE_FORMAT_KINDS.length).toBe(VALUE_FORMATS.length);
    for (const kind of VALUE_FORMAT_KINDS) expect(offered.has(kind)).toBe(true);
  });

  it("a format goes on the value at the caret, else the last before it, else the first", () => {
    const text = "Review {{fired.at}} for {{task.title}}";
    // Caret just after the first value.
    expect(withFormat(text, 19, "date:YYYY-MM-DD")).toEqual({ text: "Review {{fired.at|date:YYYY-MM-DD}} for {{task.title}}", caret: 35 });
    // Caret inside the second.
    expect(withFormat(text, 30, "slug")?.text).toBe("Review {{fired.at}} for {{task.title|slug}}");
    // Caret at the end: the last before it.
    expect(withFormat(text, text.length, "upper")?.text).toBe("Review {{fired.at}} for {{task.title|upper}}");
    // Caret before any value: the first.
    expect(withFormat(text, 0, "lower")?.text).toBe("Review {{fired.at|lower}} for {{task.title}}");
    // A format after a format.
    expect(withFormat("{{fired.at|date:YYYY}}", 22, "trim")?.text).toBe("{{fired.at|date:YYYY|trim}}");
    expect(withFormat("no values", 3, "slug")).toBeUndefined();
  });

  it("where the answer goes says what it still needs, and finishes as the contract takes it", () => {
    const signal = (answerTo: NonNullable<Extract<ActionDraft, { kind: "signal" }>["answerTo"]>, kind: "escalate" | "notice" = "escalate"): ActionDraft => ({
      kind: "signal",
      signal: kind,
      title: "Review",
      answerTo,
    });
    expect(actionProblem(draftWith(schedule, [signal({ kind: "seat" })]))).toBe("Pick the seat the answer goes to.");
    expect(actionProblem(draftWith(schedule, [signal({ kind: "document", title: "x" })]))).toBe("Pick the Artifacts node the answer is written in.");
    expect(actionProblem(draftWith(schedule, [signal({ kind: "document", node: shelf, title: " " })]))).toBe("Write the answer document's title.");
    expect(actionProblem(draftWith(schedule, [signal({ kind: "document", node: shelf, title: "{{answer.at|dat:YYYY}}" })]))).toContain(
      "names an unknown format",
    );
    expect(actionProblem(draftWith(schedule, [signal({ kind: "append" })]))).toBe("Pick the artifact the answer is added to.");
    // A notice is read and cleared: where its answer goes asks nothing and is dropped.
    expect(actionProblem(draftWith(schedule, [signal({ kind: "seat" }, "notice")]))).toBeUndefined();

    const done = finishDraft(draftWith(schedule, [signal({ kind: "document", node: shelf, title: " Review {{answer.at|date:YYYY-MM-DD}} " })]));
    expect(done.ok && done.definition.then[0]).toEqual({
      kind: "signal",
      signal: "escalate",
      title: "Review",
      answerTo: { kind: "document", node: shelf, title: "Review {{answer.at|date:YYYY-MM-DD}}" },
    });
    const toSeat = finishDraft(draftWith(schedule, [signal({ kind: "seat", to: seat })]));
    expect(toSeat.ok && toSeat.definition.then[0]).toMatchObject({ answerTo: { kind: "seat", to: seat } });
  });
});

let host: HTMLDivElement;
let root: Root;
let release: () => void;

const render = async (draft: AutomationDraft, more: Partial<Parameters<typeof AutomationEditor>[0]> = {}): Promise<void> => {
  await act(async () =>
    root.render(
      <AutomationEditor
        draft={draft}
        onDraft={() => undefined}
        canvasName={CANVAS}
        saving={false}
        dirty={false}
        onSave={() => undefined}
        onRevert={() => undefined}
        {...more}
      />,
    ),
  );
};

const button = (text: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.includes(text));

describe("answered back, the form", () => {
  beforeEach(() => {
    release = modelStore.adopt({
      canvas: asCanvasName(CANVAS),
      seq: 0,
      wires: [],
      nodes: [automations("automations-1", { z: 0 }), artifacts("shelf-1", { x: 800, z: 1, label: "Specs" })],
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    release();
  });

  it("the kind picker offers a seat's kinds and a notice", async () => {
    await render(draftWith(schedule, [{ kind: "signal", signal: "blocked", title: "Deploy" }]));
    expect(host.querySelector('[aria-label="What the signal asks"]')?.textContent).toContain("Blocked, waiting on you");
  });

  it("a signal the operator answers asks where the answer goes; a notice asks nothing back", async () => {
    await render(draftWith(schedule, [{ kind: "signal", signal: "escalate", title: "Review", answerTo: { kind: "document", node: shelf, title: "Review" } }]));
    expect(host.querySelector('[aria-label="Where the answer goes"]')?.textContent).toContain("Answer becomes a document");
    expect(host.querySelector('[aria-label="Artifacts node for the answer"]')?.textContent).toContain("Specs");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Answer document title"]')?.value).toBe("Review");
    expect(host.querySelector('[aria-label="Insert value into the answer document\'s title"]')).not.toBeNull();

    await render(draftWith(schedule, [{ kind: "signal", signal: "notice", title: "Done" }]), { onWhenAnswered: () => undefined });
    expect(host.querySelector('[aria-label="Where the answer goes"]')).toBeNull();
    expect(button("When answered…")).toBeUndefined();
  });

  // Off with automation signals: the save refuses an answered watch, so nothing offers one.
  it.runIf(!AUTOMATION_SIGNALS_ENABLED)("When answered is not offered while automation signals are off", async () => {
    await render(draftWith(schedule, [{ kind: "signal", signal: "escalate", title: "Review" }]), { onWhenAnswered: () => undefined });
    expect(button("When answered…")).toBeUndefined();
  });

  it.runIf(AUTOMATION_SIGNALS_ENABLED)("When answered waits for a draft with nothing to fix, then hands the step up", async () => {
    const onWhenAnswered = vi.fn();
    await render(draftWith(schedule, [{ kind: "signal", signal: "escalate", title: " " }]), { onWhenAnswered });
    await act(async () => button("When answered…")!.click());
    expect(onWhenAnswered).not.toHaveBeenCalled();
    expect(host.querySelector(".automation-editor__problem")?.textContent).toBe("Write the signal title.");

    await render(draftWith(schedule, [{ kind: "mail", to: seat, text: "x" }, { kind: "signal", signal: "feedback", title: "Review" }]), { onWhenAnswered });
    const control = button("When answered…")!;
    // What it does beyond its name is said to a reader.
    const said = document.getElementById(control.getAttribute("aria-describedby")!);
    expect(said?.textContent).toBe("Saves this automation before opening the new one.");
    // Shown to everyone, not only said to a reader: the press commits the edits.
    expect(said?.classList.contains("automation-editor__note")).toBe(true);
    expect(said?.classList.contains("sr-only")).toBe(false);
    await act(async () => control.click());
    expect(onWhenAnswered).toHaveBeenCalledWith(1);
  });

  it.runIf(AUTOMATION_SIGNALS_ENABLED)("the two show as linked: the step names what runs on its answer, the trigger opens what raised it", async () => {
    const raising = draftWith(schedule, [{ kind: "signal", id: "review", signal: "escalate", title: "Review the draft" }]);
    const answering = draftWith(onAnswered("review"), [{ kind: "mail", to: seat, text: "{{answer.text}}" }], answeringId);
    const all = [stored(raising, { name: "Daily review" }), stored(answering, { name: "File the review" })];
    const onOpenAutomation = vi.fn();

    await render(raising, { automations: all, onOpenAutomation, onWhenAnswered: () => undefined });
    expect(host.querySelector('[aria-label="When answered"]')?.textContent).toContain("When answered, runs");
    await act(async () => button("File the review")!.click());
    expect(onOpenAutomation).toHaveBeenCalledWith(answeringId);
    expect(button("Another when answered…")).not.toBeUndefined();

    await render(answering, { automations: all, onOpenAutomation });
    expect(host.querySelector('[aria-label="What it watches"]')?.textContent).toContain("an automation's signal");
    expect(host.querySelector('[aria-label="Automation that raises it"]')?.textContent).toContain("Daily review");
    expect(host.querySelector('[aria-label="Which of its signals"]')?.textContent).toContain('the step "Review the draft"');
    expect(host.querySelector('[aria-label="Of which kind"]')?.textContent).toContain("of any kind");
    await act(async () => button("Open Daily review")!.click());
    expect(onOpenAutomation).toHaveBeenLastCalledWith(raisingId);
    // The raising firing's values are offered with the answer's.
    expect(host.querySelector('[aria-label="Insert value into the mail"]')).not.toBeNull();
  });

  it("Format value is off until the text holds a value", async () => {
    await render(draftWith(schedule, [{ kind: "mail", to: seat, text: "Plain words" }]));
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Format value in the mail"]')?.disabled).toBe(true);
    await render(draftWith(schedule, [{ kind: "mail", to: seat, text: "On {{fired.at}}" }]));
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Format value in the mail"]')?.disabled).toBe(false);
  });
});
