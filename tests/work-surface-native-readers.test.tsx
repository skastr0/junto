// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { THIS_MACHINE } from "./support/machines";
import { settleLazy } from "./support/settle-lazy";
import { Schema } from "effect";
import { asCanvasName, Node, Wire } from "../src/shared/model";
import { modelStore } from "../src/renderer/lib/use-model";
import { EMPTY_SETTINGS, state$ } from "../src/renderer/lib/state";
import { dock$ } from "../src/renderer/lib/dock-state";
import { workDetailOpen$ } from "../src/renderer/lib/work-detail-open";
import { makeLocalTasksSource, setTasksSource, tasksSource } from "../src/renderer/lib/tasks-source";
import { taskNodeId } from "../src/shared/task-model";
import { asNodeId } from "../src/shared/model";
import { EditorView } from "@codemirror/view";
import { TaskEnqueueSurface } from "../src/renderer/components/work/TaskEnqueueSurface";
import { ConnectEditor } from "../src/renderer/components/rts/ConnectEditor";
import { KindSurface } from "../src/renderer/components/rts/KindSurface";
import { NodeFieldEditors } from "../src/renderer/components/InspectorFields";
import { flushPendingCanvasSave, undo } from "../src/renderer/lib/mutations";
import type { Artifact, Task } from "../src/shared/work-model";
import type { WorkSinkQuery } from "../src/shared/work-sinks";
import { loadLazySurfaces } from "../src/renderer/lib/lazy-surface";

// The editors and viewers load before any test, so no test waits on an import.
await loadLazySurfaces();

vi.hoisted(() => {
  HTMLElement.prototype.scrollIntoView = () => {};
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
});

let canvas: string;
let host: HTMLDivElement;
let root: Root;
let oldApi: typeof window.junto;
let counter = 0;
let tasks: ReadonlyArray<Task>;
let artifacts: ReadonlyArray<Artifact>;
let releaseCanvas: (() => void) | undefined;
const decodeNode = Schema.decodeUnknownSync(Node);
const decodeWire = Schema.decodeUnknownSync(Wire);
const agent = (label: string) => ({
  kind: "agent", label, agentKey: `${THIS_MACHINE}:worker`, harness: "codex",
  host: THIS_MACHINE, bindingId: "binding", overseer: false,
});
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const publish = (id: string, fields: Record<string, unknown>) => {
  const node = decodeNode({ id, x: 100, y: 200, width: 300, height: 180, z: 1, ...fields });
  modelStore.node$(canvas, id).set(node);
  modelStore.canvas$(canvas).nodeIds.set(Object.keys(modelStore.canvas$(canvas).nodes.peek()));
  return node;
};
const wire = (id: string, from: string, to: string) => {
  modelStore.wire$(canvas, id).set(decodeWire({ id, from, to, verb: "flows" }));
  modelStore.canvas$(canvas).wireIds.set(Object.keys(modelStore.canvas$(canvas).wires.peek()));
};
const mount = async (content: ReactNode) => { await act(async () => {
  root.render(content); await flush();
}); await settleLazy(); };
const click = async (selector: string) => {
  const element = document.querySelector(selector);
  expect(element, selector).toBeTruthy();
  await act(async () => { element!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
};
const type = async (selector: string, value: string) => {
  const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  expect(element, selector).toBeTruthy();
  const prototype = element.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  canvas = `native-work-${++counter}`;
  tasks = []; artifacts = [];
  oldApi = window.junto;
  (window as unknown as { junto: unknown }).junto = {
    onWorkSinkChanged: () => () => {},
    workSinkPage: async (query: WorkSinkQuery) => ({
      kind: query.kind, items: query.kind === "artifacts" ? artifacts : tasks,
    }),
  };
  state$.settings.set(EMPTY_SETTINGS);
  state$.canvasName.set(canvas);
  // There are no mirrored document nodes. All rendered facts must come from
  // native rows or the separately paged work store.
  state$.actorRefs.set([]);
  state$.selectedNodeId.set(""); state$.selectedNodeIds.set([]);
  state$.selectedEdgeId.set("");
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); await flush(); });
  releaseCanvas?.(); releaseCanvas = undefined;
  host.remove();
  modelStore.canvas$(canvas).nodes.set({});
  modelStore.canvas$(canvas).wires.set({});
  modelStore.canvas$(canvas).nodeIds.set([]);
  modelStore.canvas$(canvas).wireIds.set([]);
  dock$.taskCreateById.set({});
  workDetailOpen$.set({ nodeId: "", itemId: "" });
  state$.canvasName.set(""); state$.settings.set(EMPTY_SETTINGS);
  (window as unknown as { junto: unknown }).junto = oldApi;
  vi.unstubAllGlobals();
});

it("enqueues a task on its node through the tasks source, with its body and approvals, and clears for the next", async () => {
  setTasksSource(makeLocalTasksSource());
  state$.canvasName.set(canvas);
  publish("queue", { kind: "task", name: "Build" });
  dock$.taskCreateById["enqueue"].set({ nodeId: "queue", title: "Build", mode: "task" });
  await mount(<TaskEnqueueSurface surface={{ id: "enqueue", kind: "task-create" }} visible onActivate={() => {}} />);
  await type('input[placeholder="What needs doing?"]', "Ship it");
  // The details are a live markdown field: written as typing into its editor.
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  const details = () => EditorView.findFromDOM(document.querySelector<HTMLElement>(".task-enqueue__details .cm-editor")!)!;
  await act(async () => details().dispatch({ changes: { from: 0, insert: "Implement and verify" }, userEvent: "input.type" }));
  await click('[aria-label="Require one more approval"]');
  await act(async () => {
    document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
  });
  const made = await tasksSource().list(canvas, taskNodeId(asNodeId("queue")));
  expect(made).toHaveLength(1);
  expect(made[0]).toMatchObject({ title: "Ship it", body: "Implement and verify", current: { state: "backlog", stampPolicy: { required: 1 } } });
  expect(document.querySelector<HTMLInputElement>('input[placeholder="What needs doing?"]')?.value).toBe("");
  expect(details().state.doc.toString()).toBe("");
});

it("unbinds enqueue when its native task node disappears", async () => {
  publish("queue", { kind: "task", name: "Build" });
  dock$.taskCreateById.enqueue.set({ nodeId: "queue", title: "Build", mode: "task" });
  await mount(<TaskEnqueueSurface surface={{ id: "enqueue", kind: "task-create" }} visible onActivate={() => {}} />);
  expect(document.querySelector('[data-testid="task-enqueue-surface"]')).toBeTruthy();
  await act(async () => { modelStore.node$(canvas, "queue").delete(); await flush(); });
  expect(document.body.textContent).toContain("task enqueue - unbound");
});

it("lists connection targets and follows native names and wires without a document mirror", async () => {
  publish("source", agent("Planner"));
  publish("peer", agent("Reviewer"));
  await mount(<ConnectEditor nodeId="source" onClose={() => {}} />);
  expect(document.querySelector('[data-node-id="peer"]')?.textContent).toContain("Reviewer");
  await act(async () => { publish("peer", agent("Writer")); await flush(); });
  expect(document.querySelector('[data-node-id="peer"]')?.textContent).toContain("Writer");
  await act(async () => {
    modelStore.wire$(canvas, "messages").set(decodeWire({ id: "messages", from: "source", to: "peer", verb: "messages" }));
    await flush();
  });
  expect(document.querySelector('[data-node-id="peer"]')).toBeNull();
  expect(document.body.textContent).toContain("Already connected to every agent");
});

it("opens the bar's fields by id and follows native folder changes without a document mirror", async () => {
  publish("repo", { kind: "git", label: "Repository", cwd: "/before" });
  state$.selectedNodeId.set("repo"); state$.selectedNodeIds.set(["repo"]);
  await mount(<KindSurface />);
  await click('[aria-label="Open fields"]');
  expect(document.querySelector<HTMLInputElement>('[aria-label="Git repository folder"]')?.value).toBe("/before");
  await act(async () => {
    publish("repo", { kind: "git", label: "Repository", cwd: "/after" }); await flush();
  });
  expect(document.querySelector<HTMLInputElement>('[aria-label="Git repository folder"]')?.value).toBe("/after");
});

it("reads note fields by id and updates the draft when native text changes", async () => {
  publish("note", { kind: "note", text: "Before" });
  await mount(<NodeFieldEditors nodeId="note" />);
  expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Note text"]')?.value).toBe("Before");
  await act(async () => { publish("note", { kind: "note", text: "After" }); await flush(); });
  expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Note text"]')?.value).toBe("After");
});

it("offers no second verb between two seats: they connect only as messages", async () => {
  publish("source", agent("Planner")); publish("peer", agent("Reviewer"));
  const nativeWire = decodeWire({ id: "connection", from: "source", to: "peer", verb: "messages", mask: ["msg.send"] });
  releaseCanvas = modelStore.adopt({
    canvas: asCanvasName(canvas), seq: 0,
    nodes: Object.values(modelStore.canvas$(canvas).nodes.peek()), wires: [nativeWire],
  });
  state$.selectedEdgeId.set("connection");
  const modelCommand = vi.fn(async () => ({ seq: 1 }));
  (window as unknown as { junto: unknown }).junto = { ...window.junto, modelCommand };
  await mount(<KindSurface />);
  expect(document.body.textContent).toContain("Planner messages Reviewer");
  expect(document.querySelector('[aria-label^="Change to"]')).toBeNull();
  expect(modelCommand).not.toHaveBeenCalled();
});
