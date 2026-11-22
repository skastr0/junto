// @vitest-environment jsdom
// A change of pixel ratio (another display, a browser zoom) resizes the
// backing store (issue 915): the CSS size does not change, so the resize
// observer is silent, and the shell listens for the ratio itself.
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeGpu, settle } from "./gpu-canvas-fakes";

vi.mock("../src/window/canvas/shell/scene-bridge", () => ({ startSceneBridge: () => () => undefined }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const listeners = new Map<string, Set<() => void>>();

beforeEach(() => {
  vi.resetModules();
  listeners.clear();
  Object.defineProperty(navigator, "gpu", { value: fakeGpu().gpu, configurable: true });
  vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: (_: string, listener: () => void) => {
      if (!listeners.has(query)) listeners.set(query, new Set());
      listeners.get(query)!.add(listener);
    },
    removeEventListener: (_: string, listener: () => void) => listeners.get(query)?.delete(listener),
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return { configure: () => undefined, unconfigure: () => undefined, getCurrentTexture: () => ({ createView: () => ({}) }) };
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  act(() => root.unmount());
  host.remove();
  (await import("../src/window/canvas/shell/gpu-device")).resetPageDeviceKeeperForTest();
  delete (window as { __juntoCanvas?: unknown }).__juntoCanvas;
  vi.unstubAllGlobals();
});

describe("the pixel ratio", () => {
  it("resizes the engine at the new ratio when the display's density changes, and listens for the next", async () => {
    Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
    const state = await import("../src/window/lib/state");
    state.state$.canvasName.set("factory");
    const { GpuCanvas, mountedGpuEngine } = await import("../src/window/canvas/shell/GpuCanvas");
    await act(async () => {
      root.render(<StrictMode><GpuCanvas onUnavailable={() => undefined} /></StrictMode>);
      await settle();
    });
    const engine = mountedGpuEngine() as unknown as { input: (event: { kind: string; pixelRatio?: number }) => void };
    const ratios: number[] = [];
    const input = engine.input.bind(engine);
    engine.input = (event) => {
      if (event.kind === "resize") ratios.push(event.pixelRatio!);
      input(event);
    };
    const at1 = [...(listeners.get("(resolution: 1dppx)") ?? [])];
    expect(at1).toHaveLength(1);
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    act(() => at1[0]!());
    expect(ratios).toEqual([2]);
    // The old query is dropped and the new ratio is watched.
    expect(listeners.get("(resolution: 1dppx)")?.size).toBe(0);
    expect(listeners.get("(resolution: 2dppx)")?.size).toBe(1);
  });
});
