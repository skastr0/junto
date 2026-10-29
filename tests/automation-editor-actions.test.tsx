// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asCanvasName } from "../src/shared/model";
import { asNodeId } from "../src/shared/physics/schema";
import { ItemId } from "../src/shared/work-ids";
import { ActionText, type ValueChoice } from "../src/renderer/components/automations/ActionText";
import { AutomationEditor } from "../src/renderer/components/automations/AutomationEditor";
import {
  blankTrigger,
  cadenceWords,
  codeRulingWords,
  draftProblems,
  editDraft,
  finishDraft,
  firingWords,
  newDraft,
  signalRulingWords,
  signalAnswerOf,
  answerIsLong,
  type AutomationDraft,
} from "../src/renderer/lib/automation-editor";
import { automationValuesOf, type ActionRuling, type Firing } from "../src/shared/automation";
import type { AgentSignal } from "../src/shared/wire/agent-signals";
import { setTasksSource, makeLocalTasksSource } from "../src/renderer/lib/tasks-source";
import { modelStore } from "../src/renderer/lib/use-model";
import { automations } from "./support/model-nodes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no scrolling; the menu keeps its highlighted row in view.
Element.prototype.scrollIntoView = function scrollIntoView(): void {};

const id = ItemId.make("01JAAAAAAAAAAAAAAAAAAAAAA1");
const node = asNodeId("automations-1");
const CANVAS = "automation-actions";

const VALUES: ReadonlyArray<ValueChoice> = [
  { name: "seat.name", words: "the seat's name" },
  { name: "fired.at", words: "when it fired" },
];

let host: HTMLDivElement;
let root: Root;

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
};

/** A text that keeps what it is given, as the editor's draft does. */
function Harness({ initial = "" }: { readonly initial?: string }) {
  const [text, setText] = useState(initial);
  return <ActionText label="Mail text" noun="mail" value={text} onValue={setText} values={VALUES} placeholder="What the mail says" />;
}

const render = async (element: React.ReactElement): Promise<void> => {
  await act(async () => root.render(element));
  await flush();
};

const click = async (element: Element): Promise<void> => {
  await act(async () => {
    (element as HTMLElement).click();
  });
  await flush();
};

/** Type into a field as a keystroke would, caret placed by the test. */
const type = (field: HTMLTextAreaElement | HTMLInputElement, text: string, caret = text.length): void => {
  act(() => {
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, text);
    field.setSelectionRange(caret, caret);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("an action's text", () => {
  it("reads back over several lines, with Insert value beside it", async () => {
    await render(<Harness initial="Post your plan." />);
    expect(host.querySelector("textarea")?.value).toBe("Post your plan.");
    expect(host.querySelector("button[aria-label='Insert value into the mail']")).not.toBeNull();
  });

  it("lists the values it is given and writes one where the caret is", async () => {
    await render(<Harness initial="Hi !" />);
    const field = host.querySelector("textarea")!;
    act(() => {
      field.focus();
      field.setSelectionRange(3, 3);
    });

    await click(host.querySelector("button[aria-label='Insert value into the mail']")!);
    const options = [...document.querySelectorAll("[role='option']")].map((option) => option.textContent ?? "");
    expect(options).toEqual(["{{seat.name}}the seat's name", "{{fired.at}}when it fired"]);

    await click([...document.querySelectorAll("[role='option']")].find((option) => option.textContent?.includes("seat.name"))!);
    expect(field.value).toBe("Hi {{seat.name}}!");
    expect(field.selectionStart).toBe("Hi {{seat.name}}".length);
  });

  it("writes at the end of a text never focused, not at its start", async () => {
    await render(<Harness initial="Hi " />);
    // The field was never focused: a browser reports its selection at 0.
    await click(host.querySelector("button[aria-label='Insert value into the mail']")!);
    await click([...document.querySelectorAll("[role='option']")].find((option) => option.textContent?.includes("seat.name"))!);
    expect(host.querySelector("textarea")!.value).toBe("Hi {{seat.name}}");
  });

  it("replaces what is selected, as typing would", async () => {
    await render(<Harness initial="Say this." />);
    const field = host.querySelector("textarea")!;
    act(() => {
      field.focus();
      field.setSelectionRange(4, 8);
    });

    await click(host.querySelector("button[aria-label='Insert value into the mail']")!);
    await click([...document.querySelectorAll("[role='option']")].find((option) => option.textContent?.includes("fired.at"))!);
    expect(field.value).toBe("Say {{fired.at}}.");
  });

  it("opens and chooses from the keyboard, and leaves the keyboard in the text", async () => {
    await render(<Harness initial="Hi " />);
    const field = host.querySelector<HTMLTextAreaElement>("textarea")!;
    const trigger = host.querySelector<HTMLButtonElement>("button[aria-label='Insert value into the mail']")!;
    act(() => trigger.focus());
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    const list = document.querySelector<HTMLElement>("[role='listbox']")!;
    expect(list).not.toBeNull();
    // The open list holds the keyboard, so arrows reach it.
    expect(document.activeElement?.closest("[role='listbox']")).toBe(list);
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    expect(field.value).toBe("Hi {{fired.at}}");
    // The claim is the field, not just its caret: a broken claim would leave focus on the trigger.
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(field.value.length);
  });

  it("closes the list on Escape and hands the keyboard back to its trigger", async () => {
    await render(<Harness initial="Hi " />);
    const trigger = host.querySelector<HTMLButtonElement>("button[aria-label='Insert value into the mail']")!;
    act(() => trigger.focus());
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    const list = document.querySelector<HTMLElement>("[role='listbox']")!;
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(document.querySelector("[role='listbox']")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps a task's title on one line", async () => {
    await render(<ActionText label="Task title" noun="task's title" multiline={false} value="" onValue={() => undefined} values={VALUES} placeholder="Task title" />);
    expect(host.querySelector("input")).not.toBeNull();
    expect(host.querySelector("textarea")).toBeNull();
  });
});

describe("the values a trigger carries", () => {
  it("offers fired.at to a schedule and a poll, and what a change trigger watched", () => {
    expect(automationValuesOf(blankTrigger("schedule"))).toEqual(["fired.at"]);
    expect(automationValuesOf(blankTrigger("poll"))).toEqual(["fired.at"]);

    const seatWatch = blankTrigger("change");
    expect(automationValuesOf(seatWatch)).toEqual(["seat.name", "seat.state", "fired.at"]);

    const taskWatch = editDraft(newDraft(id, node, { kind: "operator" }), {
      type: "trigger",
      trigger: { kind: "change", on: { kind: "task", becomes: "done" } },
    });
    expect(automationValuesOf(taskWatch.trigger)).toEqual([
      "task.title",
      "task.state",
      "task.link",
      "task.assignee",
      "board.title",
      "fired.at",
    ]);
  });
});

describe("a schedule and a poll read plainly", () => {
  it("says what a cron and a timezone mean", () => {
    expect(cadenceWords({ kind: "schedule", cron: "0 9 * * 1-5", timezone: "UTC" })).toBe("weekdays 09:00, UTC");
    expect(cadenceWords({ kind: "schedule", cron: "not a cron", timezone: "UTC" })).toBeUndefined();
    expect(cadenceWords({ kind: "schedule", cron: "0 9 * * 1-5", timezone: "Mars/Olympus" })).toBeUndefined();
  });

  it("says how often a poll runs, and nothing while the number does not make one", () => {
    expect(cadenceWords({ kind: "poll", everyMinutes: "1" })).toBe("every minute");
    expect(cadenceWords({ kind: "poll", everyMinutes: "5" })).toBe("every 5 minutes");
    expect(cadenceWords({ kind: "poll", everyMinutes: "0.5" })).toBeUndefined();
    expect(cadenceWords({ kind: "poll", everyMinutes: "soon" })).toBeUndefined();
  });
});

describe("what an action keeps", () => {
  const addressed = (): AutomationDraft =>
    editDraft(newDraft(id, node, { kind: "operator" }), {
      type: "action",
      index: 0,
      action: { kind: "mail", to: { kind: "seat", nodeId: asNodeId("agent-a") }, text: "Check it." },
    });

  it("carries the seat and the text from a mail to a prompt, and back", () => {
    const prompted = editDraft(addressed(), { type: "action-kind", index: 0, kind: "prompt" });
    expect(prompted.then[0]).toEqual({ kind: "prompt", to: { kind: "seat", nodeId: asNodeId("agent-a") }, text: "Check it." });
    const mailed = editDraft(prompted, { type: "action-kind", index: 0, kind: "mail" });
    expect(mailed.then[0]).toEqual({ kind: "mail", to: { kind: "seat", nodeId: asNodeId("agent-a") }, text: "Check it." });
  });

  it("marks a value the trigger does not carry, at the action that writes it", () => {
    const stale = editDraft(addressed(), {
      type: "action",
      index: 0,
      action: { kind: "mail", to: { kind: "seat", nodeId: asNodeId("agent-a") }, text: "Done: {{task.title}}" },
    });
    // The default trigger is a schedule: it carries fired.at, never a task's title.
    const problem = draftProblems(stale).find((entry) => entry.at === "action");
    expect(problem?.message).toBe("This trigger carries no {{task.title}}. It carries {{fired.at}}.");
    expect(finishDraft(stale).ok).toBe(false);
  });
});

describe("a signal step in the firing history", () => {
  const at = (ms: number): string => `at ${ms}`;
  const signal = (over: Partial<AgentSignal>): AgentSignal => ({
    signalId: "01MSIGNAL00000000000000001",
    canvasName: "factory",
    nodeId: "automations-1",
    kind: "work",
    text: "Write 500 words",
    createdAt: 1_700_000_000_000,
    state: "open",
    ...over,
  });
  const raised = (signalId: string): ActionRuling => ({ index: 1, ruling: "raised", signalId });

  it("says what was raised and what became of it", () => {
    expect(signalRulingWords(raised("01MSIGNAL00000000000000001"), signal({}), at)).toBe('raised "Write 500 words", still open');
    expect(
      signalRulingWords(
        raised("01MSIGNAL00000000000000001"),
        signal({
          state: "answered",
          closedAt: 5,
          response: {
            text: "Morning pages is written, 512 words.",
            at: 1_700_000_060_000,
            artifact: { nodeId: "artifacts-1", artifactId: "01MARTIFACT000000000000001", title: "Morning pages", words: 512 },
          },
        }),
        at,
      ),
    ).toBe('raised "Write 500 words", answered at 1700000060000');
    expect(
      signalRulingWords(
        raised("01MSIGNAL00000000000000001"),
        signal({ state: "answered", response: { text: "Did it", at: 7, links: ["https://example.com"] } }),
        at,
      ),
    ).toBe('raised "Write 500 words", answered at 7');
    expect(signalRulingWords(raised("01MSIGNAL00000000000000001"), signal({ state: "dismissed", closedAt: 9 }), at)).toBe(
      'raised "Write 500 words", dismissed at 9',
    );
  });

  it("says what the answer was: the document, proof, a secret only as given, or the words (0.11/09 decision 1)", () => {
    const answered = (response: NonNullable<AgentSignal["response"]>) => signalAnswerOf(signal({ state: "answered", response }));
    expect(
      answered({ text: "x", at: 1, artifact: { nodeId: "artifacts-1", artifactId: "01MARTIFACT000000000000001", title: "Morning pages", words: 512 } }),
    ).toEqual({ kind: "document", title: "Morning pages", artifact: { kind: "artifact", nodeId: "artifacts-1", artifactId: "01MARTIFACT000000000000001" } });
    expect(answered({ text: "Did it", at: 1, links: ["https://example.com"] })).toEqual({ kind: "proof" });
    expect(
      answered({ text: "", at: 1, secret: { item: "i", name: "TOKEN", regionId: "r", machine: "m", setAt: 1 } }),
    ).toEqual({ kind: "secret" });
    expect(answered({ text: "  Ship it after the smoke test ", at: 1 })).toEqual({ kind: "words", text: "Ship it after the smoke test" });
    expect(answered({ text: " ", at: 1 })).toBeUndefined();
    expect(signalAnswerOf(signal({}))).toBeUndefined();
    expect(answerIsLong("Ship it")).toBe(false);
    expect(answerIsLong("Ship it\nthen tag")).toBe(true);
    expect(answerIsLong("x".repeat(161))).toBe(true);
  });

  it("names a signal this window does not hold, and says nothing for another kind of step", () => {
    expect(signalRulingWords(raised("01MGONE0000000000000000000"), undefined, at)).toBe("raised a signal this window does not hold");
    expect(signalRulingWords({ index: 0, ruling: "applied" }, undefined, at)).toBeUndefined();
  });

  it("counts a signal step as one that acted", () => {
    const firing: Firing = {
      firingId: ItemId.make("01JFFFFFFFFFFFFFFFFFFFFFF3"),
      automationId: id,
      at: 1_700_000_000_000,
      cause: { kind: "run" },
      outcome: { kind: "fired", actions: [raised("01MSIGNAL00000000000000001")] },
    };
    expect(firingWords(firing)).toBe("Run by hand, fired, 1 of 1 action applied");
  });
});

describe("a code step's result in words", () => {
  const firingId = ItemId.make("01JFFFFFFFFFFFFFFFFFFFFFF1");
  const firing = (actions: ReadonlyArray<ActionRuling>): Firing => ({
    firingId,
    automationId: id,
    at: 1_700_000_000_000,
    cause: { kind: "run" },
    outcome: { kind: "fired", actions },
  });

  it("says what a code step answered, and names the values later steps can use", () => {
    expect(codeRulingWords({ index: 1, ruling: "continued", output: { total: 3, state: "ok" }, durationMs: 120 })).toBe(
      "answered {{code.total}}, {{code.state}} in 120 ms",
    );
    expect(codeRulingWords({ index: 0, ruling: "continued", output: {}, durationMs: 1500 })).toBe("answered no values in 1.5 s");
  });

  it("says why a step stopped or failed", () => {
    expect(codeRulingWords({ index: 0, ruling: "stopped", durationMs: 40 })).toBe("stopped the automation in 40 ms");
    expect(codeRulingWords({ index: 0, ruling: "stopped", reason: "nothing to do", durationMs: 40 })).toBe("stopped: nothing to do");
    expect(codeRulingWords({ index: 0, ruling: "failed", message: "timeout", durationMs: 60_000 })).toBe("failed: timeout");
    expect(codeRulingWords({ index: 0, ruling: "failed", message: "bad", exitCode: 2, durationMs: 80 })).toBe("failed: bad (exit 2)");
    expect(codeRulingWords({ index: 0, ruling: "applied" })).toBeUndefined();
  });

  it("counts a step that continued as one that acted, and says how many stopped or failed", () => {
    expect(firingWords(firing([{ index: 0, ruling: "continued", output: {}, durationMs: 10 }]))).toBe("Run by hand, fired, 1 of 1 action applied");
    expect(
      firingWords(
        firing([
          { index: 0, ruling: "continued", output: {}, durationMs: 10 },
          { index: 1, ruling: "stopped", durationMs: 5 },
          { index: 2, ruling: "failed", message: "timeout", durationMs: 60_000 },
        ]),
      ),
    ).toBe("Run by hand, fired, 1 of 3 actions applied, 1 stopped, 1 failed");
  });
});

describe("the prompt action in the editor", () => {
  /** A draft whose one action prompts a seat. */
  const promptDraft = (): AutomationDraft =>
    editDraft(newDraft(id, node, { kind: "operator" }), {
      type: "action",
      index: 0,
      action: { kind: "prompt", to: { kind: "seat", nodeId: asNodeId("agent-a") }, text: "Check the release." },
    });

  it("offers a multi-line prompt text and the values its trigger carries", async () => {
    setTasksSource(makeLocalTasksSource());
    act(() => {
      modelStore.adopt({ canvas: asCanvasName(CANVAS), seq: 0, wires: [], nodes: [automations("automations-1", { z: 0 })] });
    });
    await render(
      <AutomationEditor
        draft={promptDraft()}
        onDraft={() => undefined}
        canvasName={CANVAS}
        saving={false}
        dirty={false}
        onSave={() => undefined}
        onRevert={() => undefined}
      />,
    );
    expect(host.querySelector<HTMLTextAreaElement>("textarea[aria-label='Prompt text']")?.value).toBe("Check the release.");
    expect(host.querySelector("button[aria-label='Insert value into the prompt']")).not.toBeNull();
    expect(draftProblems(promptDraft())).toEqual([]);
  });

  it("finishes as a prompt the contract reads, carrying the value its trigger names", () => {
    const draft = editDraft(newDraft(id, node, { kind: "operator" }), {
      type: "action",
      index: 0,
      action: { kind: "prompt", to: { kind: "seat", nodeId: asNodeId("agent-a") }, text: "{{fired.at}}: check the release." },
    });
    const finished = finishDraft(draft);
    if (!finished.ok) throw new Error(finished.problems.map((problem) => problem.message).join("; "));
    expect(finished.definition.then).toEqual([
      { kind: "prompt", to: { kind: "seat", nodeId: asNodeId("agent-a") }, text: "{{fired.at}}: check the release." },
    ]);
  });
});
