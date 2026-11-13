/**
 * The GPU canvas shell (docs/canvas-gpu-architecture.md, sections 4 and 5).
 *
 * React renders this once. Everything after that reaches the engine outside
 * React: the theme through an observer, size and visibility through the
 * browser's own observers, and the camera through the hand-over. Nothing here
 * calls setState, so a camera move, a seat report or a drag never renders.
 */

import { useEffect, useRef } from "react";
import { state$ } from "../../lib/state";
import { themeMode$ } from "../../lib/theme-mode";
import { createEngine, type SeamEngine } from "../engine/engine";
import { leaveCamera, takeCamera } from "./camera-handoff";
import { pageDeviceKeeper } from "./gpu-device";

type Props = {
  /** Heard once if this machine cannot run the GPU canvas, with the reason. */
  readonly onUnavailable: (reason: string) => void;
};

const browserScheduler = {
  request: (frame: (now: number) => void): number => requestAnimationFrame(frame),
  cancel: (handle: number): void => cancelAnimationFrame(handle),
};

/** The engine the mounted GPU canvas runs, for the test hook (milestone 1). */
let mounted: SeamEngine | undefined;
export const mountedGpuEngine = (): SeamEngine | undefined => mounted;

export function GpuCanvas({ onUnavailable }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const unavailableRef = useRef(onUnavailable);
  unavailableRef.current = onUnavailable;

  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;
    const keeper = pageDeviceKeeper();
    // The DOM lib types WebGPU but not this overload of getContext.
    const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (context === null) {
      unavailableRef.current("This canvas offers no WebGPU context.");
      return;
    }
    const canvasName = state$.canvasName.peek();
    const handed = takeCamera(canvasName);
    const engine = createEngine({
      surface: canvas,
      context,
      device: keeper,
      scheduler: browserScheduler,
      clock: () => performance.now(),
      camera: handed,
    });
    mounted = engine;

    const told = { done: false };
    const tell = (): void => {
      const state = keeper.state();
      if (state.kind !== "unavailable" || told.done) return;
      told.done = true;
      unavailableRef.current(state.reason);
    };
    const offKeeper = keeper.subscribe(tell);
    tell();

    engine.apply([{ kind: "theme", mode: themeMode$.peek() }]);
    const offTheme = themeMode$.onChange(({ value }) => engine.apply([{ kind: "theme", mode: value }]));

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect();
      engine.input({ kind: "resize", width: rect.width, height: rect.height, pixelRatio: window.devicePixelRatio || 1 });
    };
    const sizes = new ResizeObserver(resize);
    sizes.observe(canvas);
    resize();

    const visibility = (): void => engine.input({ kind: "visibility", visible: document.visibilityState !== "hidden" });
    document.addEventListener("visibilitychange", visibility);
    visibility();

    return () => {
      document.removeEventListener("visibilitychange", visibility);
      sizes.disconnect();
      offTheme();
      offKeeper();
      // Only a camera this canvas was handed goes back: one it never placed
      // must not stand in for the old canvas's opening camera.
      if (handed !== undefined && state$.canvasName.peek() === canvasName) leaveCamera(canvasName, engine.camera());
      if (mounted === engine) mounted = undefined;
      engine.dispose();
    };
  }, []);

  return <canvas ref={ref} className="junto-gpu-canvas block h-full w-full" data-testid="gpu-canvas" />;
}
