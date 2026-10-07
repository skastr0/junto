// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { asCanvasName, Command } from "../src/shared/model";
import { TasksCard, RequestsCard, ArtifactsCard, BoardCard } from "../src/renderer/components/work/WorkSurfaces";
import { SheetCard } from "../src/renderer/components/sheet/SheetCard";
import { SheetDetail } from "../src/renderer/components/sheet/SheetDetail";
import { setSheetCell, emptySheet } from "../src/shared/sheet";
import { PadCard } from "../src/renderer/components/pad/PadCard";
import { sheetStore } from "../src/renderer/lib/sheet-store";
import { modelStore } from "../src/renderer/lib/use-model";
import { EMPTY_SETTINGS, state$ } from "../src/renderer/lib/state";
import { dock$, taskCreateSurfaceId } from "../src/renderer/lib/dock-state";
import { initialWorkbenchState } from "../src/renderer/lib/surface-registry";
import { flushNodeSheetTyping, setNodeSheet, setNodeSheetTyping, undo, redo, flushPendingCanvasSave } from "../src/renderer/lib/mutations";
import { taskBoard, requests, artifacts, board, pad, sheet } from "./support/model-nodes";

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
  { id: "sheet", Card: SheetCard, field: "label" },
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
    modelCommand: command, modelSheetRead: async () => emptySheet(),
    onModelSheetChanged: () => () => {},
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
    sheet("sheet", { ...place, label: "Numbers" }), artifacts("artifacts", place), board("board", { ...place, label: "Bulletin" }), pad("pad", { ...place, label: "Sketch" }),
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

it("reads work card identities from native rows, and enqueue reads the current board", async () => {
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

it("opens the native sheet editor on its grid and flushes one cell on close", async () => {
  const close = () => root.render(<SheetCard nodeId="sheet" />);
  await act(async () => { root.render(<><SheetCard nodeId="sheet" /><SheetDetail nodeId="sheet" onClose={close} /></>); await flush(); });
  expect(document.body.querySelector('[data-testid="sheet-detail"]')?.textContent).toContain("Numbers");
  const cell = document.querySelector<HTMLInputElement>('input[aria-label="Column A row 1"]')!;
  expect(cell).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(cell, "Oak");
    cell.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Close sheet"]')!.click(); await flush(); });
  expect(command).toHaveBeenCalledOnce();
  expect(command.mock.calls[0]![0]).toEqual({ _tag: "WriteSheet", canvas, id: "sheet", grid: setSheetCell(emptySheet(), "r1", "c1", "Oak") });
  expect(host.textContent).toContain("Oak");
  expect(modelStore.node$(canvas, "sheet").peek()).toMatchObject({ kind: "sheet", ...place });
  await act(async () => { root.render(<><SheetCard nodeId="sheet" /><SheetDetail nodeId="sheet" onClose={close} /></>); await flush(); });
  expect(document.querySelector<HTMLInputElement>('input[aria-label="Column A row 1"]')!.value).toBe("Oak");
  await act(async () => { close(); await flush(); });
  expect(command).toHaveBeenCalledOnce();
});

it("keeps a typing burst's original grid for undo even while the first write is pending", async () => {
  await act(async () => { root.render(<SheetCard nodeId="sheet" />); await flush(); });
  const before = sheetStore.gridOf(canvas, "sheet")!;
  const first = setSheetCell(before, "r1", "c1", "O");
  const last = setSheetCell(first, "r1", "c1", "Oak");
  let finish!: () => void;
  command.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ seq: 1 }); }));
  await act(async () => { setNodeSheetTyping("sheet", first); setNodeSheetTyping("sheet", last); for (let i = 0; i < 10; i++) await Promise.resolve(); });
  expect(host.textContent).toContain("Oak");
  await act(async () => { finish(); await flush(); setNodeSheet("sheet", last); flushNodeSheetTyping("sheet"); await flush(); });
  expect(command).toHaveBeenCalledTimes(2);
  await act(async () => { undo(); await flush(); });
  expect(command.mock.calls[2]![0]).toMatchObject({ _tag: "WriteSheet", grid: before });
  expect(sheetStore.gridOf(canvas, "sheet")).toEqual(before);
  await act(async () => { redo(); await flush(); });
  expect(command.mock.calls[3]![0]).toMatchObject({ _tag: "WriteSheet", grid: last });
  expect(sheetStore.gridOf(canvas, "sheet")).toEqual(last);
  expect(modelStore.node$(canvas, "sheet").peek()).toMatchObject({ kind: "sheet", ...place });
});

it("does not write a released draft twice or write through a removed sheet", async () => {
  await act(async () => { root.render(<SheetCard nodeId="sheet" />); await flush(); });
  const grid = setSheetCell(emptySheet(), "r1", "c1", "Oak");
  await act(async () => { setNodeSheet("sheet", grid); await flush(); root.render(null); await flush(); setNodeSheet("sheet", grid); await flush(); });
  expect(command).toHaveBeenCalledOnce();
  modelStore.node$(canvas, "sheet").delete();
  setNodeSheet("sheet", setSheetCell(grid, "r1", "c1", "Pine")); await flush();
  expect(command).toHaveBeenCalledOnce();
});

it("rereads a refused sheet write, remembers no failed undo, and allows the same draft to retry", async () => {
  (window as unknown as { junto: unknown }).junto = { ...window.junto,
    modelOpen: async () => ({ canvas: asCanvasName(canvas), seq: 0, nodes: [...modelStore.canvasOf(canvas).nodes.values()], wires: [] }),
  };
  await act(async () => { root.render(<SheetCard nodeId="sheet" />); await flush(); });
  const original = sheetStore.gridOf(canvas, "sheet")!;
  const draft = setSheetCell(original, "r1", "c1", "Oak");
  command.mockRejectedValueOnce(new Error("Sheet write refused"));
  await act(async () => { setNodeSheet("sheet", draft); await flush(); });
  expect(state$.error.peek()).toContain("Sheet write refused");
  expect(state$.canUndo.peek()).toBe(false);
  expect(sheetStore.gridOf(canvas, "sheet")).toEqual(original);
  await act(async () => { setNodeSheet("sheet", draft); await flush(); });
  expect(command).toHaveBeenCalledTimes(2);
  expect(sheetStore.gridOf(canvas, "sheet")).toEqual(draft);
  expect(state$.error.peek()).toBe("");
});
