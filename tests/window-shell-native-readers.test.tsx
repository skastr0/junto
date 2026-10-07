// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { Node, Wire } from "../src/shared/model";
import { nodeToDocument } from "../src/shared/model/from-document";
import { modelStore } from "../src/renderer/lib/use-model";
import { EMPTY_SETTINGS, state$ } from "../src/renderer/lib/state";
import { dock$, terminalSurfaceId } from "../src/renderer/lib/dock-state";
import { initialWorkbenchState } from "../src/renderer/lib/surface-registry";
import { terminal$ } from "../src/renderer/lib/terminal-state";
import { sidebarSections$ } from "../src/renderer/lib/sidebar-sections";
import { actorTerminalRailsPx } from "../src/renderer/lib/focus-measure";
import { InspectorPanel } from "../src/renderer/components/InspectorPanel";
import { SeatMessageForm, SeatMessageToolbarAction } from "../src/renderer/components/nodes/SeatMessage";
import { WorkFocusShell } from "../src/renderer/components/workbench/WorkFocusShell";

// The terminal contents do not determine the shell's rail width.
vi.mock("../src/renderer/components/workbench/WorkbenchPanes", () => ({ WorkbenchPanes: () => null }));
vi.hoisted(() => {
  HTMLElement.prototype.scrollIntoView = () => {};
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

let root: Root;
let host: HTMLDivElement;
let oldApi: typeof window.junto;
let canvas: string;
let counter = 0;
const decodeNode = Schema.decodeUnknownSync(Node);
const decodeWire = Schema.decodeUnknownSync(Wire);
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const publish = (id: string, fields: Record<string, unknown>) => {
  const node = decodeNode({ id, x: 100, y: 200, width: 300, height: 180, z: 1, ...fields });
  modelStore.node$(canvas, id).set(node);
  return node;
};
const agent = (label: string, bindingId = "binding") => ({
  kind: "agent", label, agentKey: "local:worker", harness: "codex", host: "local",
  bindingId, overseer: false, onRemove: "detach",
});
const mount = async (content: ReactNode) => act(async () => { root.render(content); await flush(); });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  canvas = `native-shell-${++counter}`;
  oldApi = window.junto;
  (window as unknown as { junto: unknown }).junto = {
    onWorkMailChanged: () => () => {}, workMailPage: async () => ({ items: [] }),
    onWorkSinkChanged: () => () => {}, workAttention: async () => ({ glances: [], items: [] }),
  };
  state$.settings.set(EMPTY_SETTINGS);
  state$.canvasName.set(canvas);
  state$.selectedNodeId.set(""); state$.selectedNodeIds.set([]);
  state$.actorRefs.set([]);
  dock$.registry.set(initialWorkbenchState());
  terminal$.openByNodeId.set({});
  sidebarSections$.open.set({});
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); await flush(); });
  host.remove();
  dock$.registry.set(initialWorkbenchState()); terminal$.openByNodeId.set({});
  sidebarSections$.open.set({});
  modelStore.canvas$(canvas).nodes.set({}); modelStore.canvas$(canvas).wires.set({});
  state$.canvasName.set(""); state$.selectedNodeId.set("");
  (window as unknown as { junto: unknown }).junto = oldApi;
  vi.unstubAllGlobals();
});

it("inspects a native selected note, follows text changes, and closes when it is removed", async () => {
  publish("note", { kind: "note", text: "Before\nBody before" });
  state$.selectedNodeId.set("note");
  await mount(<InspectorPanel />);
  expect(document.querySelector(".inspector-title")?.textContent).toBe("Before");
  expect(document.body.textContent).toContain("Body before");
  await act(async () => { publish("note", { kind: "note", text: "After\nBody after" }); await flush(); });
  expect(document.querySelector(".inspector-title")?.textContent).toBe("After");
  expect(document.body.textContent).toContain("Body after");
  await act(async () => { modelStore.node$(canvas, "note").delete(); await flush(); });
  expect(document.querySelector(".inspector-panel")).toBeNull();
});

it("messages the native seat's current binding and follows its name and removal", async () => {
  publish("seat", agent("Before", "binding-before"));
  const terminalManagedPrompt = vi.fn(async () => ({ ok: true, disposition: "submitted" }));
  (window as unknown as { junto: unknown }).junto = { ...window.junto, terminalManagedPrompt };
  await mount(<><SeatMessageToolbarAction id="seat" /><SeatMessageForm nodeIds={["seat"]} /></>);
  expect(document.querySelector('textarea[aria-label="Message Before"]')).toBeTruthy();
  await act(async () => { publish("seat", agent("After", "binding-after")); await flush(); });
  const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message After"]')!;
  expect(field).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Ship it");
    field.dispatchEvent(new Event("input", { bubbles: true })); await flush();
  });
  await act(async () => {
    const button = [...document.querySelectorAll("button")].find(button => button.textContent === "Send")!;
    button.click(); await flush();
  });
  expect(terminalManagedPrompt).toHaveBeenCalledWith({ bindingId: "binding-after", canvasName: canvas, nodeId: "seat", text: "Ship it", wake: true });
  expect(document.querySelector('[role="status"]')?.textContent).toBe("Sent to After.");
  await act(async () => { modelStore.node$(canvas, "seat").delete(); await flush(); });
  expect(document.querySelector('[data-testid="seat-message-open"]')).toBeNull();
  expect([...document.querySelectorAll("button")].find(button => button.textContent === "Send")?.disabled).toBe(true);
});

it("budgets the focused terminal's rail from native wires and follows collapse and disconnect", async () => {
  const seat = publish("seat", agent("Planner"));
  publish("peer", agent("Reviewer", "binding-peer"));
  terminal$.openByNodeId["seat"].set(nodeToDocument(seat));
  const id = terminalSurfaceId("seat");
  dock$.registry.set({ ...initialWorkbenchState(), surfaces: [{ id, kind: "terminal", zone: "focus" }], focusMru: [id] });
  await mount(<WorkFocusShell />);
  const rails = () => (document.querySelector(".focus-surface") as HTMLElement)?.style.getPropertyValue("--focus-terminal-rails");
  expect(rails()).toBe("0px");
  await act(async () => {
    modelStore.wire$(canvas, "connection").set(decodeWire({ id: "connection", from: "seat", to: "peer", verb: "messages" })); await flush();
  });
  expect(rails()).toBe(`${actorTerminalRailsPx("expanded")}px`);
  await act(async () => { sidebarSections$.open["seat-rail"].set(false); await flush(); });
  expect(rails()).toBe(`${actorTerminalRailsPx("collapsed")}px`);
  await act(async () => { modelStore.wire$(canvas, "connection").delete(); await flush(); });
  expect(rails()).toBe("0px");
});
