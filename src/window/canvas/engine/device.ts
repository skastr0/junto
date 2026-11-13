/**
 * The GPU device, kept.
 *
 * One keeper holds one device for as long as anything wants the GPU canvas.
 * Creating a device is asynchronous, and three things can happen around it
 * that the canvas must survive (docs/canvas-gpu-architecture.md, section 5):
 *
 * - The keeper is disposed before the device arrives (React StrictMode mounts,
 *   unmounts and mounts again in development). The late device is destroyed,
 *   never handed out.
 * - The device is lost (sleep, a GPU process restart). The keeper asks for a
 *   new one, and every listener hears the new generation so it can configure
 *   its context and upload its records again.
 * - There is no adapter (the GPU is off, or WebGPU is unavailable). The keeper
 *   says so, with the reason, and asks for nothing more: there is no second
 *   renderer (section 21).
 *
 * The keeper is handed `navigator.gpu` (or a fake); it reads no global.
 */

export type DeviceState =
  | { readonly kind: "pending" }
  | {
      readonly kind: "ready";
      readonly device: GPUDevice;
      readonly format: GPUTextureFormat;
      /** Counts devices this keeper has handed out: a loss makes the next one. */
      readonly generation: number;
    }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "disposed" };

export interface DeviceKeeper {
  readonly state: () => DeviceState;
  /** Hears every change of state after this call; returns the unsubscribe. */
  readonly subscribe: (listener: (state: DeviceState) => void) => () => void;
  /** Devices requested from the adapter so far, for tests and the test hook. */
  readonly created: () => number;
  readonly dispose: () => void;
}

/** The part of `GPU` the keeper uses, so a test can hand it a fake. */
export type GpuEntry = Pick<GPU, "requestAdapter" | "getPreferredCanvasFormat">;

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createDeviceKeeper = (gpu: GpuEntry | undefined): DeviceKeeper => {
  let state: DeviceState = { kind: "pending" };
  let generation = 0;
  let created = 0;
  const listeners = new Set<(state: DeviceState) => void>();

  // Read through a function: an await can change it under the narrowing.
  const disposed = (): boolean => state.kind === "disposed";

  const set = (next: DeviceState): void => {
    state = next;
    for (const listener of [...listeners]) listener(next);
  };

  const acquire = async (): Promise<void> => {
    if (gpu === undefined) {
      set({ kind: "unavailable", reason: "This build of Chromium offers no WebGPU." });
      return;
    }
    let adapter: GPUAdapter | null;
    try {
      adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    } catch (error) {
      if (disposed()) return;
      set({ kind: "unavailable", reason: `The GPU adapter could not be reached: ${reasonOf(error)}` });
      return;
    }
    if (disposed()) return;
    if (adapter === null) {
      set({ kind: "unavailable", reason: "No WebGPU adapter: the GPU is off or not offered to the app." });
      return;
    }
    let device: GPUDevice;
    try {
      created += 1;
      device = await adapter.requestDevice();
    } catch (error) {
      if (disposed()) return;
      set({ kind: "unavailable", reason: `The GPU device could not be created: ${reasonOf(error)}` });
      return;
    }
    if (disposed()) {
      device.destroy();
      return;
    }
    void device.lost.then((info) => {
      // A destroy is ours (dispose); anything else is a loss to recover from.
      if (disposed() || info.reason === "destroyed") return;
      if (state.kind !== "ready" || state.device !== device) return;
      set({ kind: "pending" });
      void acquire();
    });
    generation += 1;
    set({ kind: "ready", device, format: gpu.getPreferredCanvasFormat(), generation });
  };

  void acquire();

  return {
    state: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    created: () => created,
    dispose: () => {
      if (disposed()) return;
      const held = state.kind === "ready" ? state.device : undefined;
      set({ kind: "disposed" });
      listeners.clear();
      held?.destroy();
    },
  };
};
