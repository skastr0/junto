// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { Node } from "../src/shared/model";
import { modelStore } from "../src/renderer/lib/use-model";
import { state$ } from "../src/renderer/lib/state";
import { emptyHotbarSlots } from "../src/renderer/lib/hotbar-slots";
import { SaveToGroupPicker } from "../src/renderer/components/rts/SaveToGroupPicker";
import { RegionPathsModal } from "../src/renderer/components/RegionPathsModal";

vi.mock("../src/renderer/components/node-palette/HostDirectoryPicker", () => ({
  HostDirectoryPicker: ({ initialPath }: { initialPath: string }) => <output data-testid="path">{initialPath}</output>,
}));

const canvas = "editor-native-reads";
const decode = Schema.decodeUnknownSync(Node);
let root: Root, host: HTMLDivElement;
const oldCanvas = state$.canvasName.peek();
const oldDoc = state$.doc.peek();
const oldSlots = state$.hotbarSlots.peek();
const publish = (input: unknown) => {
  const node = decode(input);
  modelStore.node$(canvas, node.id).set(node);
};
const rect = { id: "subject", x: 10, y: 20, width: 300, height: 200, z: 0 };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state$.canvasName.set(canvas);
  // The native readers must work even when the retired copy has no nodes.
  state$.doc.set({ nodes: [], edges: [] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  modelStore.canvas$(canvas).nodes.set({});
  state$.canvasName.set(oldCanvas); state$.doc.set(oldDoc); state$.hotbarSlots.set(oldSlots);
  vi.unstubAllGlobals();
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
  publish({ ...region, defaults: { paths: { local: "/before" } } });
  await act(async () => root.render(<RegionPathsModal nodeId="subject" onClose={() => {}} />));
  expect(document.querySelector('[data-testid="path"]')?.textContent).toBe("/before");
  await act(async () => publish({ ...region, defaults: { paths: { local: "/after" } } }));
  expect(document.querySelector('[data-testid="path"]')?.textContent).toBe("/after");
  await act(async () => modelStore.node$(canvas, "subject").delete());
  expect(document.querySelector('[data-testid="path"]')).toBeNull();
});
