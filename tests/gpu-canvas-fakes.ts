// Fakes for the GPU canvas tests: a WebGPU entry point, adapter, device and
// context that count what the engine asks of them, and a frame scheduler that
// runs only when the test says so. No test waits on a real clock.

import type { GpuEntry } from "../src/window/canvas/engine/device";

export type FakeDevice = {
  readonly device: GPUDevice;
  readonly submits: () => number;
  readonly clears: () => ReadonlyArray<GPUColor>;
  readonly destroyed: () => boolean;
  /** Lose the device as the browser would (sleep, a GPU process restart). */
  readonly lose: () => void;
};

const fakeDevice = (): FakeDevice => {
  let submits = 0;
  let destroyed = false;
  const clears: Array<GPUColor> = [];
  let resolveLost: (info: GPUDeviceLostInfo) => void = () => undefined;
  const lost = new Promise<GPUDeviceLostInfo>((resolve) => {
    resolveLost = resolve;
  });
  const device = {
    lost,
    createCommandEncoder: () => ({
      beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
        for (const attachment of descriptor.colorAttachments) {
          if (attachment?.clearValue !== undefined) clears.push(attachment.clearValue);
        }
        return { end: () => undefined };
      },
      finish: () => ({}),
    }),
    queue: {
      submit: () => {
        submits += 1;
      },
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      resolveLost({ reason: "destroyed", message: "" } as GPUDeviceLostInfo);
    },
  } as unknown as GPUDevice;
  return {
    device,
    submits: () => submits,
    clears: () => clears,
    destroyed: () => destroyed,
    lose: () => resolveLost({ reason: "unknown", message: "lost" } as GPUDeviceLostInfo),
  };
};

export type FakeGpu = {
  readonly gpu: GpuEntry;
  readonly devices: ReadonlyArray<FakeDevice>;
  /** Hold device creation until `release` is called. */
  readonly hold: () => void;
  readonly release: () => void;
};

export const fakeGpu = (options: { readonly adapter?: boolean } = {}): FakeGpu => {
  const devices: Array<FakeDevice> = [];
  let held: Array<() => void> | undefined;
  const adapter = {
    requestDevice: () =>
      new Promise<GPUDevice>((resolve) => {
        const make = (): void => {
          const made = fakeDevice();
          devices.push(made);
          resolve(made.device);
        };
        if (held !== undefined) held.push(make);
        else make();
      }),
  } as unknown as GPUAdapter;
  const gpu: GpuEntry = {
    requestAdapter: async () => (options.adapter === false ? null : adapter),
    getPreferredCanvasFormat: () => "bgra8unorm",
  };
  return {
    gpu,
    devices,
    hold: () => {
      held = [];
    },
    release: () => {
      const waiting = held ?? [];
      held = undefined;
      for (const make of waiting) make();
    },
  };
};

export type FakeContext = {
  readonly context: GPUCanvasContext;
  readonly configured: () => ReadonlyArray<GPUDevice>;
  readonly unconfigures: () => number;
};

export const fakeContext = (): FakeContext => {
  const configured: Array<GPUDevice> = [];
  let unconfigures = 0;
  const context = {
    configure: (configuration: GPUCanvasConfiguration) => {
      configured.push(configuration.device);
    },
    unconfigure: () => {
      unconfigures += 1;
    },
    getCurrentTexture: () => ({ createView: () => ({}) }),
  } as unknown as GPUCanvasContext;
  return { context, configured: () => configured, unconfigures: () => unconfigures };
};

export type FakeScheduler = {
  readonly scheduler: { request: (frame: (now: number) => void) => number; cancel: (handle: number) => void };
  readonly waiting: () => number;
  /** Run every waiting frame at `now`, as one display refresh. */
  readonly tick: (now?: number) => void;
};

export const fakeScheduler = (): FakeScheduler => {
  let next = 1;
  const frames = new Map<number, (now: number) => void>();
  let clock = 0;
  return {
    scheduler: {
      request: (frame) => {
        const handle = next++;
        frames.set(handle, frame);
        return handle;
      },
      cancel: (handle) => {
        frames.delete(handle);
      },
    },
    waiting: () => frames.size,
    tick: (now) => {
      clock = now ?? clock + 1000 / 120;
      const due = [...frames.values()];
      frames.clear();
      for (const frame of due) frame(clock);
    },
  };
};

/** Let the keeper's promise chain run. */
export const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};
