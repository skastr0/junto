// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { asCanvasName, Command } from "../src/shared/model";
import { TasksCard, RequestsCard, ArtifactsCard, BoardCard } from "../src/renderer/components/work/WorkSurfaces";
import { PadCard } from "../src/renderer/components/pad/PadCard";
import { modelStore } from "../src/renderer/lib/use-model";
import { EMPTY_SETTINGS, state$ } from "../src/renderer/lib/state";
import { dock$, taskCreateSurfaceId } from "../src/renderer/lib/dock-state";
import { initialWorkbenchState } from "../src/renderer/lib/surface-registry";
import { flushPendingCanvasSave } from "../src/renderer/lib/mutations";
import { taskBoard, requests, artifacts, board, pad } from "./support/model-nodes";

vi.hoisted(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

let root: Root;
let host: HTMLDivElement;
let release: () => void;
let oldApi: typeof window.junto;
let canvas: string;
let count = 0;
let command: ReturnType<typeof vi.fn>;
const flush = async () => { await flushPendingCanvasSave(); for (let i = 0; i < 30; i++) await Promise.resolve(); };
const place = { x: 110, y: 220, width: 300, height: 160, z: 4 };
const cards = [
  { id: "task", Card: TasksCard, field: "name" },
  { id: "requests", Card: RequestsCard, field: "name" },
  { id: "board", Card: BoardCard, field: "label" },
  { id: "pad", Card: PadCard, field: "label" },
] as const;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  canvas = `native-work-card-${++count}`;
  let seq = 0;
  command = vi.fn(async (input: unknown) => {
    Schema.decodeUnknownSync(Command)(input, { onExcessProperty: "error" });
    return { seq: ++seq };
  });
  oldApi = window.junto;
  (window as unknown as { junto: unknown }).junto = {
    modelCommand: command,
    onWorkSinkChanged: () => () => {},
    workSinkPage: async ({ kind }: { kind: string }) => kind === "pad"
      ? { kind, glance: { revision: 0, shapeCount: 0, unreadPinCount: 0 } }
      : { kind, items: [] },
  };
  state$.settings.set(EMPTY_SETTINGS); state$.settings.station.role.set("command-center");
  state$.canvasName.set(canvas); state$.doc.set({ nodes: [], edges: [] });
  state$.error.set(""); state$.saveState.set("saved"); dock$.registry.set(initialWorkbenchState());
  release = modelStore.adopt({ canvas: asCanvasName(canvas), seq: 0, wires: [], nodes: [
    taskBoard("task", { ...place, name: "Backlog" }), requests("requests", { ...place, name: "Decisions" }),
    artifacts("artifacts", place), board("board", { ...place, label: "Bulletin" }), pad("pad", { ...place, label: "Sketch" }),
  ] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { await flush(); root.unmount(); });
  release(); host.remove(); dock$.registry.set(initialWorkbenchState());
  modelStore.canvas$(canvas).nodes.set({}); state$.canvasName.set("");
  (window as unknown as { junto: unknown }).junto = oldApi;
  vi.unstubAllGlobals();
});

it("reads all five card identities from native rows, and enqueue reads the current board", async () => {
  await act(async () => { root.render(<><TasksCard nodeId="task" /><RequestsCard nodeId="requests" /><ArtifactsCard nodeId="artifacts" /><BoardCard nodeId="board" /><PadCard nodeId="pad" /></>); await flush(); });
  for (const label of ["Backlog", "Decisions", "artifacts", "Bulletin", "Sketch"]) expect(host.textContent).toContain(label);
  await act(async () => { modelStore.node$(canvas, "task").set(taskBoard("task", { ...place, name: "Current board" })); await flush(); });
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="tasks-card-enqueue"]')!.click(); await flush(); });
  expect(dock$.taskCreateById[taskCreateSurfaceId("task")].peek()).toMatchObject({ nodeId: "task", title: "Current board" });
  expect(state$.doc.peek().nodes).toEqual([]);
  expect(command).not.toHaveBeenCalled();
});

it.each(cards)("renames the $id card by command without changing its placement", async ({ id, Card, field }) => {
  await act(async () => { root.render(<Card nodeId={id} renaming onRenameDone={() => {}} />); await flush(); });
  const input = host.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Renamed");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await flush(); });
  expect(command).toHaveBeenCalledExactlyOnceWith({ _tag: "Edit", canvas, id, change: { kind: id, [field]: "Renamed" } });
  expect(modelStore.node$(canvas, id).peek()).toMatchObject({ kind: id, ...place, [field]: "Renamed" });
  expect(state$.error.peek()).toBe("");
});
