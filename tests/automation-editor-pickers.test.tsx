// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asCanvasName } from "../src/shared/model";
import { asNodeId } from "../src/shared/physics/schema";
import { taskNodeId, type TaskId } from "../src/shared/task-model";
import { AutomationEditor } from "../src/renderer/components/automations/AutomationEditor";
import { newDraft, type AutomationDraft } from "../src/renderer/lib/automation-editor";
import { artifactsSource, setArtifactsSource, type ArtifactsSource } from "../src/renderer/lib/artifacts-source";
import { makeLocalTasksSource, setTasksSource } from "../src/renderer/lib/tasks-source";
import { modelStore } from "../src/renderer/lib/use-model";
import { artifacts, automations, taskBoard } from "./support/model-nodes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CANVAS = "automation-pickers";
const shelf = asNodeId("automations-1");
const board = taskNodeId(asNodeId("board-1"));
const taskId = "01M627SVX2BMGZAMXFA2F5BYAB" as TaskId;

let host: HTMLDivElement;
let root: Root;
let release: () => void;
const original = artifactsSource();

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
    nodes: [
      automations("automations-1", { z: 0 }),
      taskBoard("board-1", { x: 400, z: 1, name: "Release" }),
      artifacts("shelf-1", { x: 800, z: 2, label: "Specs" }),
    ],
  });
  const tasks = makeLocalTasksSource();
  setTasksSource(tasks);
  await tasks.apply(CANVAS, board, taskId, { kind: "create", taskId, title: "Ship labels" });
  // Only the fields the # picker reads.
  setArtifactsSource({
    ...original,
    list: async (_canvas: string, nodeId: string) =>
      nodeId === "shelf-1" ? [{ artifact: { artifactId: "01M627SVX2BMGZAMXFA2F5BYAE", nodeId, title: "Launch notes", archived: false } }] : [],
    onChanged: () => () => undefined,
  } as unknown as ArtifactsSource);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  release();
  setArtifactsSource(original);
});

describe("automation editor pickers", () => {
  it("a task watch on one task lists the tasks in reach", async () => {
    const draft = newDraft("01M627SVX2BMGZAMXFA2F5BYAC" as AutomationDraft["automationId"], shelf, { kind: "operator" });
    await render({ ...draft, trigger: { kind: "change", on: { kind: "task", becomes: "done" } } });
    const picker = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task to watch"]')!;
    expect(picker).not.toBeNull();
    type(picker, "#");
    const offered = [...host.querySelectorAll('[role="option"]')].map((option) => option.textContent ?? "");
    expect(offered.some((text) => text.includes("Ship labels"))).toBe(true);
    // The list is named by what it offers: tasks, not "tasks and artifacts".
    expect(host.querySelector('[role="listbox"]')?.getAttribute("aria-label")).toBe("Tasks this automation may name");
  });

  it("an artifact watch on one artifact lists the artifacts in reach, and only those", async () => {
    const draft = newDraft("01M627SVX2BMGZAMXFA2F5BYAF" as AutomationDraft["automationId"], shelf, { kind: "operator" });
    await render({ ...draft, trigger: { kind: "change", on: { kind: "artifact", event: "edited" } } });
    type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Artifact to watch"]')!, "#");
    const offered = [...host.querySelectorAll('[role="option"]')].map((option) => option.textContent ?? "");
    expect(offered.some((text) => text.includes("Launch notes"))).toBe(true);
    expect(offered.some((text) => text.includes("Ship labels"))).toBe(false);
  });

  it("one item reads as a sentence too: a task named #42 becomes done", async () => {
    const draft = newDraft("01M627SVX2BMGZAMXFA2F5BYAG" as AutomationDraft["automationId"], shelf, { kind: "operator" });
    await render({ ...draft, trigger: { kind: "change", on: { kind: "task", becomes: "done" } } });
    const sentence = host.querySelector(".automation-editor__sentence")!;
    expect([...sentence.querySelectorAll(".automation-editor__word")].map((word) => word.textContent)).toEqual(["When", "becomes"]);
    expect(host.querySelector('[aria-label="Watch scope"]')?.textContent).toBe("named");
    expect(sentence.textContent).not.toContain(" in ");
  });

  it("reads as a sentence, its scope naming the boards and Artifacts nodes in reach", async () => {
    const draft = newDraft("01M627SVX2BMGZAMXFA2F5BYAD" as AutomationDraft["automationId"], shelf, { kind: "operator" });
    await render({ ...draft, trigger: { kind: "change", on: { kind: "task", task: { node: board }, becomes: "done" } } });
    const sentence = host.querySelector(".automation-editor__sentence")!;
    expect([...sentence.querySelectorAll(".automation-editor__word")].map((word) => word.textContent)).toEqual(["When", "becomes"]);
    expect(host.textContent).not.toContain("This task");
    // A node scope needs no item picked.
    expect(host.querySelector('textarea[aria-label="Task to watch"]')).toBeNull();
    expect(host.querySelector('[aria-label="Watch scope"]')?.textContent).toContain("in Release");
    expect(host.querySelector('[aria-label="State it becomes"]')?.textContent).toContain("done");

    await render({ ...draft, trigger: { kind: "change", on: { kind: "artifact", artifact: { node: asNodeId("shelf-1") }, event: "commented" } } });
    expect(host.querySelector('[aria-label="Watch scope"]')?.textContent).toContain("in Specs");
    // The join is labelled as it reads: "is", never "Event".
    expect(host.querySelector('[aria-label="Is"]')?.textContent).toContain("commented on");

    // A node no longer in reach still shows, in its kind's words.
    await render({ ...draft, trigger: { kind: "change", on: { kind: "artifact", artifact: { node: asNodeId("gone-1") }, event: "edited" } } });
    expect(host.querySelector('[aria-label="Watch scope"]')?.textContent).toContain("in an Artifacts node out of reach");
  });
});
