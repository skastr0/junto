// @vitest-environment jsdom
import { ReactFlowProvider } from "@xyflow/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { asCanvasName } from "../src/shared/model";
import { Canvas } from "../src/renderer/components/Canvas";
import { modelStore } from "../src/renderer/lib/use-model";
import { dock$, noteSurfaceId, closeAllWorkbenchSurfaces } from "../src/renderer/lib/dock-state";
import { newGit } from "../src/renderer/lib/model-factories";
import { EMPTY_SETTINGS, state$ } from "../src/renderer/lib/state";
import { page, note, seat } from "./support/model-nodes";

vi.hoisted(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  HTMLElement.prototype.scrollIntoView = () => {};
});

let root: Root;
let host: HTMLDivElement;
let release: () => void;
const canvas = "canvas-window-native-reader";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1280);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  state$.settings.set(EMPTY_SETTINGS);
  state$.canvasName.set(canvas);
  release = modelStore.adopt({ canvas: asCanvasName(canvas), seq: 0, wires: [], nodes: [
    note("memo", "Window model note"), seat("planner", { label: "Planner", x: 300 }),
    page("web", { url: "https://native.example.com", x: 600 }),
    newGit({ x: 900, y: 0, z: 1 }, "/native/repo", "Native repository"),
  ] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});

afterEach(() => {
  act(() => { root.unmount(); closeAllWorkbenchSurfaces(); }); release(); host.remove();
  state$.editNodeId.set("");
  state$.canvasName.set(""); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("draws the canvas and minimap from model rows while the document stays empty", async () => {
  await act(async () => { root.render(<ReactFlowProvider><Canvas /></ReactFlowProvider>); });
  expect(host.querySelector('[data-id="memo"]')).not.toBeNull();
  expect(host.querySelector('[data-id="planner"]')).not.toBeNull();
  expect(host.textContent).toContain("Window model note");
  expect(host.textContent).toContain("Planner");
  expect(host.textContent).toContain("native.example.com");
  expect(host.textContent).toContain("Native repository");
  await act(async () => { state$.editNodeId.set("memo"); });
  expect(dock$.noteById[noteSurfaceId("memo")].peek()?.draft).toBe("Window model note");
});
