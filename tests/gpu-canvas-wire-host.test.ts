// The engine's wire host seam (track D): the layer hears every op, gets the
// frame's camera, viewport, tier and wall clock before its upload, draws in the
// rest and track bands, answers the pick, and is disposed with the engine.

import { describe, expect, it } from "vitest";
import { asCanvasName } from "@shared/model";
import type { SceneOp, WireFact } from "../src/window/canvas/contract";
import { createDeviceKeeper } from "../src/window/canvas/engine/device";
import { createEngine, type WireFrameFacts, type WireLayer } from "../src/window/canvas/engine/engine";
import { fakeContext, fakeGpu, fakeScheduler, settle } from "./gpu-canvas-fakes";

const WALL = 1_700_000_000_000;

const wire = (id: string): WireFact => ({ id, row: { id, from: "a", to: "b", verb: "messages" } }) as unknown as WireFact;

describe("the engine's wire host", () => {
  it("feeds the layer its bands, the frame facts and the pick, then disposes it", async () => {
    const gpu = fakeGpu();
    const keeper = createDeviceKeeper(gpu.gpu);
    const context = fakeContext();
    const frames = fakeScheduler();
    const calls: string[] = [];
    const applied: Array<ReadonlyArray<SceneOp>> = [];
    let frame: WireFrameFacts | undefined;
    const wires: WireLayer = {
      apply: (ops) => {
        applied.push(ops);
      },
      frame: (facts) => {
        frame = facts;
        calls.push("frame");
      },
      upload: () => calls.push("upload"),
      encodeRest: () => calls.push("rest"),
      encodeTracks: () => calls.push("tracks"),
      hit: () => {
        calls.push("hit");
        return "w";
      },
      busy: () => false,
      dispose: () => calls.push("dispose"),
    };
    const engine = createEngine({
      surface: { width: 0, height: 0 },
      context: context.context,
      device: keeper,
      scheduler: frames.scheduler,
      clock: () => 0,
      wallClock: () => WALL,
      wires,
    });
    engine.input({ kind: "resize", width: 800, height: 600, pixelRatio: 1 });
    await settle();
    frames.tick();

    // The layer's frame comes before its upload, and its two draws sit in the
    // engine's bands: wires rest, cards, then tracks.
    expect(calls).toEqual(["frame", "upload", "rest", "tracks"]);
    expect(frame).toMatchObject({
      camera: { x: 0, y: 0, zoom: 1 },
      width: 800,
      height: 600,
      pixelRatio: 1,
      tier: "near",
      wall: WALL,
    });

    engine.apply([
      { kind: "load", canvas: asCanvasName("factory"), cards: [], wires: [wire("w")] },
      { kind: "wireMode", mode: "loupe" },
    ]);
    expect(applied.at(-1)?.map((op) => op.kind)).toEqual(["load", "wireMode"]);
    // The pick asks the layer for the wire under the point; the card list is empty.
    expect(engine.pick({ x: 20, y: 20 })).toMatchObject({ wireId: "w", part: { kind: "wire" } });
    expect(calls).toContain("hit");

    engine.dispose();
    expect(calls).toContain("dispose");
    keeper.dispose();
  });
});
