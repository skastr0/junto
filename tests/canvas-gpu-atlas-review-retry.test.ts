/**
 * canvas-nodes, read of the rebuilt atlas (96e115ecc, a313820fe).
 *
 * P1  A failed slot is tried again only when a quad asks for it. `retryIfDue`
 *     (gpu-atlas.ts:1680) is called from `acquire` (:1710, :1736) and from
 *     `sourceFor` (:1819), and nothing calls it when a back-off runs out.
 *     Under references the scene asks once and then holds the cell: it asks
 *     again on a repaint or a new raster scale (scene.ts:1010, :1023), and
 *     its per-frame check looks only at quads that had no image when they
 *     took their cell (scene.ts:657 to :659, :2567). So a slot that fails
 *     while its quad has, or had, an image stays failed with nothing pending:
 *
 *     1, 2  the device answers late that it had no memory for a page, or for
 *           a texture of its own (`pixelsLost`, gpu-atlas.ts:1333): the quad
 *           draws nothing, and the scene counts no blank quad;
 *     3     a raster fails behind the pixels of the last scale (`backOff`,
 *           gpu-atlas.ts:1359, the same for a placement with no room,
 *           :1410): the quad keeps the last scale's pixels.
 *
 * All three fail on main at 2a0a7cb14. On 8c5bbd294, 1 and 3 fail the same
 * way, so the gap is older than the rebuild; 2 fails there at an earlier
 * line, because that atlas never heard a texture of its own refused.
 *
 * The tests run the real scene against the real atlas, past the 250 ms
 * back-off, so they hold whether the raster is tried again by a frame or by
 * a timer.
 *
 * Changed when the file landed, by canvas-services, and nothing else: the
 * wait is on a clock the test moves, not the real one (AGENTS.md, Testing:
 * no test waits on a real clock for product time to pass).
 *
 * canvas-nodes, read of P1's fix (0a390e1a3).
 *
 * P2  A texture the device refuses late was tried again 250 ms later, every
 *     time, for as long as it kept refusing. The back-off never grew:
 *     `landPixels` cleared `attempts` when the cell landed, which is before
 *     the device has answered for the texture, and `pixelsLost` waited
 *     BASE_RETRY_MS whatever came before. New with P1's timer: every cell
 *     that was on the page was rastered again four times a second, and a
 *     texture of its own was rastered and uploaded whole each time. Forty
 *     rasters in ten seconds without memory, for a page and for a texture of
 *     its own, where the back-off series allows six.
 *
 * Changed when these two landed, by canvas-services: they share this file's
 * device and board, and print nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asCanvasName } from "@shared/model";
import type { CardFact, Quad } from "../src/window/canvas/contract";
import { createGpuAtlas, type AtlasPixels } from "../src/window/canvas/engine/gpu-atlas";
import { createScene } from "../src/window/canvas/engine/scene";
import { ATLAS_CELL_FLOATS } from "../src/window/canvas/engine/types";
import { settle } from "./gpu-canvas-fakes";
import { seat } from "./support/model-nodes";

type Tex = { destroyed: boolean; createView(): object; destroy(): void };

/** A device whose out-of-memory answer for a texture is in the test's hands. */
const lateDevice = () => {
  const scopes: Array<{ readonly tex: Tex | undefined; resolve(error: { message: string } | null): void }> = [];
  let last: Tex | undefined;
  const device = {
    limits: { maxTextureDimension2D: 8192, maxTextureArrayLayers: 256, maxStorageBufferBindingSize: 128 * 1024 * 1024 },
    createTexture: () => {
      const tex: Tex = {
        destroyed: false,
        createView: () => ({}),
        destroy: () => {
          tex.destroyed = true;
        },
      };
      last = tex;
      return tex;
    },
    createSampler: () => ({}),
    pushErrorScope: () => undefined,
    popErrorScope: () =>
      new Promise<{ message: string } | null>((resolve) => {
        scopes.push({ tex: last, resolve });
      }),
    queue: {
      copyExternalImageToTexture: () => undefined,
      writeTexture: () => undefined,
      submit: () => undefined,
      writeBuffer: () => undefined,
    },
  } as unknown as GPUDevice;
  const lose = async (tex: unknown): Promise<void> => {
    scopes.find((scope) => scope.tex === tex)?.resolve({ message: "out of memory" });
    await settle();
  };
  /** Every texture asked for and not answered yet gets its answer now: it is there, or there was no memory for it. */
  const answer = async (memory: boolean): Promise<void> => {
    for (const scope of scopes.splice(0)) scope.resolve(memory ? null : { message: "out of memory" });
    await settle();
  };
  return { device, lose, answer };
};

const VIEW = { x: -100, y: -100, width: 800, height: 600 };

const card = (id: string): CardFact => ({ id, row: seat(id, { x: 0, y: 0 }), derived: { regionDepth: 0, blocked: false, z: 0 } });

const label = (key: string): Quad => ({
  key,
  kind: "text",
  band: "cards",
  z: 1,
  rect: { x: 8, y: 12, width: 120, height: 16 },
  tiers: 15,
  scale: { kind: "board" },
  style: {},
  text: { text: key, font: "mono", size: 12, weight: 500, truncate: "end", width: 120 },
});

/** `ms` pass on the test's clock, and what that set going settles. */
const turn = async (ms: number): Promise<void> => {
  vi.advanceTimersByTime(ms);
  await settle();
};

/** One card with one line of text, drawn by the real scene from the real atlas. */
const board = (pageSize?: number) => {
  const gpu = lateDevice();
  /** Raster scales whose next raster throws. */
  const failNext = new Set<number>();
  const rasters: number[] = [];
  const atlas = createGpuAtlas({
    ...(pageSize === undefined ? {} : { size: pageSize }),
    onFailure: () => undefined,
    rasterizeTextSync: (run, scale) => {
      rasters.push(scale);
      if (failNext.delete(scale)) throw new Error("no raster this time");
      const width = Math.ceil(run.width * scale);
      const height = Math.ceil(run.size * scale * 1.2);
      return { width, height, data: new Uint8Array(width * height).fill(255) } as unknown as AtlasPixels;
    },
  });
  atlas.attach(gpu.device);
  let scale = 1;
  const scene = createScene({
    painter: (fact) => ({ quads: [label(fact.id)], dim: { opacity: 1, saturate: 1 }, lift: 0 }),
    acquire: atlas.acquire,
    release: atlas.release,
    hasImage: atlas.hasImage,
    ensureNow: (cell: number) => {
      atlas.ensureNow(cell);
    },
    scale: () => scale,
  });
  scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [card("a")], wires: [] });
  const frame = (): void => {
    scene.prepare(VIEW, "near");
  };
  /** The one cell the card's quad holds. */
  const held = (): number => {
    const cells = [...scene.heldCells().keys()];
    expect(cells).toHaveLength(1);
    return cells[0]!;
  };
  /** How wide the rect the quad draws is, as a share of its page. */
  const drawnWidth = (): number => {
    const base = atlas.cellIndex(held()) * ATLAS_CELL_FLOATS;
    return atlas.binding.cells[base + 2]! - atlas.binding.cells[base]!;
  };
  /** Frames go on for well over the back-off, and the raster queue turns between them. */
  const frames = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) {
      await turn(75);
      frame();
    }
    await turn(0);
  };
  /** The device answers every 50 ms, with memory or without, while frames go on. */
  const run = async (ms: number, memory: boolean): Promise<void> => {
    for (let t = 0; t < ms; t += 50) {
      await gpu.answer(memory);
      await turn(50);
      frame();
    }
    await gpu.answer(memory);
  };
  return {
    atlas,
    gpu,
    scene,
    frame,
    held,
    drawnWidth,
    frames,
    run,
    failNext,
    rasters,
    zoomTo: (next: number): void => {
      scale = next;
    },
  };
};

describe("P1: a failed slot a quad still holds is tried again", () => {
  // The atlas's clock and its timers are the test's: time passes only in `turn`.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("when the device answers out of memory for its page", async () => {
    const { atlas, gpu, frame, held, frames } = board();
    frame();
    expect(atlas.hasImage(held())).toBe(true);

    await gpu.lose(atlas.binding.coveragePages![0]);
    expect(atlas.hasImage(held())).toBe(false);

    // Nobody repaints the card and nobody zooms.
    await frames();
    expect(atlas.hasImage(held())).toBe(true);
  });

  it("when the device answers out of memory for the texture of its own", async () => {
    // 64 px pages: the line is larger than a page and takes a texture of its own.
    const { atlas, gpu, frame, held, frames } = board(64);
    frame();
    const own = atlas.binding.standalone?.get(atlas.cellIndex(held()));
    expect(own).toBeDefined();
    expect(atlas.hasImage(held())).toBe(true);

    await gpu.lose(own);
    expect(atlas.hasImage(held())).toBe(false);

    await frames();
    expect(atlas.hasImage(held())).toBe(true);
  });

  it("when its raster fails behind the pixels of the last scale", async () => {
    const { frame, drawnWidth, frames, failNext, rasters, zoomTo } = board();
    frame();
    await turn(0);
    const before = drawnWidth();
    expect(before).toBeGreaterThan(0);

    // A zoom in comes to rest at twice the scale, and the first raster there fails.
    failNext.add(2);
    zoomTo(2);
    frame();
    await turn(0);
    expect(rasters.filter((scale) => scale === 2)).toHaveLength(1);
    // The quad keeps the pixels it had: the last scale's.
    expect(drawnWidth()).toBe(before);

    // The camera stays where it is.
    await frames();
    expect(rasters.filter((scale) => scale === 2).length).toBeGreaterThan(1);
    expect(drawnWidth()).toBeCloseTo(before * 2, 6);
  });
});

describe("P2: a texture the device keeps refusing late is tried later each time, not every 250 ms", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a page", async () => {
    const { atlas, gpu, frame, held, run, rasters } = board();
    // The two 1 px textures made on attach are fine.
    await gpu.answer(true);
    frame();
    expect(atlas.hasImage(held())).toBe(true);
    const first = rasters.length;

    // Ten seconds without memory. Back-offs of 250, 500, 1000, 2000 and 4000 ms end inside them.
    await run(10_000, false);
    expect(rasters.length - first).toBeLessThanOrEqual(6);
  });

  it("a texture of its own", async () => {
    // 64 px pages: the line is larger than a page and takes a texture of its own.
    const { atlas, gpu, frame, held, run, rasters } = board(64);
    await gpu.answer(true);
    frame();
    expect(atlas.binding.standalone?.get(atlas.cellIndex(held()))).toBeDefined();
    const first = rasters.length;

    await run(10_000, false);
    expect(rasters.length - first).toBeLessThanOrEqual(6);
  });
});
