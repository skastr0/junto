// @vitest-environment jsdom
/**
 * The GPU canvas shell's done-test (docs/canvas-gpu-plan.md, track G): React
 * commits nothing during a pan, a drag or a seat report; the test hook is
 * installed; the tier follows the camera; and the CanvasApi answers
 * synchronously from the shell's mirror.
 */
import { act, Profiler, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeGpu, settle, type FakeGpu } from "./gpu-canvas-fakes";
import { asCanvasName } from "@shared/model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Modules = {
  readonly GpuCanvas: typeof import("../src/window/canvas/shell/GpuCanvas").GpuCanvas;
  readonly mountedGpuEngine: typeof import("../src/window/canvas/shell/GpuCanvas").mountedGpuEngine;
  readonly canvasApi: typeof import("../src/window/canvas/shell/canvas-api");
  readonly state$: typeof import("../src/window/lib/state").state$;
  readonly tier: typeof import("../src/window/lib/canvas-tier");
  readonly device: typeof import("../src/window/canvas/shell/gpu-device");
};

let modules: Modules;
let host: HTMLDivElement;
let root: Root;
let gpu: FakeGpu;
let commits = 0;

beforeEach(async () => {
  vi.resetModules();
  gpu = fakeGpu();
  Object.defineProperty(navigator, "gpu", { value: gpu.gpu, configurable: true });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return {
      configure: () => undefined,
      unconfigure: () => undefined,
      getCurrentTexture: () => ({ createView: () => ({}) }),
    };
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  const [shell, api, state, tier, device] = await Promise.all([
    import("../src/window/canvas/shell/GpuCanvas"),
    import("../src/window/canvas/shell/canvas-api"),
    import("../src/window/lib/state"),
    import("../src/window/lib/canvas-tier"),
    import("../src/window/canvas/shell/gpu-device"),
  ]);
  modules = { GpuCanvas: shell.GpuCanvas, mountedGpuEngine: shell.mountedGpuEngine, canvasApi: api, state$: state.state$, tier, device };
  modules.state$.canvasName.set("factory");
  modules.state$.error.set("");
  commits = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  modules.device.resetPageDeviceKeeperForTest();
  delete (window as { __juntoCanvas?: unknown }).__juntoCanvas;
  vi.unstubAllGlobals();
});

const mount = async (): Promise<void> => {
  const { GpuCanvas } = modules;
  await act(async () => {
    root.render(
      <StrictMode>
        <Profiler id="canvas" onRender={() => { commits += 1; }}>
          <GpuCanvas onUnavailable={() => undefined} />
        </Profiler>
      </StrictMode>,
    );
    await settle();
  });
};

describe("the GPU canvas shell", () => {
  it("answers from the mirror and publishes the tier, with no React commit", async () => {
    await mount();
    const api = modules.canvasApi.canvasApi();
    expect(api).toBeDefined();
    const mounted = commits;

    await act(async () => {
      api!.moveCamera({ kind: "camera", camera: { x: -120, y: -80, zoom: 0.5 } });
      api!.moveCamera({ kind: "zoomTo", zoom: 0.16, about: { x: 10, y: 10 } });
      api!.setWireMode("loupe");
      api!.previewMoves?.([{ id: "a", x: 10, y: 10 }]);
      api!.focusNodes(["a", "b"], { durationMs: 0 });
      await settle();
    });

    // Every one of those is a pan, a drag or a camera move: no render.
    expect(commits).toBe(mounted);
    expect(modules.canvasApi.canvasApi()?.camera().zoom).toBeCloseTo(0.16);
    expect(document.documentElement.getAttribute("data-canvas-tier")).toBe("overview");
    expect(modules.tier.canvasTier$.peek()).toBe("overview");
  });

  it("the hook's resize grip is the part the engine picks, at the same point", async () => {
    await mount();
    const api = modules.canvasApi.canvasApi();
    const engine = modules.mountedGpuEngine();
    expect(api).toBeDefined();
    expect(engine).toBeDefined();
    const shellApi = api as unknown as { readonly applyScene: (ops: ReadonlyArray<unknown>) => void };
    const card = {
      id: "a",
      row: { id: "a", kind: "note", text: "alpha", x: 0, y: 0, width: 240, height: 120, z: 0 },
      derived: { regionDepth: 0, blocked: false, z: 0 },
    };
    await act(async () => {
      shellApi.applyScene([
        { kind: "load", canvas: asCanvasName("factory"), cards: [card], wires: [] },
        { kind: "selection", fact: { nodeIds: ["a"] } },
      ]);
      api!.moveCamera({ kind: "camera", camera: { x: 0, y: 0, zoom: 1 } });
      await settle();
    });
    const hook = (window as { __juntoCanvas?: { rectOf: (id: string, part?: string) => { x: number; y: number; width: number; height: number } | undefined } }).__juntoCanvas;
    const grip = hook!.rectOf("a", "resize");
    expect(grip).toBeDefined();
    const at = { x: grip!.x + grip!.width / 2, y: grip!.y + grip!.height / 2 };
    const hit = api!.pick(at);
    expect(hit?.nodeId).toBe("a");
    expect(hit?.part).toEqual({ kind: "resize", corner: "se" });
    // The card's middle is its body, so the whole part map lines up.
    expect(api!.pick({ x: 120, y: 60 })?.part).toEqual({ kind: "body" });
  });

  it("installs window.__juntoCanvas in test and development builds", async () => {
    await mount();
    const hook = (window as { __juntoCanvas?: { camera: () => { zoom: number }; ids: () => ReadonlyArray<string> } }).__juntoCanvas;
    expect(hook).toBeDefined();
    expect(hook!.ids()).toEqual([]);
    expect(hook!.camera()).toEqual(modules.canvasApi.canvasApi()!.camera());
  });
});
