// The GPU canvas seam, milestone 0.3 (docs/canvas-gpu-plan.md): a device that
// survives loss, dispose and StrictMode; the no-adapter path; a frame loop
// that draws only when the picture changes and stops when hidden; the ground
// from the theme; the camera handed across the switch.

import { describe, expect, it } from "vitest";
import { themeRuntime } from "@shared/theme";
import { createDeviceKeeper, type DeviceState } from "../src/window/canvas/engine/device";
import { createEngine } from "../src/window/canvas/engine/engine";
import { leaveCamera, takeCamera } from "../src/window/canvas/shell/camera-handoff";
import { fakeContext, fakeGpu, fakeScheduler, settle } from "./gpu-canvas-fakes";

const groundOf = (mode: "dark" | "bright") => {
  const hex = themeRuntime(mode).ground ?? "";
  const at = (i: number) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255;
  return { r: at(0), g: at(2), b: at(4), a: 1 };
};

const engineOn = (keeper: ReturnType<typeof createDeviceKeeper>) => {
  const context = fakeContext();
  const frames = fakeScheduler();
  const surface = { width: 0, height: 0 };
  const engine = createEngine({ surface, context: context.context, device: keeper, scheduler: frames.scheduler, clock: () => 0 });
  return { engine, context, frames, surface };
};

describe("the device keeper", () => {
  it("says why when there is no WebGPU at all", async () => {
    const keeper = createDeviceKeeper(undefined);
    await settle();
    expect(keeper.state()).toMatchObject({ kind: "unavailable" });
    expect(keeper.created()).toBe(0);
  });

  it("says why when the GPU offers no adapter, and asks for no device", async () => {
    const gpu = fakeGpu({ adapter: false });
    const keeper = createDeviceKeeper(gpu.gpu);
    await settle();
    const state = keeper.state();
    expect(state.kind).toBe("unavailable");
    expect(state.kind === "unavailable" ? state.reason : "").toMatch(/No WebGPU adapter/u);
    expect(gpu.devices).toHaveLength(0);
  });

  it("destroys a device that arrives after it was disposed, and hands it to no one", async () => {
    const gpu = fakeGpu();
    gpu.hold();
    const keeper = createDeviceKeeper(gpu.gpu);
    const heard: Array<DeviceState["kind"]> = [];
    keeper.subscribe((state) => heard.push(state.kind));
    await settle();
    keeper.dispose();
    gpu.release();
    await settle();
    expect(gpu.devices).toHaveLength(1);
    expect(gpu.devices[0]?.destroyed()).toBe(true);
    expect(heard).toEqual(["disposed"]);
    expect(keeper.state().kind).toBe("disposed");
  });

  it("recovers from a lost device with a new generation", async () => {
    const gpu = fakeGpu();
    const keeper = createDeviceKeeper(gpu.gpu);
    await settle();
    expect(keeper.state()).toMatchObject({ kind: "ready", generation: 1 });
    gpu.devices[0]?.lose();
    await settle();
    expect(keeper.state()).toMatchObject({ kind: "ready", generation: 2 });
    expect(keeper.created()).toBe(2);
    keeper.dispose();
    expect(gpu.devices[1]?.destroyed()).toBe(true);
  });
});

describe("the frame loop", () => {
  it("clears to the theme's ground once, then draws nothing while nothing changes", async () => {
    const gpu = fakeGpu();
    const keeper = createDeviceKeeper(gpu.gpu);
    const { engine, frames, surface } = engineOn(keeper);
    engine.input({ kind: "resize", width: 400, height: 300, pixelRatio: 2 });
    await settle();
    expect(frames.waiting()).toBe(1);
    frames.tick();
    expect(engine.stats().frames).toBe(1);
    expect(surface).toEqual({ width: 800, height: 600 });
    expect(gpu.devices[0]?.clears()).toEqual([groundOf("dark")]);
    // An idle scene asks for no frame and draws none.
    for (let i = 0; i < 10; i += 1) frames.tick();
    expect(frames.waiting()).toBe(0);
    expect(engine.stats().frames).toBe(1);
    engine.dispose();
    keeper.dispose();
  });

  it("repaints the ground for a theme switch, from the feed's fact", async () => {
    const gpu = fakeGpu();
    const keeper = createDeviceKeeper(gpu.gpu);
    const { engine, frames } = engineOn(keeper);
    await settle();
    frames.tick();
    engine.apply([{ kind: "theme", mode: "bright" }]);
    frames.tick();
    expect(gpu.devices[0]?.clears()).toEqual([groundOf("dark"), groundOf("bright")]);
    expect(groundOf("dark")).not.toEqual(groundOf("bright"));
    engine.dispose();
    keeper.dispose();
  });

  it("stops while hidden and draws again on return", async () => {
    const gpu = fakeGpu();
    const keeper = createDeviceKeeper(gpu.gpu);
    const { engine, frames } = engineOn(keeper);
    await settle();
    engine.input({ kind: "visibility", visible: false });
    expect(frames.waiting()).toBe(0);
    engine.input({ kind: "resize", width: 10, height: 10, pixelRatio: 1 });
    expect(frames.waiting()).toBe(0);
    frames.tick();
    expect(engine.stats().frames).toBe(0);
    engine.input({ kind: "visibility", visible: true });
    frames.tick();
    expect(engine.stats().frames).toBe(1);
    engine.dispose();
    keeper.dispose();
  });

  it("configures the new device after a loss and draws the scene again", async () => {
    const gpu = fakeGpu();
    const keeper = createDeviceKeeper(gpu.gpu);
    const { engine, frames, context } = engineOn(keeper);
    await settle();
    frames.tick();
    gpu.devices[0]?.lose();
    await settle();
    frames.tick();
    expect(context.configured()).toEqual([gpu.devices[0]?.device, gpu.devices[1]?.device]);
    expect(engine.stats()).toMatchObject({ frames: 2, generation: 2 });
    expect(gpu.devices[1]?.submits()).toBe(1);
    engine.dispose();
    keeper.dispose();
  });

  it("survives a StrictMode mount: create, dispose before the device, create again, on one device", async () => {
    const gpu = fakeGpu();
    gpu.hold();
    const keeper = createDeviceKeeper(gpu.gpu);
    const first = engineOn(keeper);
    first.engine.dispose();
    const second = engineOn(keeper);
    gpu.release();
    await settle();
    expect(first.frames.waiting()).toBe(0);
    second.frames.tick();
    expect(second.engine.stats().frames).toBe(1);
    expect(first.engine.stats().frames).toBe(0);
    expect(first.context.configured()).toHaveLength(0);
    expect(keeper.created()).toBe(1);
    second.engine.dispose();
    expect(second.context.unconfigures()).toBe(1);
    keeper.dispose();
  });

  it("cancels its waiting frame on dispose", async () => {
    const gpu = fakeGpu();
    const keeper = createDeviceKeeper(gpu.gpu);
    const { engine, frames } = engineOn(keeper);
    await settle();
    expect(frames.waiting()).toBe(1);
    engine.dispose();
    expect(frames.waiting()).toBe(0);
    keeper.dispose();
  });
});

describe("the camera hand-over", () => {
  it("is taken once, and only for the canvas it was left on", () => {
    leaveCamera("factory", { x: 12, y: -40, zoom: 0.6 });
    expect(takeCamera("other")).toBeUndefined();
    expect(takeCamera("factory")).toEqual({ x: 12, y: -40, zoom: 0.6 });
    expect(takeCamera("factory")).toBeUndefined();
  });

  it("refuses a camera that is not one", () => {
    leaveCamera("factory", { x: Number.NaN, y: 0, zoom: 1 });
    leaveCamera("factory", { x: 0, y: 0, zoom: 0 });
    leaveCamera("", { x: 0, y: 0, zoom: 1 });
    expect(takeCamera("factory")).toBeUndefined();
  });
});
