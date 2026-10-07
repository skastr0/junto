// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { Node, Wire } from "../src/shared/model";
import { modelStore } from "../src/renderer/lib/use-model";
import { state$ } from "../src/renderer/lib/state";
import { emptyHotbarSlots } from "../src/renderer/lib/hotbar-slots";
import { SaveToGroupPicker } from "../src/renderer/components/rts/SaveToGroupPicker";
import { CronScheduleSurface } from "../src/renderer/components/nodes/CronScheduleSurface";
import { PadEditor } from "../src/renderer/components/pad/PadEditor";
import { PadPin, emptyPad } from "../src/shared/pad";
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
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  state$.canvasName.set(canvas);
  // The native readers must work even when the retired copy has no nodes.
  state$.doc.set({ nodes: [], edges: [] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  modelStore.canvas$(canvas).nodes.set({});
  modelStore.canvas$(canvas).wires.set({});
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

const publishWire = (input: unknown) => {
  const wire = Schema.decodeUnknownSync(Wire)(input);
  modelStore.wire$(canvas, wire.id).set(wire);
};

it("a mounted cron follows its native schedule and connected actions", async () => {
  const cron = { ...rect, kind: "cron", label: "Morning", host: "local" };
  publish({ ...cron, expression: "0 9 * * *" });
  await act(async () => root.render(<CronScheduleSurface node={{ id: "subject" }} onClose={() => {}} />));
  expect(document.querySelector<HTMLInputElement>('[aria-label="Time of day"]')?.value).toBe("09:00");
  expect(document.body.textContent).toContain("Nothing connected yet");
  await act(async () => {
    publish({ ...cron, expression: "30 14 * * *" });
    publish({ ...rect, id: "tasks", kind: "task", name: "Queue" });
    publishWire({ id: "fire", from: "subject", to: "tasks", verb: "enqueues" });
  });
  expect(document.querySelector<HTMLInputElement>('[aria-label="Time of day"]')?.value).toBe("14:30");
  expect(document.body.textContent).toContain("1 linked action");
  await act(async () => modelStore.node$(canvas, "subject").delete());
  expect(document.querySelector('[aria-label="Time of day"]')).toBeNull();
});

it("the mounted pad mention picker follows inbound native seats and wires", async () => {
  publish({ ...rect, kind: "pad", label: "Sketch" });
  const seat = { ...rect, id: "worker", kind: "agent", label: "Scout", agentKey: "local:scout",
    harness: "codex", host: "local", bindingId: "binding", overseer: false, onRemove: "detach" };
  publish(seat);
  publishWire({ id: "edits", from: "worker", to: "subject", verb: "edits" });
  const pin = Schema.decodeUnknownSync(PadPin)({ id: "pin", x: 0, y: 0, z: 0, mentions: [], posts: [], unread: false });
  const pad = { ...emptyPad(), pins: [pin] };
  await act(async () => root.render(<PadEditor pad={pad} padNodeId="subject" onCommit={async () => ({ ok: true, pad })}
    onReadPad={async () => pad} onClose={() => {}} />));
  const svg = host.querySelector<SVGSVGElement>('[data-testid="pad-svg"]')!;
  svg.setPointerCapture = () => {};
  await act(async () => svg.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 0 })));
  const reply = host.querySelector<HTMLTextAreaElement>('[aria-label="Pin reply"]')!;
  expect(reply).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(reply, "@");
    reply.setSelectionRange(1, 1);
    reply.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.textContent).toContain("Scout");
  await act(async () => publish({ ...seat, label: "Renamed Scout" }));
  expect(host.textContent).toContain("Renamed Scout");
  await act(async () => modelStore.wire$(canvas, "edits").delete());
  expect(host.textContent).not.toContain("Renamed Scout");
});
