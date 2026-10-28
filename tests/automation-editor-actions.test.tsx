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
  blankAction,
  blankTrigger,
  cadenceWords,
  draftProblems,
  editDraft,
  newDraft,
  valuesForTrigger,
  type AutomationDraft,
} from "../src/renderer/lib/automation-editor";
import { setTasksSource, makeLocalTasksSource } from "../src/renderer/lib/tasks-source";
import { modelStore } from "../src/renderer/lib/use-model";
import { automations } from "./support/model-nodes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  return <ActionText label="Mail text" value={text} onValue={setText} values={VALUES} placeholder="What the mail says" />;
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
    expect(host.querySelector("button[aria-label='Insert a value into mail text']")).not.toBeNull();
  });

  it("lists the values it is given and writes one where the caret is", async () => {
    await render(<Harness initial="Hi !" />);
    const field = host.querySelector("textarea")!;
    act(() => field.setSelectionRange(3, 3));

    await click(host.querySelector("button[aria-label='Insert a value into mail text']")!);
    const options = [...document.querySelectorAll("[role='option']")].map((option) => option.textContent ?? "");
    expect(options).toEqual(["{{seat.name}}the seat's name", "{{fired.at}}when it fired"]);

    await click([...document.querySelectorAll("[role='option']")].find((option) => option.textContent?.includes("seat.name"))!);
    expect(field.value).toBe("Hi {{seat.name}}!");
    expect(field.selectionStart).toBe("Hi {{seat.name}}".length);
  });

  it("replaces what is selected, as typing would", async () => {
    await render(<Harness initial="Say this." />);
    const field = host.querySelector("textarea")!;
    act(() => field.setSelectionRange(4, 8));

    await click(host.querySelector("button[aria-label='Insert a value into mail text']")!);
    await click([...document.querySelectorAll("[role='option']")].find((option) => option.textContent?.includes("fired.at"))!);
    expect(field.value).toBe("Say {{fired.at}}.");
  });

  it("keeps a task's title on one line", async () => {
    await render(<ActionText label="Task title" multiline={false} value="" onValue={() => undefined} values={VALUES} placeholder="Task title" />);
    expect(host.querySelector("input")).not.toBeNull();
    expect(host.querySelector("textarea")).toBeNull();
  });
});

describe("the values a trigger carries", () => {
  it("offers fired.at to a schedule and a poll, and what a change trigger watched", () => {
    expect(valuesForTrigger(blankTrigger("schedule"))).toEqual(["fired.at"]);
    expect(valuesForTrigger(blankTrigger("poll"))).toEqual(["fired.at"]);

    const seatWatch = blankTrigger("change");
    expect(valuesForTrigger(seatWatch)).toEqual(["seat.name", "seat.state", "fired.at"]);

    const taskWatch = editDraft(newDraft(id, node, { kind: "operator" }), {
      type: "trigger",
      trigger: { kind: "change", on: { kind: "task", becomes: "done" } },
    });
    expect(valuesForTrigger(taskWatch.trigger)).toEqual([
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

describe("the prompt action in the editor", () => {
  /** A draft whose one action prompts a seat; the contract does not carry it yet. */
  const promptDraft = (): AutomationDraft =>
    editDraft(newDraft(id, node, { kind: "operator" }), {
      type: "action",
      index: 0,
      action: { ...blankAction("prompt"), to: { kind: "seat", nodeId: asNodeId("agent-a") }, text: "Check the release." },
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
    expect(host.querySelector("textarea[aria-label='Prompt text']")?.value).toBe("Check the release.");
    expect(host.querySelector("button[aria-label='Insert a value into prompt text']")).not.toBeNull();
  });

  it("refuses a prompt until the contract carries one, in words", () => {
    const problem = draftProblems(promptDraft()).find((entry) => entry.at === "action");
    expect(problem?.message).toBe("Prompts are not available yet. Send mail for now.");
  });

  it("refuses a value the contract cannot resolve yet, in words", () => {
    const draft = editDraft(promptDraft(), { type: "action-kind", index: 0, kind: "mail" });
    const withValue = editDraft(draft, {
      type: "action",
      index: 0,
      action: { kind: "mail", to: { kind: "seat", nodeId: asNodeId("agent-a") }, text: "{{task.title}} is done" },
    });
    const problem = draftProblems(withValue).find((entry) => entry.at === "action");
    expect(problem?.message).toBe("Values are not available yet. Write the text plainly for now.");
  });
});
