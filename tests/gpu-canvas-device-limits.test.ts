/**
 * The device is requested with the adapter's own limits, never WebGPU's
 * baseline defaults (a 128 MiB storage binding, 8192-pixel textures).
 */
import { describe, expect, it } from "vitest";
import { createDeviceKeeper, MACHINE_LIMITS, type GpuEntry } from "../src/window/canvas/engine/device";
import { settle } from "./gpu-canvas-fakes";

const gpuWith = (limits: Record<string, number> | undefined) => {
  const asked: Array<GPUDeviceDescriptor | undefined> = [];
  const device = { lost: new Promise(() => undefined), destroy: () => undefined } as unknown as GPUDevice;
  const adapter = {
    ...(limits === undefined ? {} : { limits }),
    requestDevice: async (descriptor?: GPUDeviceDescriptor) => {
      asked.push(descriptor);
      return device;
    },
  } as unknown as GPUAdapter;
  const gpu: GpuEntry = { requestAdapter: async () => adapter, getPreferredCanvasFormat: () => "bgra8unorm" };
  return { gpu, asked };
};

describe("the device's limits", () => {
  it("asks for every growth limit the adapter reports", async () => {
    const metal = {
      maxBufferSize: 4 * 2 ** 30,
      maxStorageBufferBindingSize: 4 * 2 ** 30,
      maxTextureDimension2D: 16384,
      maxTextureArrayLayers: 2048,
      maxBindGroups: 4,
    };
    const { gpu, asked } = gpuWith(metal);
    const keeper = createDeviceKeeper(gpu);
    await settle();
    expect(keeper.state().kind).toBe("ready");
    expect(asked).toHaveLength(1);
    const required = asked[0]?.requiredLimits ?? {};
    for (const name of MACHINE_LIMITS) expect(required[name]).toBe(metal[name]);
    // Only the limits the canvas grows into: the rest stay the adapter's defaults.
    expect(required).not.toHaveProperty("maxBindGroups");
  });

  it("still gets a device from an adapter that reports no limits", async () => {
    const { gpu, asked } = gpuWith(undefined);
    const keeper = createDeviceKeeper(gpu);
    await settle();
    expect(keeper.state().kind).toBe("ready");
    expect(asked[0]?.requiredLimits).toBeUndefined();
  });
});
