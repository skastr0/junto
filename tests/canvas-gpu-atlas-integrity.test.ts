/**
 * The atlas keeps every row true to the pixels it names.
 *
 * Each test states one invariant a drawn quad relies on. A test whose comment
 * starts "0.11.14:" failed on that release, where zooming showed other items'
 * pictures, fragments and empty discs: an index was handed to a new key while
 * a quad held it, a row changed without the table being uploaded, a stand-in
 * named a rect nobody kept, and live cells were moved with a GPU copy that
 * WebGPU rejects. The rest hold the line beside them.
 */
import { describe, expect, it } from "vitest";
import { createGpuAtlas, rasterizeSprite, type AtlasPixels, type GpuAtlasOptions } from "../src/window/canvas/engine/gpu-atlas";
import { ATLAS_CELL_FLOATS } from "../src/window/canvas/engine/types";
import { NO_ATLAS_CELL } from "../src/window/canvas/engine/quad";
import type { Quad, QuadStyle, SpriteRef } from "../src/window/canvas/contract";
import { settle } from "./gpu-canvas-fakes";

const fakeDevice = (limits?: Partial<GPUSupportedLimits>) => {
  let textureCopies = 0;
  const device = {
    limits: {
      maxTextureDimension2D: 8192,
      maxTextureArrayLayers: 256,
      maxStorageBufferBindingSize: 128 * 1024 * 1024,
      ...limits,
    },
    createTexture: (desc: GPUTextureDescriptor) => {
      const size = desc.size as GPUExtent3DDict;
      return {
        width: size.width,
        height: size.height,
        depthOrArrayLayers: size.depthOrArrayLayers ?? 1,
        format: desc.format,
        createView: () => ({}),
        destroy: () => undefined,
      };
    },
    createSampler: () => ({}),
    createCommandEncoder: () => ({
      copyTextureToTexture: () => {
        textureCopies += 1;
      },
      finish: () => ({}),
    }),
    pushErrorScope: () => undefined,
    popErrorScope: async () => null,
    queue: {
      copyExternalImageToTexture: () => undefined,
      writeTexture: () => undefined,
      submit: () => undefined,
      writeBuffer: () => undefined,
    },
  } as unknown as GPUDevice;
  return { device, textureCopies: () => textureCopies };
};

const pixels = (width: number, height: number): AtlasPixels =>
  ({ width, height, close: () => undefined }) as unknown as AtlasPixels;

const style: QuadStyle = { ink: { token: "ink" } };

const spriteQuad = (sprite: SpriteRef, width = 16, height = 16): Quad => ({
  key: "q",
  kind: "sprite",
  band: "cards",
  z: 0,
  rect: { x: 0, y: 0, width, height },
  tiers: 0,
  scale: { kind: "board" },
  style,
  sprite,
});

const mark = (col: number, row = 0): Quad => spriteQuad({ atlas: "mark", cell: { col, row } } as SpriteRef);

const textQuad = (text: string): Quad => ({
  key: "q",
  kind: "text",
  band: "cards",
  z: 0,
  rect: { x: 0, y: 0, width: 10, height: 10 },
  tiers: 0,
  scale: { kind: "board" },
  style,
  text: { text, font: "body", size: 12, weight: 400, truncate: "end", width: 80 },
});

const atlasWith = (over: Partial<GpuAtlasOptions> = {}) => {
  const atlas = createGpuAtlas({
    rasterizeText: async () => pixels(20, 10),
    rasterizeSprite: async () => pixels(16, 16),
    ...over,
  });
  return atlas;
};

const drain = async (): Promise<void> => {
  // The drain runs on a MessageChannel macrotask, then the raster promise settles.
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await settle();
  }
};

const row = (atlas: ReturnType<typeof atlasWith>, cell: number): number[] =>
  Array.from(atlas.binding.cells.subarray(atlas.cellIndex(cell) * ATLAS_CELL_FLOATS, atlas.cellIndex(cell) * ATLAS_CELL_FLOATS + ATLAS_CELL_FLOATS));

describe("a held cell index is never handed to another key", () => {
  it("a slot let go while it waits behind its quad's last cell leaves nothing behind", async () => {
    // One 64px page = one plot = nine 16px cells (gutter 1, no mips on the fake device).
    const atlas = atlasWith({ size: 64 });
    atlas.attach(fakeDevice().device);

    // Fill page 0: the cell under test, then eight neighbours.
    const a = atlas.acquire(mark(0), 1);
    const fill: number[] = [];
    for (let i = 1; i <= 8; i += 1) fill.push(atlas.acquire(mark(i), 1));
    await drain();
    expect(atlas.hasImage(a)).toBe(true);
    for (const cell of fill) expect(atlas.hasImage(cell)).toBe(true);
    expect(atlas.stats().pages).toBe(1);

    // The neighbours leave the screen: cached, unreferenced.
    for (const cell of fill) atlas.release(cell);

    // The quad's content changes at the same box: a new slot, which shows the old cell until its own raster lands.
    const a2 = atlas.acquire(mark(20), 1, a);
    expect(a2).not.toBe(a);
    expect(row(atlas, a2)).toEqual(row(atlas, a));
    // ...and before the queue drains, the quad lets go (a zoom step, a repaint, a removal).
    atlas.release(a2);
    // The slot that waited is gone with its row, and nothing holds the cell it showed.
    expect(row(atlas, a2)).toEqual(new Array(ATLAS_CELL_FLOATS).fill(0));
    expect(atlas.stats().pinnedCells).toBe(0);
    expect(atlas.audit().counts).toEqual({});

    // A new quad takes a cell: the freed index is recycled (LIFO).
    const y = atlas.acquire(mark(30), 1);
    expect(atlas.cellIndex(y)).toBe(atlas.cellIndex(a2));
    await drain();

    // 0.11.14: the cell took its new key at the request and kept its rect, so the
    // plot still listed the index, and wiping the plot freed y's slot under the quad.
    // y is held by a quad the whole time. Asked again with itself as previous, it is the same cell.
    expect.soft(atlas.acquire(mark(30), 1, y)).toBe(y);
    // And no other key may ever be handed its index (the free list is LIFO: ask for a plot's worth).
    const others: number[] = [];
    for (let i = 0; i < 9; i += 1) others.push(atlas.acquire(mark(40 + i), 1));
    expect.soft(others).not.toContain(y);
    const held = new Map<number, number>([[y, 1]]);
    for (const cell of others) held.set(cell, 1);
    expect(atlas.audit(held).counts).toEqual({});
  });

  it("control: the same sequence without the content change keeps the indices apart", async () => {
    const atlas = atlasWith({ size: 64 });
    atlas.attach(fakeDevice().device);
    const a = atlas.acquire(mark(0), 1);
    const fill: number[] = [];
    for (let i = 1; i <= 8; i += 1) fill.push(atlas.acquire(mark(i), 1));
    await drain();
    for (const cell of fill) atlas.release(cell);
    atlas.release(a);
    const y = atlas.acquire(mark(30), 1);
    await drain();
    expect(atlas.acquire(mark(30), 1, y)).toBe(y);
    const others: number[] = [];
    for (let i = 0; i < 9; i += 1) others.push(atlas.acquire(mark(40 + i), 1));
    expect(others).not.toContain(y);
  });

  it("the same on a 512px page, which is one plot, as in production", async () => {
    // Raster box = rect * scale, so a 250px cell fills a quarter of the plot.
    const atlas = atlasWith({
      size: 512,
      rasterizeSprite: async (quad, _mode, scale) => pixels(Math.ceil(quad.rect.width * scale), Math.ceil(quad.rect.height * scale)),
    });
    atlas.attach(fakeDevice().device);
    const at = (col: number, scale: number): Quad => spriteQuad({ atlas: "mark", cell: { col, row: 0 } } as SpriteRef, 250 / scale, 250 / scale);

    // Page 0: four contents at scale 1, held.
    const base: number[] = [];
    for (let i = 0; i < 4; i += 1) base.push(atlas.acquire(at(i, 1), 1));
    await drain();
    // Page 1: the same contents at scale 2 (the zoomed-in rasters). Each showed
    // its scale 1 cell meanwhile, which a quad holds: none was written over.
    const sharp: number[] = [];
    for (let i = 0; i < 4; i += 1) sharp.push(atlas.acquire(at(i, 2), 2));
    await drain();
    expect(atlas.stats().pages).toBe(2);
    expect(atlas.stats().overwrites).toBe(0);

    // Three sharp cells leave the screen; the fourth changes content at the same box, then lets go while it waits.
    for (const cell of sharp.slice(1)) atlas.release(cell);
    const v = atlas.acquire(at(9, 2), 2, sharp[0]!);
    expect(v).not.toBe(sharp[0]);
    atlas.release(v);

    // A new quad recycles the index and is held from here on.
    const y = atlas.acquire(at(20, 2), 2);
    expect(atlas.cellIndex(y)).toBe(atlas.cellIndex(v));
    await drain();
    // 0.11.14: the held index was freed with the plot of sharper cells and handed out again.
    expect.soft(atlas.acquire(at(20, 2), 2, y)).toBe(y);
    const others: number[] = [];
    for (let i = 0; i < 4; i += 1) others.push(atlas.acquire(at(40 + i, 2), 2));
    expect.soft(others).not.toContain(y);
    const held = new Map<number, number>([[y, 1]]);
    for (const cell of [...base, ...others]) held.set(cell, 1);
    expect(atlas.audit(held).counts).toEqual({});
  });
});

describe("a rect is written a second time only for the quads that asked for it", () => {
  /** A sprite whose raster is 16px whatever it shows, as a status line keeps its box. */
  const line = (col: number): Quad => mark(col);

  it("a changed line goes over the cell it replaces when nothing else holds that cell", async () => {
    const atlas = atlasWith({ size: 64 });
    atlas.attach(fakeDevice().device);

    const still = atlas.acquire(mark(0), 1); // a neighbour that never changes
    const first = atlas.acquire(line(1), 1);
    await drain();
    const rect = row(atlas, first);

    // The line changes: a new slot that shows the old pixels until its own land.
    const second = atlas.acquire(line(2), 1, first);
    expect(second).not.toBe(first);
    expect(row(atlas, second)).toEqual(rect);
    await drain();

    // Its pixels went over the old rect. The old cell is gone, key and all.
    expect(row(atlas, second)).toEqual(rect);
    expect(atlas.hasImage(first)).toBe(false);
    expect(atlas.stats().overwrites).toBe(1);
    expect(atlas.stats().activeCells).toBe(2);
    expect(atlas.audit(new Map([[still, 1], [second, 1]])).counts).toEqual({});

    // The old content, asked again, is a new raster: its cell was not kept under another's pixels.
    const again = atlas.acquire(line(1), 1);
    expect(again).not.toBe(second);
    expect(atlas.hasImage(again)).toBe(false);
  });

  it("a line that changes two hundred times beside a cell that stays takes one rect", async () => {
    const atlas = atlasWith({ size: 64 });
    atlas.attach(fakeDevice().device);

    const still = atlas.acquire(mark(0), 1);
    let cell = atlas.acquire(line(1), 1);
    await drain();
    const rect = row(atlas, cell);
    for (let i = 0; i < 200; i += 1) {
      cell = atlas.acquire(line(2 + i), 1, cell);
      await settle();
      await settle();
    }
    // Without the overwrite each change took a new rect, and the cell that
    // stays kept the plot from ever being wiped: a page of dead lines every
    // eight changes.
    expect(row(atlas, cell)).toEqual(rect);
    expect(atlas.stats().pages).toBe(1);
    expect(atlas.stats().overwrites).toBe(200);
    expect(atlas.stats().activeCells).toBe(2);
    expect(atlas.audit(new Map([[still, 1], [cell, 1]])).counts).toEqual({});
  });

  it("a cell another quad still shows is never written over", async () => {
    const atlas = atlasWith({ size: 64 });
    atlas.attach(fakeDevice().device);

    // Two quads show one cell.
    const shared = atlas.acquire(line(1), 1);
    expect(atlas.acquire(line(1), 1)).toBe(shared);
    await drain();
    const rect = row(atlas, shared);

    // One of them changes.
    const changed = atlas.acquire(line(2), 1, shared);
    expect(row(atlas, changed)).toEqual(rect);
    await drain();

    // The other still shows the old pixels: the new ones took a rect of their own.
    expect(row(atlas, shared)).toEqual(rect);
    expect(row(atlas, changed)).not.toEqual(rect);
    expect(atlas.stats().overwrites).toBe(0);
    expect(atlas.audit(new Map([[shared, 1], [changed, 1]])).counts).toEqual({});
  });

  it("of two slots waiting behind one cell, the first to land takes a rect of its own and the last takes the cell's", async () => {
    const gates: Array<() => void> = [];
    const atlas = atlasWith({
      size: 64,
      rasterizeSprite: (quad) =>
        (quad.sprite as { cell: { col: number } }).cell.col === 1
          ? Promise.resolve(pixels(16, 16))
          : new Promise<AtlasPixels>((resolve) => gates.push(() => resolve(pixels(16, 16)))),
    });
    atlas.attach(fakeDevice().device);

    // Two quads show one cell, and each changes to a content of its own.
    const shared = atlas.acquire(line(1), 1);
    atlas.acquire(line(1), 1);
    await drain();
    const rect = row(atlas, shared);
    const one = atlas.acquire(line(2), 1, shared);
    const two = atlas.acquire(line(3), 1, shared);
    expect(one).not.toBe(two);
    await drain();
    expect(gates.length).toBe(2);
    expect(row(atlas, one)).toEqual(rect);
    expect(row(atlas, two)).toEqual(rect);

    // The first lands while the second still shows the cell: a rect of its own.
    gates[0]!();
    await drain();
    expect(row(atlas, one)).not.toEqual(rect);
    expect(row(atlas, two)).toEqual(rect);
    expect(atlas.stats().overwrites).toBe(0);
    expect(atlas.audit(new Map([[one, 1], [two, 1]])).counts).toEqual({});

    // The second is now the cell's only holder: its pixels go over it.
    gates[1]!();
    await drain();
    expect(row(atlas, two)).toEqual(rect);
    expect(atlas.stats().overwrites).toBe(1);
    expect(atlas.audit(new Map([[one, 1], [two, 1]])).counts).toEqual({});
  });

  it("a second quad that asks a key still waiting behind another quad's last cell gets a slot of its own", async () => {
    const gates: Array<() => void> = [];
    const atlas = atlasWith({
      size: 64,
      rasterizeSprite: (quad) =>
        (quad.sprite as { cell: { col: number } }).cell.col === 9
          ? new Promise<AtlasPixels>((resolve) => gates.push(() => resolve(pixels(16, 16))))
          : Promise.resolve(pixels(16, 16)),
    });
    atlas.attach(fakeDevice().device);

    const first = atlas.acquire(line(1), 1);
    await drain();
    // The first quad changes to content 9 and shows its old pixels meanwhile.
    const waiting = atlas.acquire(line(9), 1, first);
    expect(atlas.hasImage(waiting)).toBe(true);

    // 0.11.14: a second quad asking content 9 shared that cell, and drew the first quad's old content.
    const other = atlas.acquire(line(9), 1);
    expect(other).not.toBe(waiting);
    expect(atlas.hasImage(other)).toBe(false);

    await drain();
    for (const open of gates.splice(0)) open();
    await drain();
    expect(atlas.hasImage(other)).toBe(true);
    expect(atlas.hasImage(waiting)).toBe(true);
    // Landed, the key has one cell that any later quad shares.
    const third = atlas.acquire(line(9), 1);
    expect([waiting, other]).toContain(third);
    expect(atlas.audit().counts).toEqual({});
  });
});

describe("the renderer uploads the cell table only when revision() moves", () => {
  it("every change to a row the renderer may draw bumps revision()", async () => {
    const atlas = atlasWith({ size: 64 });
    atlas.attach(fakeDevice().device);

    // s: landed content. x: the same content at another scale, standing in on s.
    const s = atlas.acquire(mark(0), 1);
    await drain();
    const x = atlas.acquire(mark(0), 2);
    expect(row(atlas, x)).toEqual(row(atlas, s));
    // The renderer uploads here: the GPU row of x is s's rect.
    const uploaded = atlas.revision();
    atlas.binding.takeDirtyCells!();
    const gpuRowOfX = row(atlas, x);

    // x is let go before it rasterizes; a new, unrelated key recycles the index.
    atlas.release(x);
    const c = atlas.acquire(mark(9), 1);
    expect(atlas.cellIndex(c)).toBe(atlas.cellIndex(x));
    expect(atlas.hasImage(c)).toBe(false);

    // 0.11.14: the row was cleared and the revision stayed, so the GPU kept the last key's rect.
    // The CPU row changed (cleared), so the revision the renderer gates on must have moved.
    expect(row(atlas, c)).not.toEqual(gpuRowOfX);
    expect(atlas.revision()).not.toBe(uploaded);
  });
});

describe("a stand-in carries the texture its row points into", () => {
  it("a cell standing in on a page past the bind budget is drawn from that page", async () => {
    // Bind budget 2 -> one rgba page in the bind group; later pages are per-cell standalone.
    const atlas = atlasWith({ size: 64 });
    atlas.attach(fakeDevice({ maxSampledTexturesPerShaderStage: 2 } as Partial<GPUSupportedLimits>).device);

    // Nine held cells fill page 0; the tenth lands on page 1, past the budget.
    const held: number[] = [];
    for (let i = 0; i < 9; i += 1) held.push(atlas.acquire(mark(i), 1));
    await drain();
    const far = atlas.acquire(mark(50), 1);
    await drain();
    expect(atlas.hasImage(far)).toBe(true);
    const farTexture = atlas.binding.standalone!.get(atlas.cellIndex(far));
    expect(farTexture).toBeDefined();

    // The same content at another scale stands in on it: same rect, page word 0.
    const standIn = atlas.acquire(mark(50), 2);
    expect(standIn).not.toBe(NO_ATLAS_CELL);
    expect(row(atlas, standIn)).toEqual(row(atlas, far));
    // 0.11.14: the stand-in had the row and not the texture, so it drew page 0 with page 1's rect.
    // drawRuns picks the texture by the quad's own cell index.
    expect(atlas.binding.standalone!.get(atlas.cellIndex(standIn))).toBe(farTexture);
  });
});

describe("a cell is never moved once it is placed", () => {
  it("a page whose every plot holds a cell on screen adds a page, with no texture copy", async () => {
    // A 1024px page is four 512px plots; a 250px cell takes a quarter of one.
    const fake = fakeDevice();
    const atlas = atlasWith({
      size: 1024,
      rasterizeText: async (run, scale) => {
        if (run.text === "big") return pixels(300, 300);
        return scale < 1 ? pixels(30, 30) : pixels(250, 250);
      },
    });
    atlas.attach(fake.device);

    // Plot 0 is full: four cells.
    const p0: number[] = [];
    for (let i = 0; i < 4; i += 1) p0.push(atlas.acquire(textQuad(`p0-${i}`), 1));
    await drain();
    // Plots 1 and 2 are full and plot 3 is half full: ten cells, all on screen.
    const others: number[] = [];
    for (let i = 0; i < 10; i += 1) others.push(atlas.acquire(textQuad(`other-${i}`), 1));
    await drain();
    expect(atlas.stats().pages).toBe(1);

    // Three of plot 0's cells leave the screen for good, and a smaller copy of each is cached elsewhere.
    for (let i = 1; i <= 3; i += 1) {
      atlas.release(p0[i]!);
      const smaller = atlas.acquire(textQuad(`p0-${i}`), 0.5);
      await drain();
      atlas.release(smaller);
    }
    const keptRow = row(atlas, p0[0]!);

    // A 300px cell fits nowhere: plot 0 has dead cells, and one cell on screen.
    const big = atlas.acquire(textQuad("big"), 1);
    await drain();
    expect(atlas.hasImage(big)).toBe(true);
    // 0.11.14: moved p0[0] into plot 3 with a copy inside the page's own texture,
    // which WebGPU rejects, and pointed its row at the rect the copy never filled.
    expect(fake.textureCopies()).toBe(0);
    expect(row(atlas, p0[0]!)).toEqual(keptRow);
    expect(atlas.stats().pages).toBe(2);
    expect(atlas.stats().compactions).toBe(0);
    const held = new Map<number, number>([[p0[0]!, 1], [big, 1]]);
    for (const cell of others) held.set(cell, 1);
    expect(atlas.audit(held).counts).toEqual({});
  });
});

describe("eviction is by last use, and only off-screen content leaves", () => {
  it("a plot that holds only off-screen cells is reclaimed", async () => {
    // 512px page = one plot; a 300px cell fills it.
    const atlas = atlasWith({ size: 512, rasterizeSprite: async () => pixels(300, 300) });
    atlas.attach(fakeDevice().device);

    const a = atlas.acquire(mark(0), 1);
    await drain();
    expect(atlas.hasImage(a)).toBe(true);
    atlas.release(a); // off screen: cached

    const b = atlas.acquire(mark(1), 1);
    await drain();
    expect(atlas.hasImage(b)).toBe(true);
    // 0.11.14: kept the smallest copy of every content as a floor, never evicted
    // a plot that held one, and every plot held one. No cell is a floor now.
    expect(atlas.stats().pages).toBe(1);
    expect(atlas.stats().evictions).toBe(1);
    expect(atlas.audit(new Map([[b, 1]])).counts).toEqual({});
  });

  it("a plot that holds a cell on screen is never reclaimed, whatever its counter says", async () => {
    const atlas = atlasWith({ size: 512, rasterizeSprite: async () => pixels(300, 300) });
    atlas.attach(fakeDevice().device);

    const a = atlas.acquire(mark(0), 1);
    await drain();
    const aRow = row(atlas, a);

    const b = atlas.acquire(mark(1), 1);
    await drain();
    expect(atlas.hasImage(a)).toBe(true);
    expect(row(atlas, a)).toEqual(aRow);
    expect(atlas.stats().pages).toBe(2);
    expect(atlas.stats().evictions).toBe(0);
    expect(atlas.audit(new Map([[a, 1], [b, 1]])).counts).toEqual({});
  });
});

describe("a stand-in names a cell with pixels of its own", () => {
  it("a quad that asks again before its last answer landed does not stand in on a stand-in", async () => {
    const gates: Array<() => void> = [];
    const atlas = atlasWith({
      size: 256,
      rasterizeSprite: (quad) =>
        quad.rect.width === 32
          ? new Promise<AtlasPixels>((resolve) => gates.push(() => resolve(pixels(32, 32))))
          : Promise.resolve(pixels(quad.rect.width, quad.rect.height)),
    });
    atlas.attach(fakeDevice().device);

    // The quad's first picture lands.
    const first = atlas.acquire(mark(0), 1);
    await drain();
    expect(atlas.hasImage(first)).toBe(true);
    const firstRow = row(atlas, first);

    // Its content changes to a different box: the new cell shows the old picture until it lands.
    const second = atlas.acquire(spriteQuad({ atlas: "mark", cell: { col: 1, row: 0 } } as SpriteRef, 24, 24), 1, first);
    expect(second).not.toBe(first);
    expect(row(atlas, second)).toEqual(firstRow);

    // It changes again before `second` has landed (a zoom step, an expression change).
    const third = atlas.acquire(spriteQuad({ atlas: "mark", cell: { col: 2, row: 0 } } as SpriteRef, 32, 32), 1, second);
    expect(row(atlas, third)).toEqual(firstRow);

    // `second` lands; `third` is still being drawn.
    await drain();
    expect(gates.length).toBe(1);
    // 0.11.14: third stood in on second, which stood in on first. When second
    // landed it let go of first, and third went on naming first's rect with
    // nothing holding it there: the next eviction gave that rect to another item.
    expect(row(atlas, third)).toEqual(firstRow);
    expect(atlas.hasImage(first)).toBe(true);
    expect(atlas.audit(new Map([[third, 1]])).counts).toEqual({});

    gates[0]!();
    await drain();
    expect(atlas.hasImage(third)).toBe(true);
    expect(row(atlas, third)).not.toEqual(firstRow);
    expect(atlas.audit(new Map([[third, 1]])).counts).toEqual({});
  });

  it("a stand-in that is let go while its raster is in flight no longer names its target's rect", async () => {
    const gates: Array<() => void> = [];
    const atlas = atlasWith({
      size: 256,
      rasterizeSprite: (quad) =>
        quad.rect.width === 16
          ? Promise.resolve(pixels(16, 16))
          : new Promise<AtlasPixels>((resolve) => gates.push(() => resolve(pixels(quad.rect.width, quad.rect.height)))),
    });
    atlas.attach(fakeDevice().device);

    const first = atlas.acquire(mark(0), 1);
    await drain();
    const second = atlas.acquire(spriteQuad({ atlas: "mark", cell: { col: 1, row: 0 } } as SpriteRef, 24, 24), 1, first);
    await drain(); // second is rasterizing, standing in on first
    expect(gates.length).toBe(1);
    expect(row(atlas, second)).toEqual(row(atlas, first));

    atlas.release(second); // the quad leaves the screen before the raster answers
    // 0.11.14: let go of first and left second's row on first's rect.
    expect(row(atlas, second)).toEqual(new Array(ATLAS_CELL_FLOATS).fill(0));
    expect(atlas.audit().counts).toEqual({});

    gates[0]!();
    await drain();
    expect(atlas.audit().counts).toEqual({});
  });

  it("a cell of the other pool is never a stand-in", async () => {
    const atlas = createGpuAtlas({
      rasterizeText: async () => pixels(40, 12),
      rasterizeSprite: async () => pixels(16, 16),
    });
    atlas.attach(fakeDevice().device);

    const sprite = atlas.acquire(mark(0), 1);
    await drain();
    expect(atlas.hasImage(sprite)).toBe(true);

    // A text quad handed a sprite's cell as its previous: the text samples the coverage pages.
    // 0.11.14: the text cell took the sprite's row, a rect on the other pool's page.
    const text = atlas.acquire(textQuad("status"), 1, sprite);
    expect(text).not.toBe(sprite);
    expect(atlas.hasImage(text)).toBe(false);
  });
});

describe("a cell landed inside a frame has its smaller levels before the frame is drawn", () => {
  it("the levels are made when the renderer takes the cell table, not in a microtask after the submit", async () => {
    const events: string[] = [];
    const base = fakeDevice().device as unknown as Record<string, unknown>;
    // A device that can draw mip levels: the atlas makes four of them.
    const device = {
      ...base,
      createShaderModule: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({}),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        copyTextureToTexture: () => undefined,
        beginRenderPass: (desc: { colorAttachments: Array<{ loadOp: string }> }) => {
          if (desc.colorAttachments[0]!.loadOp === "load") events.push("mip pass");
          return { setPipeline: () => undefined, setBindGroup: () => undefined, setScissorRect: () => undefined, draw: () => undefined, end: () => undefined };
        },
        finish: () => ({}),
      }),
      queue: {
        copyExternalImageToTexture: () => events.push("level 0 copy"),
        writeTexture: () => undefined,
        submit: () => undefined,
        writeBuffer: () => undefined,
      },
    } as unknown as GPUDevice;
    const atlas = atlasWith({ size: 64, rasterizeSpriteSync: () => pixels(16, 16) });
    atlas.attach(device);

    // The frame: the scene takes a cell, finds it blank in view, and rasterizes it before submit.
    const cell = atlas.acquire(mark(0), 1);
    expect(atlas.ensureNow(cell)).toBe(true);
    const landed = atlas.revision();
    // The renderer's upload takes the cell table, still before the submit.
    atlas.binding.takeDirtyCells!();
    events.push("frame submit");
    // The frame function returns; only now do microtasks run.
    await settle();

    // 0.11.14: level 0 copy, frame submit, then the three mip passes: the frame
    // drew the new cell from the last occupant's smaller levels.
    expect(events).toEqual(["level 0 copy", "mip pass", "mip pass", "mip pass", "frame submit"]);
    // The frame that landed the cell drew it whole, levels included: nothing asks for another.
    expect(atlas.revision()).toBe(landed);
  });
});

/** A device that can draw mip levels (the atlas then keeps four, with an 8px gutter) and records every texel write. */
const recordingMipDevice = () => {
  type Write = {
    readonly op: "copy" | "write";
    readonly level: number;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    /** A write of nothing but zeros, long enough for its rect. */
    readonly clears: boolean;
  };
  const writes: Write[] = [];
  const base = fakeDevice().device as unknown as Record<string, unknown>;
  type Target = { readonly origin?: { readonly x?: number; readonly y?: number }; readonly mipLevel?: number };
  const device = {
    ...base,
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({}),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({
      copyTextureToTexture: () => undefined,
      beginRenderPass: () => ({ setPipeline: () => undefined, setBindGroup: () => undefined, setScissorRect: () => undefined, draw: () => undefined, end: () => undefined }),
      finish: () => ({}),
    }),
    queue: {
      copyExternalImageToTexture: (_source: unknown, target: Target, size: { width: number; height: number }) =>
        writes.push({ op: "copy", level: target.mipLevel ?? 0, x: target.origin?.x ?? 0, y: target.origin?.y ?? 0, width: size.width, height: size.height, clears: false }),
      writeTexture: (target: Target, data: Uint8Array, layout: { bytesPerRow: number }, size: { width: number; height: number }) =>
        writes.push({
          op: "write",
          level: target.mipLevel ?? 0,
          x: target.origin?.x ?? 0,
          y: target.origin?.y ?? 0,
          width: size.width,
          height: size.height,
          clears: data.length >= layout.bytesPerRow * size.height && data.every((byte) => byte === 0),
        }),
      submit: () => undefined,
      writeBuffer: () => undefined,
    },
  } as unknown as GPUDevice;
  return { device, writes };
};

describe("the gutter round a cell is clear", () => {
  it("a landing copies exactly its raster's pixels, not the scratch canvas beside them", () => {
    const { device, writes } = recordingMipDevice();
    // The raster drew 24 by 24 on a scratch canvas left 400 by 400 by an earlier, larger sprite.
    const scratch = { width: 400, height: 400 };
    const atlas = atlasWith({ rasterizeSpriteSync: () => ({ source: scratch, width: 24, height: 24 }) as unknown as AtlasPixels });
    atlas.attach(device);
    const cell = atlas.acquire(spriteQuad({ atlas: "mark", cell: { col: 0, row: 0 } } as SpriteRef, 24, 24), 1);
    expect(atlas.ensureNow(cell)).toBe(true);

    // 0.11.14: copied 32 by 32, the cell and its 8px gutter, and the scratch
    // was cleared one pixel past the cell: seven gutter pixels held the larger
    // sprite, and the smaller levels averaged them into the cell's edge.
    const copies = writes.filter((write) => write.op === "copy");
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ width: 24, height: 24 });
  });

  it("a plot handed out again is cleared at every level before its next cell lands", async () => {
    // A 64px colour page with four levels: one plot, four 16px cells with their 8px gutters.
    const { device, writes } = recordingMipDevice();
    const atlas = atlasWith({ size: 64 });
    atlas.attach(device);
    const first: number[] = [];
    for (let i = 0; i < 4; i += 1) first.push(atlas.acquire(mark(i), 1));
    await drain();
    expect(atlas.stats().pages).toBe(1);
    for (const cell of first) atlas.release(cell);

    // The fifth cell has no room: the plot, which nothing on screen holds, is wiped and reused.
    writes.length = 0;
    const next = atlas.acquire(mark(9), 1);
    await drain();
    expect(atlas.hasImage(next)).toBe(true);
    expect(atlas.stats().pages).toBe(1);
    expect(atlas.stats().evictions).toBe(4);

    // 0.11.14: the plot's cursor went back to its origin and its texels stayed,
    // so the new cell's gutter and smaller levels held the last cells' pixels.
    const landing = writes.findIndex((write) => write.op === "copy");
    expect(landing).toBeGreaterThan(-1);
    const cleared = writes.slice(0, landing).filter((write) => write.clears);
    expect(cleared.map((write) => [write.level, write.x, write.y, write.width, write.height])).toEqual([
      [0, 0, 0, 64, 64],
      [1, 0, 0, 32, 32],
      [2, 0, 0, 16, 16],
      [3, 0, 0, 8, 8],
    ]);
  });

  it("a text plot handed out again is cleared too", async () => {
    const { device, writes } = recordingMipDevice();
    const atlas = atlasWith({ size: 64, rasterizeText: async () => pixels(40, 40) });
    atlas.attach(device);
    const a = atlas.acquire(textQuad("a"), 1);
    await drain();
    atlas.release(a);

    writes.length = 0;
    const b = atlas.acquire(textQuad("b"), 1);
    await drain();
    expect(atlas.hasImage(b)).toBe(true);
    expect(atlas.stats().evictions).toBe(1);
    // 0.11.14: nothing cleared the plot. The first write is the whole plot, zeros; the cell follows.
    expect(writes[0]).toMatchObject({ op: "write", level: 0, x: 0, y: 0, width: 64, height: 64, clears: true });
    expect(writes.length).toBeGreaterThan(1);
  });
});

describe("an async sprite raster answers with pixels of its own", () => {
  it("two cells waiting on one decode each land their own picture", async () => {
    const g = globalThis as Record<string, unknown>;
    const saved = { document: g["document"], Image: g["Image"], createImageBitmap: g["createImageBitmap"] };
    const createObjectURL = URL.createObjectURL;
    const revokeObjectURL = URL.revokeObjectURL;
    // A canvas that remembers the last picture drawn on it, and a
    // createImageBitmap that, like the real one, copies what the canvas holds
    // at the moment it is called.
    type FakeCanvas = { width: number; height: number; holds: string; getContext: () => unknown };
    g["document"] = {
      createElement: (): FakeCanvas => {
        const canvas: FakeCanvas = {
          width: 1,
          height: 1,
          holds: "",
          getContext: () => ({
            clearRect: () => {
              canvas.holds = "";
            },
            drawImage: (_image: unknown, _x: number, _y: number, w: number, h: number) => {
              canvas.holds = `${w}x${h}`;
            },
          }),
        };
        return canvas;
      },
    };
    g["Image"] = class FakeImage {
      src = "";
      async decode(): Promise<void> {}
    };
    g["createImageBitmap"] = (source: FakeCanvas, _x: number, _y: number, width: number, height: number) => {
      const holds = source.holds;
      return Promise.resolve({ width, height, holds, close: () => undefined });
    };
    URL.createObjectURL = () => "blob:fake";
    URL.revokeObjectURL = () => undefined;

    try {
      const portrait = (side: number): Quad =>
        spriteQuad(
          { atlas: "image", key: "integrity-shared-scratch", svg: "<svg></svg>", size: { width: 40, height: 40 } } as SpriteRef,
          side,
          side,
        );
      // One portrait at two sizes, asked for in one frame: both wait on the same decode.
      const [small, large] = (await Promise.all([
        rasterizeSprite(portrait(20), "dark", 1),
        rasterizeSprite(portrait(40), "dark", 1),
      ])) as unknown as ReadonlyArray<{ readonly width: number; readonly holds?: string; readonly source?: unknown }>;

      // 0.11.14: both answers were the one scratch canvas, which by then held the
      // larger picture, so the small cell landed its top-left corner.
      expect(small!.source).toBeUndefined();
      expect(large!.source).toBeUndefined();
      expect(small!.holds).toBe("20x20");
      expect(large!.holds).toBe("40x40");
    } finally {
      g["document"] = saved.document;
      g["Image"] = saved.Image;
      g["createImageBitmap"] = saved.createImageBitmap;
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
    }
  });
});
describe("a recycled cell index", () => {
  it("does not trust or release a stale token for the new content at that index", async () => {
    const atlas = atlasWith({ size: 64 });
    atlas.attach(fakeDevice().device);

    const stale = atlas.acquire(mark(0), 1);
    // The first cell takes table index 0. Let go before the landing: an unlanded
    // slot is freed at once, so that index is the next one recycled.
    atlas.release(stale);

    // The index is recycled for other content. The old token must not be a reference to it.
    const replacement = atlas.acquire(mark(1), 1);
    expect(replacement).not.toBe(stale);
    await drain();
    expect(atlas.hasImage(replacement)).toBe(true);
    const replacementRow = Array.from(atlas.binding.cells.subarray(0, ATLAS_CELL_FLOATS));

    // Asked with the stale token, the atlas treats it as no previous at all: it neither
    // shows the replacement through the new ask nor lets the replacement's reference go.
    const next = atlas.acquire(mark(2), 1, stale);
    expect(next).not.toBe(replacement);
    expect(row(atlas, next)).not.toEqual(replacementRow);
    expect(atlas.stats().pinnedCells).toBe(2);

    // Releasing the stale token is a no-op; the replacement is still held and drawn.
    atlas.release(stale);
    expect(atlas.stats().pinnedCells).toBe(2);
    expect(atlas.hasImage(replacement)).toBe(true);
    expect(atlas.recordOf(replacement)?.state).toBe("landed");
    expect(atlas.audit(new Map([[replacement, 1], [next, 1]])).counts).toEqual({});

    atlas.release(replacement);
    atlas.release(next);
  });
});

