// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asCanvasName } from "../src/shared/model";
import { asNodeId } from "../src/shared/physics/schema";
import { taskNodeId, type TaskId } from "../src/shared/task-model";
import { AutomationEditor } from "../src/renderer/components/automations/AutomationEditor";
import { newDraft, type AutomationDraft } from "../src/renderer/lib/automation-editor";
import { makeLocalTasksSource, setTasksSource } from "../src/renderer/lib/tasks-source";
import { modelStore } from "../src/renderer/lib/use-model";
import { automations, taskBoard } from "./support/model-nodes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CANVAS = "automation-pickers";
const shelf = asNodeId("automations-1");
const board = taskNodeId(asNodeId("board-1"));
const taskId = "01M627SVX2BMGZAMXFA2F5BYAB" as TaskId;

let host: HTMLDivElement;
let root: Root;
let release: () => void;

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
};

const render = async (draft: AutomationDraft): Promise<void> => {
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
      />,
    ),
  );
  await flush();
};

/** Type into a picker as a keystroke would, caret at the end. */
const type = (field: HTMLTextAreaElement, text: string): void => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
    field.setSelectionRange(text.length, text.length);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(async () => {
  release = modelStore.adopt({
    canvas: asCanvasName(CANVAS),
    seq: 0,
    wires: [],
    nodes: [automations("automations-1", { z: 0 }), taskBoard("board-1", { x: 400, z: 1, name: "Release" })],
  });
  const tasks = makeLocalTasksSource();
  setTasksSource(tasks);
  await tasks.apply(CANVAS, board, taskId, { kind: "create", taskId, title: "Ship labels" });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  release();
});

describe("automation editor pickers", () => {
  it("a task watch on one task lists the tasks in reach", async () => {
    const draft = newDraft("01M627SVX2BMGZAMXFA2F5BYAC" as AutomationDraft["automationId"], shelf, { kind: "operator" });
    await render({ ...draft, trigger: { kind: "change", on: { kind: "task", becomes: "done" } } });
    const picker = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task"]')!;
    expect(picker).not.toBeNull();
    type(picker, "#");
    const offered = [...host.querySelectorAll('[role="option"]')].map((option) => option.textContent ?? "");
    expect(offered.some((text) => text.includes("Ship labels"))).toBe(true);
  });
});
