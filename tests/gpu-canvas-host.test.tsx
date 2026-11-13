// @vitest-environment jsdom
// The seam's done-test (docs/canvas-gpu-plan.md, milestone 0.3): turning the
// GPU canvas toggle 20 times with the app open leaves one device, no error,
// and the camera where it was. And with no adapter the old canvas is mounted
// and the reason said.

import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeGpu, settle, type FakeGpu } from "./gpu-canvas-fakes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Modules = {
  readonly CanvasHost: typeof import("../src/window/canvas/shell/CanvasHost").CanvasHost;
  readonly handoff: typeof import("../src/window/canvas/shell/camera-handoff");
  readonly device: typeof import("../src/window/canvas/shell/gpu-device");
  readonly state$: typeof import("../src/window/lib/state").state$;
};

let modules: Modules;
let host: HTMLDivElement;
let root: Root;
let gpu: FakeGpu;

const OPENING = { x: 120, y: -80, zoom: 0.75 };
const shown: Array<{ x: number; y: number; zoom: number }> = [];

/** Stands in for today's canvas: takes a handed camera or opens on its own, and leaves it on unmount. */
function LegacyCanvas() {
  useEffect(() => {
    const { takeCamera, leaveCamera } = modules.handoff;
    const name = modules.state$.canvasName.peek();
    const camera = takeCamera(name) ?? OPENING;
    shown.push(camera);
    return () => leaveCamera(name, camera);
  }, []);
  return <div data-testid="legacy-canvas" />;
}

const toggle = async (on: boolean): Promise<void> => {
  await act(async () => {
    modules.state$.settings.advanced.experimental.set({ gpuCanvas: on });
    await settle();
  });
};

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("JUNTO_GPU_CANVAS", "experimental");
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
    return { configure: () => undefined, unconfigure: () => undefined, getCurrentTexture: () => ({ createView: () => ({}) }) };
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  const [hostModule, handoff, device, state] = await Promise.all([
    import("../src/window/canvas/shell/CanvasHost"),
    import("../src/window/canvas/shell/camera-handoff"),
    import("../src/window/canvas/shell/gpu-device"),
    import("../src/window/lib/state"),
  ]);
  modules = { CanvasHost: hostModule.CanvasHost, handoff, device, state$: state.state$ };
  modules.state$.canvasName.set("factory");
  modules.state$.error.set("");
  shown.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  modules.device.resetPageDeviceKeeperForTest();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const mount = async (): Promise<void> => {
  await act(async () => {
    root.render(
      <StrictMode>
        <modules.CanvasHost legacy={<LegacyCanvas />} />
      </StrictMode>,
    );
    await settle();
  });
};

describe("the canvas switch", () => {
  it("swaps canvases 20 times live on one device, with no error, and the camera where it was", async () => {
    await mount();
    expect(host.querySelector("[data-testid=legacy-canvas]")).not.toBeNull();
    for (let i = 0; i < 20; i += 1) {
      await toggle(i % 2 === 0);
      const gpuShown = host.querySelector("[data-testid=gpu-canvas]") !== null;
      const legacyShown = host.querySelector("[data-testid=legacy-canvas]") !== null;
      expect([gpuShown, legacyShown]).toEqual(i % 2 === 0 ? [true, false] : [false, true]);
    }
    expect(gpu.devices).toHaveLength(1);
    expect(gpu.devices[0]?.destroyed()).toBe(false);
    expect(modules.device.pageDeviceKeeper().state()).toMatchObject({ kind: "ready", generation: 1 });
    expect(modules.state$.error.peek()).toBe("");
    // Every time the old canvas came back it showed the camera it opened on.
    expect(shown.length).toBeGreaterThan(10);
    for (const camera of shown) expect(camera).toEqual(OPENING);
  });

  it("mounts the old canvas and says why when the GPU offers no adapter", async () => {
    gpu = fakeGpu({ adapter: false });
    Object.defineProperty(navigator, "gpu", { value: gpu.gpu, configurable: true });
    modules.device.resetPageDeviceKeeperForTest();
    await toggle(true);
    await mount();
    expect(host.querySelector("[data-testid=gpu-canvas]")).toBeNull();
    expect(host.querySelector("[data-testid=legacy-canvas]")).not.toBeNull();
    expect(modules.state$.error.peek()).toMatch(/GPU canvas is on, but it cannot run here.*No WebGPU adapter/u);
  });
});
