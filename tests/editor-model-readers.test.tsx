// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { OTHER_MACHINE, THIS_MACHINE } from "./support/machines";
import { Schema } from "effect";
import { Node } from "../src/shared/model";
import { modelStore } from "../src/renderer/lib/use-model";
import { state$ } from "../src/renderer/lib/state";
import { emptyHotbarSlots } from "../src/renderer/lib/hotbar-slots";
import { SaveToGroupPicker } from "../src/renderer/components/rts/SaveToGroupPicker";
import { CommandBar } from "../src/renderer/components/command-bar/CommandBar";
import { dock$ } from "../src/renderer/lib/dock-state";
import { agentSeat$ } from "../src/renderer/lib/agent-seat-state";
import { RegionPathsModal } from "../src/renderer/components/RegionPathsModal";

vi.mock("../src/renderer/components/node-palette/HostDirectoryPicker", () => ({
  HostDirectoryPicker: ({ initialPath }: { initialPath: string }) => <output data-testid="path">{initialPath}</output>,
}));

const canvas = "editor-native-reads";
const decode = Schema.decodeUnknownSync(Node);
let root: Root, host: HTMLDivElement;
const oldCanvas = state$.canvasName.peek();
const oldSlots = state$.hotbarSlots.peek();
const publish = (input: unknown) => {
  const node = decode(input);
  modelStore.node$(canvas, node.id).set(node);
};
const rect = { id: "subject", x: 10, y: 20, width: 300, height: 200, z: 0 };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  state$.canvasName.set(canvas);
  // The native readers must work even when the retired copy has no nodes.
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  modelStore.canvas$(canvas).nodes.set({});
  modelStore.canvas$(canvas).wires.set({});
  state$.canvasName.set(oldCanvas); state$.hotbarSlots.set(oldSlots);
  state$.settings.machine.name.set("");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("a mounted group picker follows native titles without a document copy", async () => {
  publish({ ...rect, kind: "note", text: "Scout" });
  const slots = emptyHotbarSlots(); slots[0] = { kind: "group", nodeIds: ["subject"] };
  state$.hotbarSlots.set(slots);
  await act(async () => root.render(<SaveToGroupPicker count={1} onPick={() => {}} />));
  expect(host.querySelector('[aria-label="Save 1 node to group 1, replaces Scout"]')).not.toBeNull();
  await act(async () => publish({ ...rect, kind: "note", text: "Renamed" }));
  expect(host.querySelector('[aria-label="Save 1 node to group 1, replaces Renamed"]')).not.toBeNull();
});

it("mounted region paths follow native defaults without a document copy", async () => {
  const region = { ...rect, kind: "region", label: "Team", hold: false };
  state$.settings.machine.name.set(THIS_MACHINE);
  publish({ ...region, defaults: { paths: { [THIS_MACHINE]: "/before", [OTHER_MACHINE]: "/elsewhere" } } });
  await act(async () => root.render(<RegionPathsModal nodeId="subject" onClose={() => {}} />));
  expect(document.querySelector('[data-testid="path"]')?.textContent).toBe("/before");
  await act(async () => publish({ ...region, defaults: { paths: { [THIS_MACHINE]: "/after", [OTHER_MACHINE]: "/elsewhere" } } }));
  expect(document.querySelector('[data-testid="path"]')?.textContent).toBe("/after");
  await act(async () => modelStore.node$(canvas, "subject").delete());
  expect(document.querySelector('[data-testid="path"]')).toBeNull();
});

it("the mounted command bar finds native region paths and opens current note content", async () => {
  publish({ ...rect, id: "region", kind: "region", label: "Research", hold: false, instruction: "Read carefully", width: 1000, height: 1000 });
  publish({ ...rect, kind: "note", text: "Before\nOriginal content" });
  await act(async () => root.render(<CommandBar />));
  expect(document.body.textContent).toContain("Before");
  expect(document.body.textContent).toContain("Read carefully");
  const input = document.querySelector<HTMLInputElement>('[data-testid="command-bar-input"]')!;
  const query = async (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await query("research");
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(2);
  expect(document.querySelector('[data-testid="command-bar-row-crumb"]')?.textContent).toContain("Research");
  await act(async () => publish({ ...rect, kind: "note", text: "After\nCurrent content" }));
  await query("after");
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
  await act(async () => document.querySelector('[role="option"]')!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, ctrlKey: true })));
  expect(state$.selectedNodeId.peek()).toBe("subject");
  expect(Object.values(dock$.noteById.peek()).find((note) => note.nodeId === "subject")).toMatchObject({ title: "After", draft: "After\nCurrent content" });
});

it("the command bar's native seat ring and line follow binding facts", async () => {
  publish({ ...rect, kind: "agent", label: "Scout", agentKey: `${THIS_MACHINE}:scout`, harness: "codex", host: THIS_MACHINE, bindingId: "native-bar-seat", overseer: true });
  await act(async () => root.render(<CommandBar />));
  expect(document.body.textContent).toContain("Scout");
  expect(document.body.textContent).not.toContain("wants your input");
  await act(async () => agentSeat$.byBindingId["native-bar-seat"].set({ bindingId: "native-bar-seat", state: "attention", reason: "Choose a destination" } as never));
  expect(document.body.textContent).toContain("wants your input");
  await act(async () => agentSeat$.byBindingId["native-bar-seat"].delete());
});
