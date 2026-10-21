// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { THIS_MACHINE } from "./support/machines";
import { Schema } from "effect";
import { batch } from "@legendapp/state";
import { Node, Opened } from "../src/shared/model";
import { titleOf } from "../src/shared/model/title";
import { modelStore } from "../src/renderer/lib/use-model";
import { state$ } from "../src/renderer/lib/state";

vi.hoisted(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
import { RtsBottomBar } from "../src/renderer/components/rts/RtsBottomBar";

// Every kind is renamed from the bottom bar's selection card, by the same
// key, and the name lands in the field that kind keeps it in.

const canvas = "rts-rename";
const frame = { id: "subject", x: 10, y: 20, width: 300, height: 140, z: 1 };
const decode = Schema.decodeUnknownSync(Node);
let releaseCanvas: () => void;
let host: HTMLDivElement, root: Root;
let oldApi: typeof window.junto;
let errors: ReturnType<typeof vi.spyOn>, context: ReturnType<typeof vi.spyOn>;
const setApi = (value: unknown) => { (window as unknown as { junto: unknown }).junto = value; };
const flush = async () => { for (let i = 0; i < 25; ++i) await Promise.resolve(); };
const renameKey = () => document.querySelector<HTMLButtonElement>('.rts-panel--cmd [aria-label="Rename"]');

const mount = async (fields: Record<string, unknown>) => {
  const node = decode({ ...frame, ...fields });
  await act(async () => {
    batch(() => {
      modelStore.node$(canvas, node.id).set(node);
      modelStore.canvas$(canvas).nodeIds.set([node.id]);
    });
    state$.selectedNodeId.set(node.id); state$.selectedNodeIds.set([node.id]);
    root.render(<RtsBottomBar minimap={null} />); await flush();
  });
  return node;
};

const rename = async (field: string, name: string) => {
  await act(async () => { renameKey()!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${field}"]`);
  expect(input, field).toBeTruthy();
  expect(document.activeElement).toBe(input);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await flush(); });
  expect(document.querySelector(`input[aria-label="${field}"]`)).toBeNull();
};

const named = () => modelStore.node$(canvas, frame.id).peek();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  oldApi = window.junto;
  setApi({ modelCommand: async () => ({ seq: 1 }), onWorkSinkChanged: () => () => {}, workAttention: async () => ({ glances: [], items: [] }), hostsList: async () => ({ ok: true, hosts: [] }), terminalKill: async () => {}, terminalGet: async () => undefined });
  state$.canvasName.set(canvas);
  releaseCanvas = modelStore.adopt(Schema.decodeUnknownSync(Opened)({ canvas, seq: 0, nodes: [], wires: [] }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); context.mockRestore(); errors.mockRestore();
  releaseCanvas();
  state$.selectedNodeId.set(""); state$.selectedNodeIds.set([]); state$.canvasName.set("");
  setApi(oldApi); vi.unstubAllGlobals();
});

const seat = { kind: "agent", label: "Worker", agentKey: `${THIS_MACHINE}:worker`, bindingId: "worker-binding", host: THIS_MACHINE, harness: "codex", overseer: false };

it.each([
  ["agent", seat, "Agent name", { label: "Captain" }],
  ["terminal", { kind: "terminal", host: THIS_MACHINE, bindingId: "shell-binding" }, "Terminal name", { label: "Captain" }],
  ["task", { kind: "task", name: "Queue" }, "Task name", { name: "Captain" }],
  ["artifacts", { kind: "artifacts" }, "Artifacts name", { label: "Captain" }],
  ["automations", { kind: "automations" }, "Automations name", { label: "Captain" }],
  ["git", { kind: "git", cwd: "/tmp/repo" }, "Git name", { label: "Captain" }],
  ["note", { kind: "note", text: "# Plan\nstep one" }, "Note name", { text: "# Captain\nstep one" }],
  ["label", { kind: "label", text: "North" }, "Label name", { text: "Captain" }],
  ["file", { kind: "file", path: "/tmp/notes.md" }, "File name", { label: "Captain" }],
  ["link", { kind: "link", url: "https://example.test" }, "Link name", { label: "Captain" }],
  ["page", { kind: "page", url: "https://example.test", profile: "work", onRemove: "detach" }, "Page name", { label: "Captain" }],
] as const)("renames a %s from the selection card", async (_kind, fields, field, written) => {
  await mount(fields);
  await rename(field, "Captain");
  expect(named()).toMatchObject({ ...written, x: frame.x, y: frame.y });
  expect(titleOf(named()!)).toBe("Captain");
});

it("renames a region from its card, and clears the name when emptied", async () => {
  await mount({ kind: "region", label: "Old room", hold: false });
  await rename("Region name", "Captain");
  expect(named()).toMatchObject({ kind: "region", label: "Captain" });
  await rename("Region name", "");
  expect(named()).not.toHaveProperty("label");
});

it("keeps the old name on Escape, and a seat keeps its name when emptied", async () => {
  await mount(seat);
  await act(async () => { renameKey()!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  expect(renameKey()!.getAttribute("aria-pressed")).toBe("true");
  expect(renameKey()!.title).toBe("Cancel rename");
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Agent name"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Changed");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await flush(); });
  expect(named()).toMatchObject({ label: "Worker" });
  // A key closed the field, so focus goes back to the Rename key, which keeps its name.
  expect(document.activeElement).toBe(renameKey());
  expect(renameKey()!.getAttribute("aria-pressed")).toBe("false");
  await rename("Agent name", "");
  expect(named()).toMatchObject({ label: "Worker" });
});

it("a page, a file or a link emptied goes back to being called by what it points at", async () => {
  await mount({ kind: "link", url: "https://example.test/a", label: "Handbook" });
  await rename("Link name", "");
  expect(named()).not.toHaveProperty("label");
  expect(titleOf(named()!)).toBe("example.test");
});

it("offers no rename for a peer or a stub, which only a read-only copy holds", async () => {
  for (const fields of [
    { kind: "peer", label: "Remote", host: "linux", seatId: `seat_${"a".repeat(64)}` },
    { kind: "stub", of: "file", label: "Plan" },
  ]) {
    await mount(fields);
    expect(document.querySelector(".rts-panel--cmd")).toBeTruthy();
    expect(renameKey()).toBeNull();
  }
});

it("has one rename key in the bar for a seat, in the selection card", async () => {
  await mount(seat);
  expect(document.querySelectorAll('[aria-label="Rename"]')).toHaveLength(1);
  expect(document.querySelector('.rts-panel--cmd [aria-label="Edit"]')).toBeNull();
});
