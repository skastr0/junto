// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { batch } from "@legendapp/state";
import { Node, Opened } from "../src/shared/model";
import { modelStore } from "../src/renderer/lib/use-model";
import { state$ } from "../src/renderer/lib/state";
import { rtsNode, readRtsNode, useRtsNodes } from "../src/renderer/lib/rts-selection";
import { terminal$ } from "../src/renderer/lib/terminal-state";
import { dock$ } from "../src/renderer/lib/dock-state";
import { profileDialog$ } from "../src/renderer/lib/profiles-state";
import { writeSkipReseatConfirm } from "../src/renderer/lib/agent-reseat";

vi.hoisted(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
// Select a different harness without probing a real CLI or spawning a process.
// The re-seat control, native commands and surface actions are real.
vi.mock("../src/renderer/components/node-palette/AgentHarnessPick", () => ({
  AgentHarnessPick: ({ onConfigure }: { onConfigure: (value: { harness: "claude" }) => void }) =>
    <button onClick={() => onConfigure({ harness: "claude" })}>Pick Claude</button>,
}));
import { RtsBottomBar } from "../src/renderer/components/rts/RtsBottomBar";

const canvas = "rts-write-placement";
const frame = { id: "subject", x: 123, y: 456, width: 310, height: 145, z: 4, color: "1" };
const moved = { x: 987, y: 654, width: 345, height: 167 };
const decode = Schema.decodeUnknownSync(Node);
let releaseCanvas: () => void;
let host: HTMLDivElement, root: Root;
let oldApi: typeof window.junto;
let errors: ReturnType<typeof vi.spyOn>, context: ReturnType<typeof vi.spyOn>;
const setApi = (value: unknown) => { (window as unknown as { junto: unknown }).junto = value; };
const flush = async () => { for (let i = 0; i < 25; ++i) await Promise.resolve(); };
const click = async (label: string) => {
  const button = document.querySelector(`[aria-label="${label}"]`) ?? [...document.querySelectorAll("button")].find(el => el.textContent === label);
  expect(button, label).toBeTruthy();
  await act(async () => { button!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
};
const publish = (node: Node) => batch(() => {
  modelStore.node$(canvas, node.id).set(node);
  modelStore.canvas$(canvas).nodeIds.set([node.id]);
});
const mount = async (fields: Record<string, unknown>) => {
  const node = decode({ ...frame, onRemove: "detach", ...fields });
  await act(async () => {
    publish(node); state$.selectedNodeId.set(node.id); state$.selectedNodeIds.set([node.id]);
    root.render(<RtsBottomBar minimap={null} />); await flush();
  });
  return node;
};
const move = async (node: Node) => {
  await act(async () => { publish(decode({ ...node, ...moved })); await flush(); });
};
const assertPlacement = () => {
  expect(modelStore.node$(canvas, frame.id).peek()).toMatchObject({ ...moved, color: frame.color });
  expect(modelStore.node$(canvas, frame.id).peek()?.kind).toBeTruthy();
  expect(state$.doc.peek().nodes).toEqual([]);
};
const agent = { kind: "agent", label: "Worker", agentKey: "local:worker", bindingId: "worker-binding", host: "local", harness: "codex", launch: { kind: "harness", argv: ["codex"] }, overseer: false, onRemove: "detach" };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  oldApi = window.junto;
  setApi({ modelCommand: async () => ({ seq: 1 }), onWorkSinkChanged: () => () => {}, workAttention: async () => ({ glances: [], items: [] }), hostsList: async () => ({ ok: true, hosts: [{ id: "local", label: "Local" }, { id: "remote-one", label: "Remote" }] }), terminalKill: async () => {}, terminalGet: async () => undefined });
  state$.canvasName.set(canvas); state$.settings.station.role.set("command-center");
  state$.doc.set({ nodes: [], edges: [] });
  releaseCanvas = modelStore.adopt(Schema.decodeUnknownSync(Opened)({ canvas, seq: 0, nodes: [], wires: [] }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); context.mockRestore(); errors.mockRestore();
  writeSkipReseatConfirm(false); terminal$.openByNodeId.subject.delete(); profileDialog$.set(null);
  releaseCanvas();
  state$.selectedNodeId.set(""); state$.selectedNodeIds.set([]); state$.canvasName.set("");
  setApi(oldApi); vi.unstubAllGlobals();
});

it("never fabricates placement in the bar's public node view", async () => {
  await mount(agent);
  expect(rtsNode(canvas, "subject")).toMatchObject({ x: frame.x, y: frame.y, width: frame.width, height: frame.height, color: frame.color });
});

it("keeps placement when an open page URL editor saves after a move", async () => {
  const node = await mount({ kind: "page", url: "https://before.example", profile: "personal", host: "local" });
  await click("Page url"); await move(node);
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Page URL"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "https://after.example");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(modelStore.node$(canvas, frame.id).peek()).toMatchObject({ kind: "page", url: "https://after.example" }); assertPlacement();
});

it("keeps placement when browser binding editor save after a move", async () => {
  const page = await mount({ kind: "page", url: "https://example.test", profile: "personal", host: "local" });
  await click("Browser binding"); await move(page);
  await click("Page browser profile");
  const option = [...document.querySelectorAll('[role="option"]')].find(el => el.textContent?.trim() === "work")!;
  expect(option).toBeTruthy();
  await act(async () => { option.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
  expect(modelStore.node$(canvas, frame.id).peek()).toMatchObject({ kind: "page", profile: "work" }); assertPlacement();

});

it("keeps placement for task admission and wait writes from the bar", async () => {
  const task = await mount({ kind: "task", name: "Queue", host: "local" });
  await click("Who starts tasks"); await move(task); await click("Approval");
  expect(modelStore.node$(canvas, frame.id).peek()).toMatchObject({ kind: "task", contract: { incoming: { admission: "approval" } } }); assertPlacement();
  await click("Wait before starting"); await click("15m");
  expect(modelStore.node$(canvas, frame.id).peek()).toMatchObject({ kind: "task", contract: { incoming: { waitMs: 900000 } } }); assertPlacement();
});

it("re-seats from an already-open bar picker without replacing or moving the seat", async () => {
  const node = await mount(agent);
  writeSkipReseatConfirm(true);
  await click("Re-seat agent"); await move(node); await click("Pick Claude");
  expect(modelStore.node$(canvas, frame.id).peek()).toMatchObject({ kind: "agent", harness: "claude" }); assertPlacement();
});

it("opens a terminal using the current complete node after a quiet move", async () => {
  const node = await mount(agent); await move(node); await click("Open terminal");
  expect(terminal$.openByNodeId.subject.peek()).toMatchObject(moved); assertPlacement();
});

it("opens task creation and profile capture by identity without authoring placement", async () => {
  const task = await mount({ kind: "task", name: "Queue", host: "local" }); await move(task); await click("Add task");
  expect(Object.values(dock$.taskCreateById.peek())).toContainEqual(expect.objectContaining({ nodeId: "subject" })); assertPlacement();
  const node = await mount(agent); await move(node); await click("Save as profile");
  expect(profileDialog$.peek()).toEqual({ seatId: "subject" }); assertPlacement();
});

it("grants overseer by id without sending or changing placement", async () => {
  const node = await mount(agent); await move(node);
  const modelCommand = vi.fn(async (_command: unknown) => ({ seq: 1 }));
  setApi({ modelCommand });
  await click("Grant overseer");
  expect(modelCommand).toHaveBeenCalledWith(expect.objectContaining({ _tag: "GrantOverseer", id: "subject", overseer: true }));
  expect(modelCommand.mock.calls[0]?.[0]).not.toHaveProperty("node"); assertPlacement();
});

it("keeps native identity and excludes placement and paint order from the bar comparison", async () => {
  let renders = 0;
  let shown: Node | undefined;
  function Probe() {
    shown = useRtsNodes(canvas, ["subject"])[0];
    renders++;
    return <span>{shown?.kind === "agent" ? shown.label : ""}</span>;
  }
  const node = decode({ ...frame, ...agent });
  await act(async () => { publish(node); root.render(<Probe />); await flush(); });
  expect(shown).toMatchObject({ kind: "agent", ...frame, bindingId: "worker-binding" });
  expect(shown).not.toHaveProperty("ether");
  const before = renders;
  await act(async () => { publish(decode({ ...node, ...moved, z: 19 })); await flush(); });
  expect(renders).toBe(before);
  expect(readRtsNode(canvas, "subject")).toMatchObject({ kind: "agent", ...moved, z: 19 });
  await act(async () => { publish(decode({ ...node, ...moved, z: 19, label: "Renamed" })); await flush(); });
  expect(renders).toBe(before + 1);
  expect(shown).toMatchObject({ kind: "agent", ...moved, z: 19, label: "Renamed" });
});
