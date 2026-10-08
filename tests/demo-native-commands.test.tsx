// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { asCanvasName, asNodeId, asWireId, Command, Node } from "../src/shared/model";
import type { DemoScenario } from "../src/shared/demo";
import { modelStore } from "../src/renderer/lib/use-model";
import { EMPTY_SETTINGS, state$ } from "../src/renderer/lib/state";
import { flushPendingCanvasSave, undo } from "../src/renderer/lib/mutations";
import { InspectorPanel } from "../src/renderer/components/InspectorPanel";
import { executeBeat, resetDemoCanvas } from "../src/renderer/demo/ops";
import { demo$, startTake, stopTake } from "../src/renderer/demo/conductor";
import { demoScenarios } from "../src/renderer/demo/scenarios";

vi.hoisted(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

let canvas: string;
let counter = 0;
let release: () => void;
let root: Root;
let host: HTMLDivElement;
let oldApi: typeof window.junto;
let command: ReturnType<typeof vi.fn>;
const scenario: DemoScenario = { id: "native-proof", title: "Native proof", bpm: 120, beats: [] };
const decodeNode = Schema.decodeUnknownSync(Node);
const note = (id: string, text: string) => decodeNode({ id, kind: "note", text, x: 110, y: 220, width: 240, height: 96, z: 0 });
const seat = decodeNode({ id: "seat", kind: "agent", label: "Planner", agentKey: "local:planner", host: "local", bindingId: "binding", harness: "codex", overseer: false, onRemove: "detach", x: 110, y: 220, width: 240, height: 96, z: 0 });
const flush = async () => { await flushPendingCanvasSave(); for (let i = 0; i < 30; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  canvas = `demo-native-${++counter}`;
  let seq = 0;
  command = vi.fn(async (input: unknown) => {
    Schema.decodeUnknownSync(Command)(input, { onExcessProperty: "error" });
    return { seq: ++seq };
  });
  oldApi = window.junto;
  (window as unknown as { junto: unknown }).junto = {
    modelCommand: command, demoWriteEdl: vi.fn(async () => ({ ok: true })),
    onWorkSinkChanged: () => () => {}, workAttention: async () => ({ glances: [], items: [] }),
    onWorkMailChanged: () => () => {}, workMailPage: async () => ({ items: [] }),
  };
  state$.settings.set(EMPTY_SETTINGS); state$.settings.station.role.set("command-center");
  state$.canvasName.set(canvas);
  state$.selectedNodeId.set(""); state$.selectedNodeIds.set([]); state$.actorRefs.set([]);
  state$.saveState.set("saved"); state$.error.set("");
  release = modelStore.adopt({ canvas: asCanvasName(canvas), seq: 0, nodes: [], wires: [] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});

afterEach(async () => {
  stopTake();
  await act(async () => { await flush(); root.unmount(); });
  release(); host.remove();
  modelStore.canvas$(canvas).nodes.set({}); modelStore.canvas$(canvas).wires.set({});
  state$.canvasName.set(""); state$.selectedNodeId.set("");
  (window as unknown as { junto: unknown }).junto = oldApi;
  vi.useRealTimers(); vi.unstubAllGlobals();
});

it("shows beat additions through the native store and removes incident wires in one act", async () => {
  await act(async () => { root.render(<InspectorPanel />); });
  await act(async () => {
    executeBeat(scenario, { at: 0, ops: [
      { kind: "add-nodes", nodes: [seat, decodeNode({ id: "queue", kind: "task", name: "Backlog", x: 110, y: 220, width: 240, height: 96, z: 0 })] },
      { kind: "add-edges", edges: [{ id: asWireId("work"), from: asNodeId("queue"), to: seat.id, verb: "works" }] },
      { kind: "select", nodeIds: ["queue"] },
    ] });
    await flush();
  });
  expect(command).toHaveBeenCalledOnce();
  expect(command.mock.calls[0]![0]).toMatchObject({ _tag: "Batch", steps: [{ _tag: "Add" }, { _tag: "Add" }] });
  expect(document.querySelector(".inspector-title")?.textContent).toBe("Backlog");
  expect(modelStore.wire$(canvas, "work").peek()?.verb).toBe("works");
  await act(async () => { executeBeat(scenario, { at: 1, ops: [{ kind: "remove-nodes", ids: ["queue"] }] }); await flush(); });
  expect(command.mock.calls[1]![0]).toEqual({ _tag: "Remove", canvas, nodes: ["queue"], wires: ["work"] });
  expect(modelStore.node$(canvas, "queue").peek()).toBeUndefined();
  expect(modelStore.wire$(canvas, "work").peek()).toBeUndefined();
  expect(document.querySelector(".inspector-panel")).toBeNull();
  await act(async () => { undo(); await flush(); });
  expect(command).toHaveBeenCalledTimes(2);
});

it("ends a tween with one rounded Move that preserves size and kind", async () => {
  executeBeat(scenario, { at: 0, ops: [{ kind: "add-nodes", nodes: [note("note", "Before")] }] });
  await flush(); command.mockClear();
  executeBeat(scenario, { at: 1, ops: [{ kind: "tween-nodes", moves: [{ id: "note", x: 350.4, y: 470.8 }], durationBeats: 2 }] });
  await flush();
  expect(command).toHaveBeenCalledExactlyOnceWith({ _tag: "Move", canvas, moves: [{ id: "note", x: 350, y: 471 }] });
  expect(modelStore.node$(canvas, "note").peek()).toMatchObject({ kind: "note", x: 350, y: 471, width: 240, height: 96 });
});

it("resets main and the native store before a second take reuses its deterministic ids", async () => {
  vi.useFakeTimers();
  const take: DemoScenario = { ...scenario, beats: [{ at: 0, ops: [{ kind: "add-nodes", nodes: [note("note", "Take")] }] }] };
  startTake(take); await flush(); await vi.advanceTimersByTimeAsync(0); await flush();
  expect(modelStore.node$(canvas, "note").peek()?.kind).toBe("note");
  stopTake(); command.mockClear();
  startTake(take); await flush(); await vi.advanceTimersByTimeAsync(0); await flush();
  expect(command.mock.calls.map(call => call[0]._tag)).toEqual(["Remove", "Add"]);
  expect(modelStore.canvasOf(canvas).nodes.size).toBe(1);
  expect(demo$.running.peek()).toBe(true);
});

it("keeps a stopped take cancelled when another starts during its reset", async () => {
  vi.useFakeTimers();
  executeBeat(scenario, { at: 0, ops: [{ kind: "add-nodes", nodes: [note("old", "Old")] }] });
  await flush();
  let finish!: () => void;
  command.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ seq: 2 }); }));
  const take = (id: string): DemoScenario => ({ ...scenario, id, beats: [{ at: 0, ops: [{ kind: "add-nodes", nodes: [note(id, id)] }] }] });
  startTake(take("cancelled"));
  for (let i = 0; i < 10; i++) await Promise.resolve();
  stopTake(); startTake(take("current"));
  finish(); await flush(); await vi.advanceTimersByTimeAsync(0); await flush();
  expect(modelStore.node$(canvas, "cancelled").peek()).toBeUndefined();
  expect(modelStore.node$(canvas, "current").peek()?.kind).toBe("note");
  expect(modelStore.canvasOf(canvas).nodes.size).toBe(1);
});

it.each(Object.values(demoScenarios))("decodes and applies all graph beats in $id without reading the window document", async (take) => {
  for (const beat of take.beats) {
    executeBeat(take, { ...beat, ops: beat.ops.filter(op => ["add-nodes", "add-edges", "remove-nodes"].includes(op.kind)) });
    await flush();
    expect(state$.error.peek(), `beat ${beat.at}`).toBe("");
  }
  expect(command.mock.calls.length).toBeGreaterThan(0);
  resetDemoCanvas(); await flush();
  expect(modelStore.canvasOf(canvas).nodes.size).toBe(0);
  expect(modelStore.canvasOf(canvas).wires.size).toBe(0);
});
