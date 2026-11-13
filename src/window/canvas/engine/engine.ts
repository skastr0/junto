/**
 * The GPU canvas engine (docs/canvas-gpu-architecture.md, sections 4 and 5).
 *
 * Facts in, intents and frame facts out. The engine imports only from
 * `src/shared/` and from its own folder, and touches no global: the canvas,
 * the device keeper, the frame scheduler and the clock are handed to it, so a
 * test hands it fakes and a worker could host it unchanged.
 *
 * Milestone 0 draws the ground and nothing else. The loop already keeps the
 * rule every later milestone keeps: one scheduled frame at most, drawn only
 * when the picture would change, never while no one can see the canvas, and
 * no timer anywhere.
 */

import { themeRuntime, type ThemeMode } from "@shared/theme";
import type { Camera, CanvasInput, FrameScheduler, SceneOp } from "../contract";
import type { DeviceKeeper, DeviceState } from "./device";

export type { Camera, CanvasInput, FrameScheduler, SceneOp };

/** The surface the engine sizes: an HTML or offscreen canvas, or a fake. */
export interface DrawSurface {
  width: number;
  height: number;
}

export interface EngineHost {
  readonly surface: DrawSurface;
  /** The surface's WebGPU context, which the shell asks the canvas for. */
  readonly context: GPUCanvasContext;
  readonly device: DeviceKeeper;
  readonly scheduler: FrameScheduler;
  readonly clock: () => number;
  readonly camera?: Camera;
}

/** The seam's frame facts; grows into the contract's `SeamFrameFacts` (track A). */
export type SeamFrameFacts = { readonly camera: Camera; readonly at: number };

/** The seam's counters; grows into the contract's `EngineStats` (track A). */
export type SeamStats = {
  /** Frames drawn since the engine started. */
  readonly frames: number;
  /** The device generation the surface is configured for; 0 before any. */
  readonly generation: number;
};

/** The seam's engine; grows into the contract's `Engine` (track A). */
export interface SeamEngine {
  readonly apply: (ops: ReadonlyArray<SceneOp>) => void;
  readonly input: (event: CanvasInput) => void;
  readonly camera: () => Camera;
  readonly moveCamera: (to: Camera) => void;
  readonly onFrame: (listener: (facts: SeamFrameFacts) => void) => () => void;
  readonly stats: () => SeamStats;
  readonly dispose: () => void;
}

const HOME: Camera = { x: 0, y: 0, zoom: 1 };

/** A theme colour, as the theme projects it for runtimes that cannot read CSS. */
const clearColour = (hex: string): GPUColorDict => {
  const digits = hex.replace("#", "");
  const channel = (at: number): number => parseInt(digits.slice(at, at + 2), 16) / 255;
  // The surface is a plain (not sRGB) format, so these are the same encoded
  // values CSS composites with.
  return { r: channel(0), g: channel(2), b: channel(4), a: 1 };
};

export const createEngine = (host: EngineHost): SeamEngine => {
  const { surface, context, device: keeper, scheduler } = host;
  let camera: Camera = host.camera ?? HOME;
  let ground = clearColour(themeRuntime("dark").ground ?? "");
  let size = { width: 0, height: 0, pixelRatio: 1 };
  let visible = true;
  let dirty = true;
  let disposed = false;
  let frames = 0;
  let pending: number | undefined;
  let configured: { readonly device: GPUDevice; readonly generation: number } | undefined;
  const frameListeners = new Set<(facts: SeamFrameFacts) => void>();

  const configure = (state: DeviceState): void => {
    if (state.kind !== "ready") {
      configured = undefined;
      return;
    }
    if (configured?.generation === state.generation) return;
    context.configure({ device: state.device, format: state.format, alphaMode: "opaque" });
    configured = { device: state.device, generation: state.generation };
    // A new device holds nothing: everything is drawn again from our records.
    dirty = true;
  };

  const draw = (now: number): void => {
    pending = undefined;
    if (disposed || !visible || !dirty) return;
    configure(keeper.state());
    if (configured === undefined) return;
    const pixelWidth = Math.max(1, Math.round(size.width * size.pixelRatio));
    const pixelHeight = Math.max(1, Math.round(size.height * size.pixelRatio));
    if (surface.width !== pixelWidth) surface.width = pixelWidth;
    if (surface.height !== pixelHeight) surface.height = pixelHeight;
    const { device } = configured;
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: ground,
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.end();
    device.queue.submit([encoder.finish()]);
    dirty = false;
    frames += 1;
    const facts: SeamFrameFacts = { camera, at: now };
    for (const listener of [...frameListeners]) listener(facts);
  };

  const schedule = (): void => {
    if (disposed || !visible || !dirty || pending !== undefined) return;
    if (keeper.state().kind !== "ready") return;
    pending = scheduler.request(draw);
  };

  const invalidate = (): void => {
    dirty = true;
    schedule();
  };

  const unsubscribe = keeper.subscribe((state) => {
    if (state.kind === "ready") invalidate();
    else configure(state);
  });

  schedule();

  return {
    apply: (ops) => {
      for (const op of ops) {
        if (op.kind === "theme") ground = clearColour(themeRuntime(op.mode).ground ?? "");
      }
      invalidate();
    },
    input: (event) => {
      if (event.kind !== "resize" && event.kind !== "visibility") return;
      if (event.kind === "resize") {
        size = { width: event.width, height: event.height, pixelRatio: event.pixelRatio };
        invalidate();
        return;
      }
      visible = event.visible;
      if (!visible && pending !== undefined) {
        scheduler.cancel(pending);
        pending = undefined;
      }
      // What was drawn while hidden may be stale: draw again on return.
      if (visible) invalidate();
    },
    camera: () => camera,
    moveCamera: (to) => {
      camera = to;
      invalidate();
    },
    onFrame: (listener) => {
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
      };
    },
    stats: () => ({ frames, generation: configured?.generation ?? 0 }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (pending !== undefined) scheduler.cancel(pending);
      pending = undefined;
      unsubscribe();
      frameListeners.clear();
      context.unconfigure();
      configured = undefined;
    },
  };
};
