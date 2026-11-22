// GPU pass times (#912): timestamp-query is asked for when the adapter has
// it, and the frame pass's duration is read back from the resolved pair.

import { describe, expect, it } from "vitest";
import { createGpuTimer } from "../src/window/canvas/engine/gpu-timing";
import { createDeviceKeeper } from "../src/window/canvas/engine/device";
import { settle } from "./gpu-canvas-fakes";

const timedDevice = () => {
  const pair = new BigUint64Array([1_000_000n, 3_500_000n, 200_000n, 450_000n]);
  const calls: string[] = [];
  const device = {
    features: new Set(["timestamp-query"]),
    createQuerySet: () => ({ destroy: () => undefined }),
    createBuffer: () => ({
      mapAsync: () => Promise.resolve(),
      getMappedRange: () => pair.slice().buffer,
      unmap: () => undefined,
      destroy: () => undefined,
    }),
  } as unknown as GPUDevice;
  const encoder = {
    resolveQuerySet: () => calls.push("resolve"),
    copyBufferToBuffer: () => calls.push("copy"),
  } as unknown as GPUCommandEncoder;
  return { device, encoder, calls };
};

describe("GPU pass times", () => {
  it("times the pass from the resolved timestamp pair", async () => {
    const { device, encoder, calls } = timedDevice();
    const timer = createGpuTimer(device);
    expect(timer.writes()).toMatchObject({ beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 });
    timer.resolve(encoder);
    timer.collect();
    await settle();
    expect(calls).toEqual(["resolve", "copy"]);
    expect(timer.times()).toEqual({ available: true, samples: 1, lastMs: 2.5, peakMs: 2.5, totalMs: 2.5, cullSamples: 0, cullTotalMs: 0 });
  });

  it("times the cull's compute pass beside the render pass when the cull ran", async () => {
    const { device, encoder } = timedDevice();
    const timer = createGpuTimer(device);
    expect(timer.computeWrites()).toMatchObject({ beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 });
    timer.writes();
    timer.resolve(encoder);
    timer.collect();
    await settle();
    expect(timer.times()).toMatchObject({ samples: 1, lastMs: 2.5, cullSamples: 1, cullLastMs: 0.25, cullTotalMs: 0.25 });
  });

  it("says so when the device cannot time passes, and writes nothing", () => {
    const timer = createGpuTimer({ features: new Set() } as unknown as GPUDevice);
    expect(timer.writes()).toBeUndefined();
    expect(timer.computeWrites()).toBeUndefined();
    expect(timer.times()).toEqual({ available: false, samples: 0, totalMs: 0, cullSamples: 0, cullTotalMs: 0 });
  });

  it("asks the adapter for timestamp-query only when it offers it", async () => {
    const asked: GPUDeviceDescriptor[] = [];
    const adapterWith = (features: string[]) => ({
      features: new Set(features),
      limits: {},
      requestDevice: (descriptor: GPUDeviceDescriptor) => {
        asked.push(descriptor);
        return new Promise<GPUDevice>(() => undefined);
      },
    });
    for (const features of [["timestamp-query"], []]) {
      const adapter = adapterWith(features);
      const keeper = createDeviceKeeper({ requestAdapter: async () => adapter as unknown as GPUAdapter, getPreferredCanvasFormat: () => "bgra8unorm" });
      await settle();
      keeper.dispose();
    }
    expect(asked[0]?.requiredFeatures).toEqual(["timestamp-query"]);
    expect(asked[1]?.requiredFeatures).toBeUndefined();
  });
});
