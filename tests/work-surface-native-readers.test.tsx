// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { asCanvasName, Node, Wire } from "../src/shared/model";
import { modelStore } from "../src/renderer/lib/use-model";
import { EMPTY_SETTINGS, state$ } from "../src/renderer/lib/state";
import { dock$ } from "../src/renderer/lib/dock-state";
import { workDetailOpen$ } from "../src/renderer/lib/work-detail-open";
import { TaskBoard } from "../src/renderer/components/work/TaskBoard";
import { TaskEnqueueSurface } from "../src/renderer/components/work/TaskEnqueueSurface";
import { ArtifactLibrary, RequestInbox } from "../src/renderer/components/work/WorkLedger";
import { BoardDetail } from "../src/renderer/components/work/WorkSurfaces";
import { ConnectEditor } from "../src/renderer/components/rts/ConnectEditor";
import { PadPinThread } from "../src/renderer/components/pad/PadPinThread";
import { KindSurface } from "../src/renderer/components/rts/KindSurface";
import { NodeFieldEditors } from "../src/renderer/components/InspectorFields";
import { flushPendingCanvasSave, undo } from "../src/renderer/lib/mutations";
import { PadPin } from "../src/shared/pad";
import type { Artifact, BoardTopicView, Task } from "../src/shared/work-model";
import type { WorkSinkQuery } from "../src/shared/work-sinks";

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
let topics: ReadonlyArray<BoardTopicView>;
let create: ReturnType<typeof vi.fn>;
let releaseCanvas: (() => void) | undefined;
const decodeNode = Schema.decodeUnknownSync(Node);
const decodeWire = Schema.decodeUnknownSync(Wire);
const agent = (label: string) => ({
  kind: "agent", label, agentKey: "local:worker", harness: "codex",
  host: "local", bindingId: "binding", overseer: false, onRemove: "detach",
});
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
  tasks = []; artifacts = []; topics = [];
  create = vi.fn(async () => ({ ok: true, data: {} }));
  oldApi = window.junto;
  (window as unknown as { junto: unknown }).junto = {
    onWorkSinkChanged: () => () => {},
    workSinkPage: async (query: WorkSinkQuery) => ({
      kind: query.kind, items: query.kind === "artifacts" ? artifacts : tasks,
    }),
    workTaskPolicy: async () => [],
    workTaskCreate: create,
    workBoardList: async () => ({ ok: true, data: { topics } }),
  };
  state$.settings.set(EMPTY_SETTINGS);
  state$.settings.station.role.set("command-center");
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

it("shows current board author names, follows native rename, and preserves historical labels after removal", async () => {
  publish("board", { kind: "board", label: "Decisions" });
  publish("worker", agent("Planner"));
  const author = { kind: "actor" as const, nodeId: "worker", label: "Original name" };
  topics = [{
    topicId: "topic", title: "Release", state: "open", openedBy: author,
    openedAt: "2026-10-07T12:00:00Z", lastActivityAt: "2026-10-07T12:00:00Z",
    postCount: 1, unreadPostCount: 0,
    posts: [{ postId: "post", topicId: "topic", author, position: 0,
      createdAt: "2026-10-07T12:00:00Z", parts: [{ kind: "text", text: "Ready" }] }],
  }];
  await mount(<BoardDetail nodeId="board" onClose={() => {}} />);
  expect(document.body.textContent).toContain("Decisions");
  expect(document.querySelector(".board-post strong")?.textContent).toBe("Planner");
  await act(async () => { publish("worker", agent("Reviewer")); await flush(); });
  expect(document.querySelector(".board-post strong")?.textContent).toBe("Reviewer");
  await act(async () => { modelStore.node$(canvas, "worker").delete(); await flush(); });
  expect(document.querySelector(".board-post strong")?.textContent).toBe("Original name");
});

it("resolves pad post authors from native nodes instead of a document node list", async () => {
  publish("worker", agent("Planner"));
  const pin = Schema.decodeUnknownSync(PadPin)({
    id: "pin", x: 0, y: 0, mentions: [],
    posts: [{ postId: "post", author: { kind: "actor", nodeId: "worker", label: "Old name" },
      parts: [{ kind: "text", text: "Ready" }] }],
  });
  await mount(<PadPinThread pin={pin} actors={[]} onCommit={async () => true} />);
  expect(document.querySelector(".board-post strong")?.textContent).toBe("Planner");
  await act(async () => { publish("worker", agent("Reviewer")); await flush(); });
  expect(document.querySelector(".board-post strong")?.textContent).toBe("Reviewer");
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

it("changes a native wire verb as one undoable command and returns the old mask", async () => {
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
  await click('[aria-label="Change to reviews"]');
  await act(async () => { await flushPendingCanvasSave(); await flush(); });
  expect(modelCommand).toHaveBeenCalledOnce();
  expect(modelCommand).toHaveBeenCalledWith({
    _tag: "Rewire", canvas, id: "connection", change: { verb: "reviews", mask: null },
  });
  expect(modelStore.wire$(canvas, "connection").peek()?.verb).toBe("reviews");
  await act(async () => { undo(); await flushPendingCanvasSave(); await flush(); });
  expect(modelCommand).toHaveBeenCalledTimes(2);
  expect(modelStore.wire$(canvas, "connection").peek()).toMatchObject({ verb: "messages", mask: ["msg.send"] });
});
