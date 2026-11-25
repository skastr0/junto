// A camera jump into the far tiers over many region badges grows the draw
// list past the GPU order buffer between two frames. The new buffer must take
// the whole list, and the frame must issue every entry of it: no badge may be
// built by the scene and left out of what the GPU draws. The fake device keeps
// every write and every draw, so this reads what the engine asked the GPU for.

import { describe, expect, it } from "vitest";
import { asCanvasName } from "@shared/model";
import { ringState } from "@shared/wire/rings";
import type { CardFact, FrameFacts, SeatLive } from "../src/window/canvas/contract";
import { createDeviceKeeper } from "../src/window/canvas/engine/device";
import { createEngine } from "../src/window/canvas/engine/engine";
import { fakeContext, fakeGpu, fakeScheduler, settle } from "./gpu-canvas-fakes";
import { agentFact } from "./canvas-paint-fixtures";

const live = (): SeatLive => ({
  ring: ringState({ glyph: "work", tone: "cyan" }),
  line: "running",
  mark: { tone: "cyan", label: "working" },
  urgency: 0,
  running: true,
  overseer: false,
  ringSince: 1_000,
});

/** `count` seats, each alone in its own region, on a grid `gap` units apart. */
const board = (count: number, gap: number, columns: number): CardFact[] =>
  Array.from({ length: count }, (_, i) => {
    const id = `s${String(i).padStart(4, "0")}`;
    return {
      ...agentFact(),
      id,
      row: { ...agentFact().row, id, x: (i % columns) * gap, y: Math.floor(i / columns) * gap },
      derived: { ...agentFact().derived, regionId: `r${String(i).padStart(4, "0")}` },
    } as CardFact;
  });

describe("the draw list after a jump that regrows it", () => {
  it("is written whole to the new order buffer and drawn in full, at every tier it crosses", async () => {
    const gpu = fakeGpu();
    const keeper = createDeviceKeeper(gpu.gpu);
    const frames = fakeScheduler();
    let now = 0;
    const engine = createEngine({
      surface: { width: 0, height: 0 },
      context: fakeContext().context,
      device: keeper,
      scheduler: frames.scheduler,
      clock: () => now,
      wallClock: () => now + 1_000_000,
    });
    const heard: FrameFacts[] = [];
    engine.onFrame((facts) => heard.push(facts));
    engine.input({ kind: "resize", width: 800, height: 600, pixelRatio: 1 });
    await settle();
    const device = gpu.devices[0]!;
    const cards = board(700, 150, 28);
    engine.apply([{ kind: "load", canvas: asCanvasName("factory"), cards, wires: [] }]);
    for (const card of cards) engine.apply([{ kind: "seat", id: card.id, live: live() }]);
    // Near on the first seats, as a boot: a short list in a small order buffer.
    engine.moveCamera({ kind: "camera", camera: { x: 0, y: 0, zoom: 1 } });
    frames.tick();
    frames.tick();
    const drawsBefore = device.draws().length;
    const writesBefore = device.writes().length;
    // The jump: the overview over the whole board.
    engine.moveCamera({ kind: "camera", camera: { x: 0, y: 0, zoom: 0.15 } });
    frames.tick();
    const upload = engine.stats().lastUploadRanges.find((range) => range.buffer === "order");
    expect(upload, "the jump frame wrote the order buffer").toBeDefined();
    expect(upload!.offset).toBe(0);
    const listLength = upload!.size / 4;
    // The list is long enough that it regrew the order buffer past its first size.
    expect(listLength).toBeGreaterThan(1024);
    // The write went to a buffer that holds it.
    const orderWrite = device.writes().slice(writesBefore).find((write) => write.size === upload!.size && write.offset === 0);
    expect(orderWrite, "the order write").toBeDefined();
    expect((orderWrite!.buffer as unknown as { readonly size: number }).size).toBeGreaterThanOrEqual(upload!.size);
    // And the frame issued every entry: the bands' instance counts sum to the list.
    const drawn = device.draws().slice(drawsBefore).reduce((sum, draw) => sum + draw.instanceCount, 0);
    expect(drawn).toBe(listLength);
    expect(engine.stats().bufferFailures ?? []).toEqual([]);
    // Settling at the new camera, then a nudge, draws the same list.
    frames.tick();
    const settledDraws = device.draws().length;
    engine.moveCamera({ kind: "camera", camera: { x: -1, y: 0, zoom: 0.15 } });
    frames.tick();
    const nudged = device.draws().slice(settledDraws).reduce((sum, draw) => sum + draw.instanceCount, 0);
    expect(nudged).toBe(listLength);
    engine.dispose();
    keeper.dispose();
  });
});
