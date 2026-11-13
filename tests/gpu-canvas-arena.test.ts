// Track A's arena (docs/canvas-gpu-plan.md, track A): script time per camera
// frame on 25 copies of the factory-like fixture is no more than double one
// copy. The copies sit far apart, so one camera sees the same board either
// way; the grid's culling is what keeps the cost flat.

import { describe, expect, it } from "vitest";
import { asCanvasName } from "@shared/model";
import type { CardFact } from "../src/window/canvas/contract";
import { createDeviceKeeper } from "../src/window/canvas/engine/device";
import { createEngine } from "../src/window/canvas/engine/engine";
import { fakeContext, fakeGpu, fakeScheduler, settle } from "./gpu-canvas-fakes";
import { note, region, seat, terminal } from "./support/model-nodes";

type Row = CardFact["row"];

/** The factory-like preset's counts: 45 regions over three levels, 40 seats, 21 notes, four terminals, 21 wires. */
const factoryLike = (copy: number, dx: number, dy: number): ReadonlyArray<CardFact> => {
  const at = (x: number, y: number): { x: number; y: number } => ({ x: x + dx, y: y + dy });
  const cards: CardFact[] = [];
  const push = (row: Row): void => {
    cards.push({ id: `${copy}:${row.id}`, row: { ...row, id: `${copy}:${row.id}` } as Row, derived: { regionDepth: 0, blocked: false, z: cards.length } });
  };
  for (let index = 0; index < 45; index += 1) {
    const column = index % 9;
    const row = Math.floor(index / 9);
    const place = at(column * 620, row * 460);
    push(region(`r${index}`, { ...place, width: 560, height: 400 }));
  }
  for (let index = 0; index < 40; index += 1) {
    const place = at(40 + (index % 8) * 250, 40 + Math.floor(index / 8) * 300);
    push(seat(`s${index}`, { ...place, width: 216, height: 56 }));
  }
  for (let index = 0; index < 21; index += 1) {
    const place = at(60 + (index % 7) * 300, 220 + Math.floor(index / 7) * 260);
    push(note(`n${index}`, "a note on the board", { ...place, width: 220, height: 84 }));
  }
  for (let index = 0; index < 4; index += 1) {
    const place = at(120 + index * 320, 520);
    push(terminal(`t${index}`, { ...place, width: 216, height: 56 }));
  }
  return cards;
};

type Timing = { readonly one: number; readonly many: number };

const measure = async (copies: number): Promise<number> => {
  const gpu = fakeGpu();
  const keeper = createDeviceKeeper(gpu.gpu);
  const context = fakeContext();
  const frames = fakeScheduler();
  const engine = createEngine({
    surface: { width: 0, height: 0 },
    context: context.context,
    device: keeper,
    scheduler: frames.scheduler,
    clock: () => performance.now(),
    wallClock: () => 1_000_000 + performance.now(),
  });
  engine.input({ kind: "resize", width: 1200, height: 800, pixelRatio: 2 });
  await settle();
  const cards: CardFact[] = [];
  for (let copy = 0; copy < copies; copy += 1) {
    cards.push(...factoryLike(copy, (copy % 5) * 12_000, Math.floor(copy / 5) * 8_000));
  }
  engine.apply([{ kind: "load", canvas: asCanvasName("factory"), cards, wires: [] }]);
  frames.tick();
  const samples: number[] = [];
  for (let frame = 0; frame < 80; frame += 1) {
    // A pan of a fraction of a cell: the visible board stays one copy.
    engine.input({
      kind: "wheel",
      at: { x: 600, y: 400 },
      dx: 1,
      dy: 0,
      deltaMode: 0,
      modifiers: { shift: false, alt: false, ctrl: false, meta: false },
    });
    frames.tick();
    if (frame >= 20) samples.push(engine.stats().lastFrameMs);
  }
  engine.dispose();
  keeper.dispose();
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? 0;
};

const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

describe("25 copies of the factory-like board", () => {
  it("costs no more than double one copy's camera frame", async () => {
    // Repeat each board so a single scheduler hiccup cannot decide the ratio.
    const one = median([await measure(1), await measure(1), await measure(1)]);
    const many = median([await measure(25), await measure(25), await measure(25)]);
    expect(one).toBeGreaterThan(0);
    // The tolerance beyond 2x is one scheduler tick's noise on a busy CI host.
    expect(many).toBeLessThanOrEqual(one * 2 + 0.5);
  }, 60_000);
});
