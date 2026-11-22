// @vitest-environment jsdom
// An animated move from the canvas API is flown by the engine (issue 915): one
// frame loop sets the camera and draws, on the same straight path, eased
// cubic in-out, that the API's own loop flew.

import { describe, expect, it } from "vitest";
import type { Camera, FrameFacts } from "../src/window/canvas/contract";
import { createDeviceKeeper } from "../src/window/canvas/engine/device";
import { createEngine, type SeamEngine } from "../src/window/canvas/engine/engine";
import { interpolateCamera } from "../src/window/canvas/shell/camera-targets";
import { createGpuCanvasApi } from "../src/window/canvas/shell/gpu-canvas-api";
import { createSurfaceMirror } from "../src/window/canvas/shell/surface-mirror";
import { fakeContext, fakeGpu, fakeScheduler, settle } from "./gpu-canvas-fakes";

describe("a camera flight", () => {
  it("passes each frame through the straight eased path the API flew", async () => {
    const keeper = createDeviceKeeper(fakeGpu().gpu);
    const frames = fakeScheduler();
    let now = 1_000;
    const engine = createEngine({ surface: { width: 0, height: 0 }, context: fakeContext().context, device: keeper, scheduler: frames.scheduler, clock: () => now });
    engine.input({ kind: "resize", width: 800, height: 600, pixelRatio: 1 });
    await settle();
    const from: Camera = { x: 0, y: 0, zoom: 1 };
    engine.moveCamera(from);
    frames.tick();
    const seen: Camera[] = [];
    engine.onFrame((facts: FrameFacts) => seen.push(facts.camera));
    const to: Camera = { x: -2_400, y: 900, zoom: 0.3 };
    const start = now;
    engine.moveCamera({ kind: "camera", camera: to }, { durationMs: 300, path: "straight" });
    const expected: Camera[] = [];
    for (let frame = 1; frame <= 20; frame += 1) {
      now = start + frame * 16;
      frames.tick();
      expected.push(interpolateCamera(from, to, Math.min(1, (now - start) / 300)));
    }
    expect(seen.length).toBeGreaterThanOrEqual(19);
    for (let index = 0; index < seen.length; index += 1) {
      expect(seen[index]!.x).toBeCloseTo(expected[index]!.x, 9);
      expect(seen[index]!.y).toBeCloseTo(expected[index]!.y, 9);
      expect(seen[index]!.zoom).toBeCloseTo(expected[index]!.zoom, 12);
    }
    expect(seen.at(-1)).toEqual(to);
    engine.dispose();
    keeper.dispose();
  });

  it("is handed to the engine by the API, with no loop of the API's own", () => {
    const scheduled: number[] = [];
    const api = createGpuCanvasApi(createSurfaceMirror(), {
      scheduler: { request: () => (scheduled.push(1), 1), cancel: () => undefined },
    });
    const moves: Array<{ to: unknown; options: unknown }> = [];
    const engine = {
      moveCamera: (to: unknown, options: unknown) => moves.push({ to, options }),
      rectOf: () => undefined,
      onFrame: () => () => undefined,
    } as unknown as SeamEngine;
    api.attachEngine(engine);
    api.moveCamera({ kind: "camera", camera: { x: -500, y: 200, zoom: 0.6 } }, { durationMs: 240 });
    expect(moves).toEqual([{ to: { kind: "camera", camera: { x: -500, y: 200, zoom: 0.6 } }, options: { durationMs: 240, path: "straight" } }]);
    expect(scheduled).toEqual([]);
  });
});
