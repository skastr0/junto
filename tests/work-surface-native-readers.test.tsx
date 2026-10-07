// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { Node, Wire } from "../src/shared/model";
import { modelStore } from "../src/renderer/lib/use-model";
import { EMPTY_SETTINGS, state$ } from "../src/renderer/lib/state";
import { dock$ } from "../src/renderer/lib/dock-state";
import { workDetailOpen$ } from "../src/renderer/lib/work-detail-open";
import { TaskBoard } from "../src/renderer/components/work/TaskBoard";
import { TaskEnqueueSurface } from "../src/renderer/components/work/TaskEnqueueSurface";
import { ArtifactLibrary, RequestInbox } from "../src/renderer/components/work/WorkLedger";
import type { Artifact, Task } from "../src/shared/work-model";
import type { WorkSinkQuery } from "../src/shared/work-sinks";

vi.hoisted(() => {
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
let create: ReturnType<typeof vi.fn>;
const decodeNode = Schema.decodeUnknownSync(Node);
const decodeWire = Schema.decodeUnknownSync(Wire);
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const publish = (id: string, fields: Record<string, unknown>) => {
  const node = decodeNode({ id, x: 100, y: 200, width: 300, height: 180, z: 1, ...fields });
  modelStore.node$(canvas, id).set(node);
  modelStore.canvas$(canvas).nodeIds.set(Object.keys(modelStore.canvas$(canvas).nodes.peek()));
  return node;
};
const wire = (id: string, from: string, to: string) => {
  modelStore.wire$(canvas, id).set(decodeWire({ id, from, to, verb: "feeds" }));
  modelStore.canvas$(canvas).wireIds.set(Object.keys(modelStore.canvas$(canvas).wires.peek()));
};
const mount = async (content: ReactNode) => act(async () => {
  root.render(content); await flush();
});
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
  create = vi.fn(async () => ({ ok: true, data: {} }));
  oldApi = window.junto;
  (window as unknown as { junto: unknown }).junto = {
    onWorkSinkChanged: () => () => {},
    workSinkPage: async (query: WorkSinkQuery) => ({
      kind: query.kind, items: query.kind === "artifacts" ? artifacts : tasks,
    }),
    workTaskPolicy: async () => [],
    workTaskCreate: create,
  };
  state$.settings.set(EMPTY_SETTINGS);
  state$.settings.station.role.set("command-center");
  state$.canvasName.set(canvas);
  // There are no mirrored document nodes. All rendered facts must come from
  // native rows or the separately paged work store.
  state$.doc.set({ nodes: [], edges: [] });
  state$.actorRefs.set([]);
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); await flush(); });
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

it("mounts task paths and settings from native rows, then follows a changed contract and name", async () => {
  publish("before", { kind: "task", name: "Plan" });
  publish("queue", { kind: "task", name: "Build", contract: { instructions: "Ship the change" } });
  publish("after", { kind: "task", name: "Verify" });
  wire("in", "before", "queue"); wire("out", "queue", "after");
  await mount(<TaskBoard nodeId="queue" onClose={() => {}} />);
  expect(document.body.textContent).toContain("Build");
  expect(document.querySelector('[data-testid="task-lane-incoming"]')?.textContent).toContain("Plan");
  expect(document.querySelector('[data-testid="task-lane-outgoing"]')?.textContent).toContain("Verify");
  await click('[aria-label="Edit board settings"]');
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Instructions"]')?.value).toBe("Ship the change");
  await act(async () => {
    publish("queue", { kind: "task", name: "Release", contract: { instructions: "Review the release", incoming: { admission: "approval" } } });
    await flush();
  });
  expect(document.body.textContent).toContain("Release");
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Instructions"]')?.value).toBe("Review the release");
  expect(state$.doc.peek().nodes).toEqual([]);
});

it("enqueues under the native admission floor and artifact sink with no document mirror", async () => {
  publish("queue", { kind: "task", name: "Build", contract: { incoming: { admission: "approval" } } });
  publish("outputs", { kind: "artifacts", label: "Results" });
  dock$.taskCreateById["enqueue"].set({ nodeId: "queue", title: "Build", mode: "task" });
  await mount(<TaskEnqueueSurface surface={{ id: "enqueue", kind: "task-create", zone: "focus" }} zone="focus" visible onActivate={() => {}} />);
  expect(document.body.textContent).toContain("This board's default: Approval");
  await type('input[placeholder="What needs doing?"]', "Ship it");
  await type('textarea[placeholder="Context, constraints, expected result…"]', "Implement and verify");
  const checkbox = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => input.parentElement?.textContent?.includes("Require artifact"));
  expect(checkbox?.disabled).toBe(false);
  await act(async () => checkbox!.click());
  await act(async () => {
    document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
  });
  expect(create).toHaveBeenCalledOnce();
  expect(create.mock.calls[0]).toEqual(expect.arrayContaining([
    canvas, "queue", "Ship it", expect.objectContaining({ artifacts: { nodeId: "outputs" } }),
    expect.objectContaining({ admission: "approval" }),
  ]));
});

it("unbinds enqueue when its native task node disappears", async () => {
  publish("queue", { kind: "task", name: "Build" });
  dock$.taskCreateById.enqueue.set({ nodeId: "queue", title: "Build", mode: "task" });
  await mount(<TaskEnqueueSurface surface={{ id: "enqueue", kind: "task-create", zone: "focus" }} zone="focus" visible onActivate={() => {}} />);
  expect(document.querySelector('[data-testid="task-enqueue-surface"]')).toBeTruthy();
  await act(async () => { modelStore.node$(canvas, "queue").delete(); await flush(); });
  expect(document.body.textContent).toContain("task enqueue - unbound");
});

it("reads the request inbox title from its native node and follows rename", async () => {
  publish("requests", { kind: "requests", name: "Decisions" });
  await mount(<RequestInbox nodeId="requests" onClose={() => {}} />);
  expect(document.body.textContent).toContain("Decisions");
  await act(async () => { publish("requests", { kind: "requests", name: "Questions" }); await flush(); });
  expect(document.body.textContent).toContain("Questions");
  expect(document.body.textContent).not.toContain("Decisions");
});

it("opens artifact provenance from the native task, and refuses after that id changes kind", async () => {
  publish("queue", { kind: "task", name: "Build" });
  publish("outputs", { kind: "artifacts", label: "Results" });
  artifacts = [{ artifactId: "artifact", name: "Result", parts: [], task: { kind: "task", itemId: "work", sink: { canvasName: canvas, nodeId: "queue" } } }];
  const close = vi.fn();
  await mount(<ArtifactLibrary nodeId="outputs" onClose={close} />);
  await click('[aria-label="Select Result"]');
  await click('[aria-label="Open source task"]');
  expect(close).toHaveBeenCalledOnce();
  expect(workDetailOpen$.peek()).toEqual({ nodeId: "queue", itemId: "work" });
  workDetailOpen$.set({ nodeId: "", itemId: "" });
  await act(async () => { publish("queue", { kind: "note", text: "Retired" }); await flush(); });
  await click('[aria-label="Open source task"]');
  expect(document.body.textContent).toContain("Source task work is no longer");
  expect(close).toHaveBeenCalledOnce();
  expect(workDetailOpen$.nodeId.peek()).toBe("");
});
