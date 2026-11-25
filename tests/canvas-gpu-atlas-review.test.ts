/**
 * canvas-nodes, review of the atlas at 8c5bbd294 (61dbe0378, 91fe299f2,
 * fca4bb9d5, 8c5bbd294). Every test in this file fails on 8c5bbd294. The
 * tests ask what each quad is shown, not which cell it holds, so they read
 * the same on a tree where cells are shared differently.
 *
 * R1  A cell is shared by key, but its stand-in belongs to one quad. A quad
 *     that joins a cell still waiting on its raster is shown the first
 *     quad's last picture, or gives its own last picture to the first quad,
 *     until the raster lands. These lines are older than the four commits.
 *     Passes on main at 2a0a7cb14 (closed by 96e115ecc).
 * R2  A page lost to out-of-memory clears its own cells' rows and leaves the
 *     rows, and the side-map textures, of the cells standing in on them.
 *     Passes on main at 2a0a7cb14 (closed by 96e115ecc).
 * R3  The clear texel at 0,0 of page 0, which every empty row samples, is
 *     given to the first raster that is exactly as wide as its plot.
 *     Failed on main at 2a0a7cb14; closed by the commit that added this file.
 *
 * The device here records what was copied where, so a test can say which
 * picture a cell's row names instead of comparing rows.
 */
import { describe, expect, it } from "vitest";
import { createGpuAtlas, type AtlasPixels, type GpuAtlasOptions } from "../src/window/canvas/engine/gpu-atlas";
import { ATLAS_CELL_FLOATS } from "../src/window/canvas/engine/types";
import type { Quad, QuadStyle, SpriteRef } from "../src/window/canvas/contract";
import { settle } from "./gpu-canvas-fakes";

type Tex = {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly format: string;
  destroyed: boolean;
  createView(): object;
  destroy(): void;
};
/** A copy of one raster, or a write of zeros (`picture` undefined), into a texture. */
type Op = { readonly tex: Tex; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly picture: string | undefined };

const recordingDevice = (mips = false) => {
  const ops: Op[] = [];
  const scopes: Array<{ readonly tex: Tex | undefined; resolve(error: { message: string } | null): void }> = [];
  let made = 0;
  let last: Tex | undefined;
  const base = {
    limits: { maxTextureDimension2D: 8192, maxTextureArrayLayers: 256, maxStorageBufferBindingSize: 128 * 1024 * 1024 },
    createTexture: (desc: GPUTextureDescriptor) => {
      const size = desc.size as GPUExtent3DDict;
      const tex: Tex = {
        id: ++made,
        width: size.width,
        height: size.height ?? 1,
        format: desc.format,
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
    createCommandEncoder: () => ({
      beginRenderPass: () => ({
        setPipeline: () => undefined,
        setBindGroup: () => undefined,
        setScissorRect: () => undefined,
        draw: () => undefined,
        end: () => undefined,
      }),
      finish: () => ({}),
    }),
    pushErrorScope: () => undefined,
    // The answer to an out-of-memory scope comes later, in a task of its own.
    popErrorScope: () =>
      new Promise<{ message: string } | null>((resolve) => {
        scopes.push({ tex: last, resolve });
      }),
    queue: {
      copyExternalImageToTexture: (
        src: { source: { picture?: string } },
        dst: { texture: Tex; origin?: { x?: number; y?: number }; mipLevel?: number },
        size: { width: number; height: number },
      ) => {
        ops.push({ tex: dst.texture, x: dst.origin?.x ?? 0, y: dst.origin?.y ?? 0, w: size.width, h: size.height, picture: src.source.picture ?? "a raster" });
      },
      writeTexture: (dst: { texture: Tex; origin?: { x?: number; y?: number }; mipLevel?: number }, data: Uint8Array, _layout: unknown, size: { width: number; height: number }) => {
        if ((dst.mipLevel ?? 0) !== 0) return;
        ops.push({ tex: dst.texture, x: dst.origin?.x ?? 0, y: dst.origin?.y ?? 0, w: size.width, h: size.height, picture: data.some((v) => v !== 0) ? "a raster" : undefined });
      },
      submit: () => undefined,
      writeBuffer: () => undefined,
    },
  };
  const device = (mips
    ? {
        ...base,
        createShaderModule: () => ({}),
        createBindGroupLayout: () => ({}),
        createPipelineLayout: () => ({}),
        createRenderPipeline: () => ({}),
        createBindGroup: () => ({}),
      }
    : base) as unknown as GPUDevice;
  /** The device reports, late, that it had no memory for this texture. */
  const lose = async (tex: Tex): Promise<void> => {
    scopes.find((scope) => scope.tex === tex)?.resolve({ message: "out of memory" });
    await settle();
  };
  return { device, ops, lose };
};

const style: QuadStyle = { ink: { token: "ink" } };

const spriteQuad = (sprite: SpriteRef, width: number, height: number): Quad => ({
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

/** A status mark: it has a synchronous raster. */
const mark = (col: number, size = 16): Quad => spriteQuad({ atlas: "mark", cell: { col, row: 0 } } as SpriteRef, size, size);

/** A portrait that is not decoded yet: no synchronous raster, and its decode is in the test's hands. */
const portrait = (name: string, size = 16): Quad =>
  spriteQuad({ atlas: "image", key: name, svg: "<svg/>", size: { width: 40, height: 40 } } as unknown as SpriteRef, size, size);

const textQuad = (text: string, width: number): Quad => ({
  key: "q",
  kind: "text",
  band: "cards",
  z: 0,
  rect: { x: 0, y: 0, width, height: 12 },
  tiers: 0,
  scale: { kind: "board" },
  style,
  text: { text, font: "body", size: 12, weight: 400, truncate: "end", width },
});

const drain = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await settle();
  }
};

const nameOf = (quad: Quad): string => {
  const ref = quad.sprite as unknown as { atlas: string; cell?: { col: number }; key?: string };
  return ref.atlas === "mark" ? `mark ${ref.cell!.col}` : `portrait ${ref.key}`;
};

const setup = (over: Partial<GpuAtlasOptions> = {}, mips = false) => {
  const gpu = recordingDevice(mips);
  const decodes: Array<{ land(): void; fail(): void }> = [];
  const raster = (quad: Quad, scale: number): AtlasPixels =>
    ({
      width: Math.max(1, Math.ceil(quad.rect.width * scale)),
      height: Math.max(1, Math.ceil(quad.rect.height * scale)),
      picture: nameOf(quad),
      close: () => undefined,
    }) as unknown as AtlasPixels;
  const atlas = createGpuAtlas({
    size: 64,
    rasterizeSpriteSync: (quad, _mode, scale) => (quad.sprite?.atlas === "mark" ? raster(quad, scale) : undefined),
    rasterizeSprite: (quad, _mode, scale) =>
      new Promise<AtlasPixels>((resolve, reject) => {
        decodes.push({ land: () => resolve(raster(quad, scale)), fail: () => reject(new Error("decode failed")) });
      }),
    rasterizeTextSync: (run, scale) =>
      ({ width: Math.ceil(run.width * scale), height: Math.ceil(run.size * scale * 1.2), data: new Uint8Array(Math.ceil(run.width * scale) * Math.ceil(run.size * scale * 1.2)).fill(255) }) as unknown as AtlasPixels,
    ...over,
  });
  atlas.attach(gpu.device);
  const row = (cell: number): number[] =>
    Array.from(atlas.binding.cells.subarray(atlas.cellIndex(cell) * ATLAS_CELL_FLOATS, atlas.cellIndex(cell) * ATLAS_CELL_FLOATS + ATLAS_CELL_FLOATS));
  /** The picture the renderer draws for this cell: what its row names, in the texture it is drawn from. */
  const shown = (cell: number): string => {
    const r = row(cell);
    if (!(r[2]! > r[0]! || r[3]! > r[1]!)) return "nothing";
    const tex = (atlas.binding.standalone?.get(atlas.cellIndex(cell)) ?? atlas.binding.rgbaPages?.[r[4]!]) as unknown as Tex | undefined;
    if (tex === undefined) return "a page that is not bound";
    if (tex.destroyed) return "a destroyed texture";
    const x = Math.round(r[0]! * tex.width);
    const y = Math.round(r[1]! * tex.height);
    const w = Math.round((r[2]! - r[0]!) * tex.width);
    const h = Math.round((r[3]! - r[1]!) * tex.height);
    for (let i = gpu.ops.length - 1; i >= 0; i -= 1) {
      const op = gpu.ops[i]!;
      if (op.tex !== tex || !(op.x < x + w && x < op.x + op.w && op.y < y + h && y < op.y + op.h)) continue;
      if (op.picture === undefined) return "cleared texels";
      return op.x === x && op.y === y && op.w === w && op.h === h ? op.picture : `part of ${op.picture}`;
    }
    return "texels nothing was copied to";
  };
  return { atlas, gpu, decodes, row, shown };
};

describe("R1: a quad is shown its own pictures, never another quad's", () => {
  it("a quad waiting on an undecoded picture is not given the last picture of a quad that joins its cell", async () => {
    const { atlas, shown } = setup();
    // Card one is new: its portrait is still decoding, so it draws nothing yet.
    const first = atlas.acquire(portrait("p"), 1);
    // Card two shows a mark.
    const badge = atlas.acquire(mark(1), 1);
    await drain();
    expect(shown(first)).toBe("nothing");
    expect(shown(badge)).toBe("mark 1");

    // Card two changes to the same portrait. It may keep its mark until the
    // portrait lands; card one never showed that mark. On 8c5bbd294 the two
    // share one cell, and gpu-atlas.ts:1752 stands it in on card two's last cell.
    const second = atlas.acquire(portrait("p"), 1, badge);
    expect(["nothing", "mark 1", "portrait p"]).toContain(shown(second));
    expect(["nothing", "portrait p"]).toContain(shown(first));
  });

  it("a failed raster does not leave another quad's picture on the cell", async () => {
    const { atlas, shown, decodes } = setup();
    const first = atlas.acquire(portrait("p"), 1);
    const badge = atlas.acquire(mark(1), 1);
    await drain();
    atlas.acquire(portrait("p"), 1, badge);

    // The decode fails: on 8c5bbd294 the cell is marked failed and keeps its
    // stand-in, and nothing asks for it again while its row has a picture.
    for (const decode of decodes) decode.fail();
    await drain();
    expect(["nothing", "portrait p"]).toContain(shown(first));
  });

  it("a quad that joins a waiting cell is not shown the first quad's last picture", async () => {
    const { atlas, shown } = setup();
    // Card one shows mark 1 on two quads, card two shows mark 2.
    const one = atlas.acquire(mark(1), 1);
    atlas.acquire(mark(1), 1);
    const two = atlas.acquire(mark(2), 1);
    await drain();

    // Card one changes to a portrait still decoding: it keeps mark 1 until
    // the portrait lands. That is its own last picture, and is as designed.
    const next = atlas.acquire(portrait("p"), 1, one);
    expect(shown(next)).toBe("mark 1");

    // Card two changes to the same portrait. On 8c5bbd294 it is handed that
    // cell (gpu-atlas.ts:1750). It showed mark 2, never mark 1.
    const joined = atlas.acquire(portrait("p"), 1, two);
    expect(["nothing", "mark 2", "portrait p"]).toContain(shown(joined));
  });

  it("a cell re-keyed in place and let go with its raster in flight is not handed on with the old picture", async () => {
    const { atlas, shown } = setup();
    const one = atlas.acquire(mark(1), 1);
    await drain();
    // On 8c5bbd294 the cell is re-keyed in place: the same index and rect,
    // mark 1's pixels until the portrait lands.
    const next = atlas.acquire(portrait("p"), 1, one);
    expect(shown(next)).toBe("mark 1");
    await drain();
    // The card goes away while the decode is in flight (gpu-atlas.ts:1686
    // keeps the cell under its new key).
    atlas.release(next);

    // A new card asks for that portrait. It has no last picture at all.
    const fresh = atlas.acquire(portrait("p"), 1);
    expect(["nothing", "portrait p"]).toContain(shown(fresh));
  });
});

describe("R2: a page lost to out-of-memory takes nothing live with it", () => {
  it("a stand-in on one of its cells no longer names the lost rect", async () => {
    const { atlas, gpu, shown } = setup();
    const one = atlas.acquire(mark(1), 1);
    atlas.acquire(mark(1), 1);
    await drain();
    const next = atlas.acquire(portrait("p"), 1, one);
    expect(shown(next)).toBe("mark 1");

    // The page under mark 1 is reported out of memory (gpu-atlas.ts:743).
    await gpu.lose(atlas.binding.rgbaPages![0] as unknown as Tex);

    // Mark 1's own row is cleared. The stand-in still names its rect, on a
    // page index that now holds the 1 by 1 fallback, and still counts as
    // having a picture, so the frame's blank check never looks at it.
    expect(atlas.audit().counts).toEqual({});
    expect(shown(next)).toBe("nothing");
  });

  it("a stand-in is not left drawing from the destroyed texture", async () => {
    const { atlas, gpu } = setup();
    // 40px marks on 64px pages: one to a page, so the ninth is on page 8,
    // past the eight a bind group holds, and is drawn from the side map.
    const cells: number[] = [];
    for (let col = 1; col <= 9; col += 1) cells.push(atlas.acquire(mark(col, 40), 1));
    atlas.acquire(mark(9, 40), 1);
    await drain();
    const ninth = cells[8]!;
    const page = atlas.binding.standalone?.get(atlas.cellIndex(ninth)) as unknown as Tex;
    expect(page).toBeDefined();

    // A stand-in on the ninth is drawn from the same texture.
    const next = atlas.acquire(portrait("p", 40), 1, ninth);
    expect(atlas.binding.standalone?.get(atlas.cellIndex(next))).toBe(page);

    await gpu.lose(page);
    expect(page.destroyed).toBe(true);
    // A destroyed texture in a frame's bind group fails the frame's submit.
    expect(atlas.binding.standalone?.get(atlas.cellIndex(next))).toBeUndefined();
  });
});

describe("R3: the texel at 0,0 of page 0 stays clear, because every empty row samples it", () => {
  it("a text raster as wide as its plot does not land on it", async () => {
    // Default pages: 512px plots, coverage gutter 1, so 511px is a full plot width.
    const { atlas, row } = setup({ size: undefined });
    const cell = atlas.acquire(textQuad("a title exactly as wide as a plot", 511), 1);
    await drain();
    const r = row(cell);
    expect(r[2]).toBeGreaterThan(0);
    // gpu-atlas.ts:863 (916 on main at 2a0a7cb14): 1 + 512 is past the plot,
    // so the cursor wraps to x 0 on a row of height 0, and y stays 0.
    expect([r[0], r[1]]).not.toEqual([0, 0]);
  });

  it("a sprite raster as wide as its plot does not land on it", async () => {
    // With mips the rgba gutter is 8, so 504px is a full plot width.
    const { atlas, row } = setup({ size: undefined }, true);
    const cell = atlas.acquire(mark(1, 504), 1);
    await drain();
    const r = row(cell);
    expect(r[2]).toBeGreaterThan(0);
    expect([r[0], r[1]]).not.toEqual([0, 0]);
  });
});
