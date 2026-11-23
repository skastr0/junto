// The scene's side of the atlas reference contract through a zoom (the
// 0.11.14 zoom corruption): the real scene, the real atlas on a fake device
// and the real card painter, on a factory-shaped board, zoomed out to the
// overview and back in again with rests between, seats changing their
// lines and portraits as it goes and rasters landing in a random order. A
// ledger wraps the atlas interface and holds the scene to the contract on
// every call; every frame, the cells the scene's records hold are matched
// against it and handed to the atlas's own audit, which must find nothing.

import { describe, expect, it } from "vitest";
import { asCanvasName } from "@shared/model";
import { ringState } from "@shared/wire/rings";
import { tierForZoom, type CanvasTier } from "@shared/canvas-tier";
import type { CardFact, Quad, Rect, SeatLive } from "../src/window/canvas/contract";
import { createScene } from "../src/window/canvas/engine/scene";
import { createGpuAtlas, type AtlasPixels } from "../src/window/canvas/engine/gpu-atlas";
import { NO_ATLAS_CELL, QUAD_FLOATS } from "../src/window/canvas/engine/quad";
import { paintCard } from "../src/window/canvas/paint";
import { fakeEnv } from "./canvas-paint-fixtures";

const fakeDevice = (bindLimit: number) =>
  ({
    limits: {
      maxTextureDimension2D: 8192,
      maxTextureArrayLayers: 256,
      maxStorageBufferBindingSize: 128 * 1024 * 1024,
      maxSampledTexturesPerShaderStage: bindLimit,
    },
    createTexture: (desc: GPUTextureDescriptor) => {
      const size = desc.size as GPUExtent3DDict;
      return { width: size.width, height: size.height, depthOrArrayLayers: size.depthOrArrayLayers ?? 1, format: desc.format, createView: () => ({}), destroy: () => undefined };
    },
    createSampler: () => ({}),
    createCommandEncoder: () => ({ copyTextureToTexture: () => undefined, finish: () => ({}) }),
    pushErrorScope: () => undefined,
    popErrorScope: async () => null,
    queue: { copyExternalImageToTexture: () => undefined, writeTexture: () => undefined, submit: () => undefined, writeBuffer: () => undefined },
  }) as unknown as GPUDevice;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

/** A seeded generator, so a failure replays. */
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

/** A seat's live state; `beat` moves its line and, every third beat, its portrait's expression. */
const live = (index: number, beat = 0): SeatLive => ({
  ring: ringState({ glyph: index % 3 === 0 ? "rest" : "work", tone: "cyan" }),
  line: `running ${String((index * 7 + beat * 13) % 1000).padStart(3, "0")}`,
  mark: { tone: "cyan", label: "working" },
  urgency: 0,
  running: true,
  overseer: false,
  ringSince: 1_000,
  ...(index % 11 === 0 ? {} : { portrait: { seed: `seat-${String(index % 40)}`, ...(beat % 3 === 1 ? { expression: "happy" as never } : {}) } }),
});

/** Six regions of 48 seats each. */
const board = (): CardFact[] => {
  const cards: CardFact[] = [];
  for (let r = 0; r < 6; r += 1) {
    const rx = (r % 3) * 3200;
    const ry = Math.floor(r / 3) * 2600;
    const region = `region-${String(r)}`;
    cards.push({
      id: region,
      row: { id: region, kind: "region", label: `Region ${String(r)}`, x: rx, y: ry, width: 3000, height: 2400, z: 0, hold: false } as unknown as CardFact["row"],
      derived: { regionDepth: 0, blocked: false, z: 0 },
    });
    for (let i = 0; i < 48; i += 1) {
      const id = `agent-${String(r)}-${String(i)}`;
      cards.push({
        id,
        row: { id, kind: "agent", label: `seat-${String(r)}-${String(i)}`, x: rx + 60 + (i % 8) * 340, y: ry + 120 + Math.floor(i / 8) * 360, width: 216, height: 56, z: 1, agentKey: "local:claude" } as unknown as CardFact["row"],
        derived: { regionDepth: 1, blocked: false, z: 1, regionId: region },
      });
    }
  }
  return cards;
};

type Run = {
  readonly acquires: number;
  readonly releases: number;
  readonly tiers: ReadonlySet<CanvasTier>;
  readonly evictions: number;
  readonly contract: ReadonlyArray<string>;
  readonly ledger: ReadonlyArray<string>;
  readonly audit: ReadonlyArray<string>;
  readonly lostImage: ReadonlyArray<string>;
};

/** Zoom 2.4 to 0.16 and back, `rounds` times, on an atlas of `page` px pages and `bindLimit` sampled textures. */
const zoomRun = async (page: number, bindLimit: number, rounds: number): Promise<Run> => {
  const random = rng(7);
  const pending: Array<() => void> = [];
  const later = <T,>(value: () => T): Promise<T> =>
    new Promise<T>((resolve) => {
      pending.push(() => resolve(value()));
    });
  const textPixels = (w: number, h: number): AtlasPixels => ({ width: w, height: h, data: new Uint8Array(Math.max(1, w * h)), close: () => undefined }) as unknown as AtlasPixels;
  const spritePixels = (w: number, h: number): AtlasPixels => ({ width: w, height: h, close: () => undefined }) as unknown as AtlasPixels;
  const runBox = (run: { width: number; size: number }, scale: number) => ({ w: Math.max(1, Math.ceil(run.width * scale)), h: Math.max(1, Math.ceil(run.size * scale * 1.2)) });
  const spriteBox = (quad: Quad, scale: number) => spritePixels(Math.max(1, Math.ceil(quad.rect.width * scale)), Math.max(1, Math.ceil(quad.rect.height * scale)));
  // An image decodes only once its async raster ran; until then the sync path has nothing.
  const decoded = new Set<string>();
  const atlas = createGpuAtlas({
    size: page,
    rasterizeText: (run, scale) => later(() => textPixels(runBox(run, scale).w, runBox(run, scale).h)),
    rasterizeTextSync: (run, scale) => textPixels(runBox(run, scale).w, runBox(run, scale).h),
    rasterizeSprite: (quad, _mode, scale) =>
      later(() => {
        decoded.add(JSON.stringify(quad.sprite));
        return spriteBox(quad, scale);
      }),
    rasterizeSpriteSync: (quad, _mode, scale) => (quad.sprite?.atlas === "image" && !decoded.has(JSON.stringify(quad.sprite)) ? undefined : spriteBox(quad, scale)),
  });
  atlas.attach(fakeDevice(bindLimit));

  // --- the ledger: what the scene holds, by its own calls -------------------
  const held = new Map<number, number>();
  const heldFor = new Map<number, string>();
  const kindOf = new Map<number, "text" | "sprite">();
  const contract: string[] = [];
  let now = 0;
  const at = (): string => `frame ${String(now / 16)}`;
  const contentOf = (quad: Quad, scale: number): string =>
    JSON.stringify({ t: quad.text, s: quad.sprite, ink: quad.style.ink, scale, w: Math.ceil(quad.rect.width * scale), h: Math.ceil(quad.rect.height * scale) });
  const drop = (cell: number): void => {
    const n = (held.get(cell) ?? 0) - 1;
    if (n <= 0) held.delete(cell);
    else held.set(cell, n);
  };
  let acquires = 0;
  let releases = 0;
  const acquire = (quad: Quad, scale: number, previous?: number): number => {
    acquires += 1;
    const before = previous === undefined ? 0 : (held.get(previous) ?? 0);
    const kind = quad.text !== undefined ? "text" : "sprite";
    if (previous !== undefined && before <= 0) contract.push(`${at()}: ${quad.key} passed ${String(previous)} as previous, held by no record`);
    if (previous !== undefined && kindOf.has(previous) && kindOf.get(previous) !== kind) contract.push(`${at()}: ${quad.key} passed a ${kindOf.get(previous)!} cell as a ${kind}'s previous`);
    const next = atlas.acquire(quad, scale, previous);
    const id = contentOf(quad, scale);
    if (next !== NO_ATLAS_CELL) {
      if (next === previous) {
        if (heldFor.get(next) !== id && before > 1) contract.push(`${at()}: ${String(next)} re-keyed in place while ${String(before)} records hold it`);
      } else if ((held.get(next) ?? 0) > 0 && heldFor.get(next) !== id) {
        contract.push(`${at()}: ${String(next)} handed to a new key while ${String(held.get(next))} records hold it for another`);
      }
    }
    if (previous !== undefined) drop(previous);
    if (next !== NO_ATLAS_CELL) {
      held.set(next, (held.get(next) ?? 0) + 1);
      heldFor.set(next, id);
      kindOf.set(next, kind);
    }
    return next;
  };
  const release = (cell: number): void => {
    releases += 1;
    if ((held.get(cell) ?? 0) <= 0) contract.push(`${at()}: released ${String(cell)}, held by no record`);
    drop(cell);
    atlas.release(cell);
  };

  let zoom = 1;
  let settled = true;
  const screen = { width: 1600, height: 1000 };
  const centre = { x: 4600, y: 2400 };
  const scene = createScene({
    painter: (fact, seatLive, cardView, env) => paintCard(fact, seatLive, cardView, env),
    measure: fakeEnv.measure,
    acquire,
    release,
    hasImage: (cell) => atlas.hasImage(cell),
    ensureNow: (cell) => {
      atlas.ensureNow(cell);
    },
    prepareSource: (quad) => atlas.prepareSource(quad),
    releaseSource: (quad) => atlas.releaseSource(quad),
    atlasRevision: () => atlas.revision(),
    now: () => now,
    settled: () => settled,
    scale: () => 2 * zoom,
    zoom: () => zoom,
    anchor: () => centre,
  });
  const cards = board();
  scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards, wires: [] });
  cards.forEach((card, index) => {
    if (card.row.kind === "agent") scene.apply({ kind: "seat", id: card.id, live: live(index) });
  });
  const viewAt = (): Rect => ({ x: centre.x - screen.width / 2 / zoom, y: centre.y - screen.height / 2 / zoom, width: screen.width / zoom, height: screen.height / zoom });

  const ledger: string[] = [];
  const audited: string[] = [];
  const lostImage: string[] = [];
  const lastImage = new Map<number, number>();
  const tiers = new Set<CanvasTier>();
  let tier: CanvasTier = tierForZoom(zoom);
  let beat = 0;

  const frame = async (): Promise<void> => {
    now += 16;
    // Every third frame some seats change their line, and their portrait's expression.
    if (Math.round(now / 16) % 3 === 0) {
      beat += 1;
      cards.forEach((card, index) => {
        if (card.row.kind === "agent" && random() < 0.15) scene.apply({ kind: "seat", id: card.id, live: live(index, beat) });
      });
    }
    tier = tierForZoom(zoom, tier);
    tiers.add(tier);
    scene.prepare(viewAt(), tier);
    // The records' source words are the ledger, cell for cell.
    const words = scene.heldCells();
    for (const [cell, count] of words) if ((held.get(cell) ?? 0) !== count) ledger.push(`${at()}: ${String(cell)} held by ${String(count)} records, ${String(held.get(cell) ?? 0)} by the ledger`);
    for (const [cell, count] of held) if (!words.has(cell)) ledger.push(`${at()}: ${String(cell)} held ${String(count)} times by the ledger, by no record`);
    // The atlas holds what they hold, and its table, plots and pages are whole.
    const audit = atlas.audit(words);
    for (const [kind, count] of Object.entries(audit.counts)) {
      if (count > 0) audited.push(`${at()} at ${zoom.toFixed(3)} ${tier}: ${kind} x${String(count)} ${JSON.stringify(audit.samples.find((sample) => sample.kind === kind))}`);
    }
    // A drawn record that had its image last frame keeps it while it keeps the cell.
    const u32 = scene.quadBuffer.u32;
    const order = scene.orderBuffer;
    const imaged = new Map<number, number>();
    for (let i = 0; i < scene.orderCount; i += 1) {
      const slot = order[i]!;
      const cell = u32[slot * QUAD_FLOATS + 23]!;
      if (cell === NO_ATLAS_CELL) continue;
      const has = atlas.hasImage(cell);
      if (!has && lastImage.get(slot) === cell) lostImage.push(`${at()}: slot ${String(slot)} lost the image of ${String(cell)} at ${zoom.toFixed(3)} ${tier}`);
      if (has) imaged.set(slot, cell);
    }
    lastImage.clear();
    for (const [slot, cell] of imaged) lastImage.set(slot, cell);
    // Rasters land in a random order, some this frame, some later.
    for (const resolve of pending.splice(0, pending.length)) {
      if (random() < 0.35) resolve();
      else pending.push(resolve);
    }
    await flush();
  };

  // A rest (settled) every sixth step, held for two frames.
  const sweep = async (from: number, to: number, steps: number): Promise<void> => {
    for (let i = 0; i <= steps; i += 1) {
      zoom = from * (to / from) ** (i / steps);
      settled = i % 6 === 5;
      await frame();
      if (settled) await frame();
    }
  };
  for (let round = 0; round < rounds; round += 1) {
    await sweep(2.4, 0.16, 40);
    await sweep(0.16, 2.4, 40);
  }
  settled = true;
  for (let i = 0; i < 20; i += 1) {
    for (const resolve of pending.splice(0)) resolve();
    await frame();
  }
  return { acquires, releases, tiers, evictions: atlas.stats().evictions, contract, ledger, audit: audited, lostImage };
};

describe("the scene's side of the atlas reference contract, through a zoom out and in", () => {
  it.each([
    { name: "a roomy atlas", page: 2048, bindLimit: 16 },
    { name: "an atlas under pressure, evicting", page: 512, bindLimit: 2 },
  ])("holds on $name", async ({ page, bindLimit }) => {
    const run = await zoomRun(page, bindLimit, 2);
    // The run went where the corruption shows: every tier, thousands of asks.
    expect([...run.tiers].sort()).toEqual(["far", "mid", "near", "overview"]);
    expect(run.acquires).toBeGreaterThan(2_000);
    expect(run.releases).toBeGreaterThan(500);
    if (page === 512) expect(run.evictions).toBeGreaterThan(0);
    // Never passes or releases a cell it does not hold, never shares one
    // index across two keys, never hands a text cell to a sprite.
    expect(run.contract.slice(0, 5)).toEqual([]);
    // Its records hold exactly what it asked for.
    expect(run.ledger.slice(0, 5)).toEqual([]);
    // The atlas holds every cell they hold, with as many references, and
    // finds no broken row, stand-in, plot or page.
    expect(run.audit.slice(0, 5)).toEqual([]);
    // No drawn record loses an image it had while it keeps the cell.
    expect(run.lostImage.slice(0, 5)).toEqual([]);
  }, 120_000);
});
