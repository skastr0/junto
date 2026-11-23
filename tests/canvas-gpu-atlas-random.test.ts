/**
 * The atlas under random use.
 *
 * A model scene acquires, changes content, zooms, lets go and re-attaches
 * against the real createGpuAtlas, on a device that keeps every texel and
 * rejects what Dawn rejects (tests/gpu-atlas-strict-device.ts). Every raster
 * is stamped per content, scale and pixel, so the texels a quad's row points
 * at say whose pixels they are. After every step the checker holds the atlas
 * to what a frame needs:
 *
 *   - the device recorded no validation error;
 *   - the cell table the renderer would have uploaded equals the atlas's (the
 *     renderer uploads only when the revision moved, only the rows named
 *     dirty, and rebinds pages only when the texture generation moved);
 *   - `audit()` finds nothing, given the cells the model's quads hold;
 *   - a quad shows nothing, or the content it asked for (its own raster once
 *     that landed, any scale of it before), or what this very quad showed
 *     when it asked. Never another item's pixels, never a destroyed texture,
 *     never a rect that is part one raster and part another;
 *   - a quad that showed pixels still shows pixels, unless they sat in a
 *     texture the device made out of memory;
 *   - the gutter round every shown rect is clear, so a smaller mip level and
 *     a linear tap at the edge read nothing of a neighbour;
 *   - texel (0, 0) of page 0 of each pool is clear: a row of zeros is still
 *     drawn, and reads it.
 *
 * Every scenario has content exactly as wide as a plot, and as large as one:
 * the rect that does not fit beside that texel.
 *
 * A run is a seed: the clock, the order rasters land in and every choice come
 * from it, so a failure names the step and replays.
 *
 *   ATLAS_RANDOM_COLLECT=1   count every violation kind and go on, to list what a build has
 *   ATLAS_RANDOM_IGNORE=a,b  pass over these kinds, to read the next kind's trace
 *   ATLAS_RANDOM_SEEDS=n     n seeds per scenario, for a soak
 *   ATLAS_RANDOM_STEPS=n     steps per run
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGpuAtlas, type AtlasCanvasRegion, type AtlasCoverage, type AtlasPixels } from "../src/window/canvas/engine/gpu-atlas";
import { ATLAS_CELL_FLOATS, atlasBindBudget } from "../src/window/canvas/engine/types";
import { NO_ATLAS_CELL } from "../src/window/canvas/engine/quad";
import type { Quad, QuadStyle, SpriteRef } from "../src/window/canvas/contract";
import { strictDevice, type StampSource, type StrictDevice, type StrictTexture } from "./gpu-atlas-strict-device";

type Kind = "text" | "sprite";

/** One thing a quad can show. A text content's `h` is its font size. */
type Content = {
  readonly id: number;
  readonly kind: Kind;
  readonly w: number;
  readonly h: number;
  /** A sprite with an undecoded source: no synchronous raster until one asynchronous raster of it has landed. */
  readonly cold: boolean;
  /** Contents of one family have one box, so one's pixels can be written over another's rect. */
  readonly family: number;
};

type Shown = { readonly content: Content; readonly scale: number };

type ModelQuad = {
  readonly name: number;
  cell: number;
  /** What it asked for: a content and an index into the scales. */
  want: Shown | undefined;
  /** Content ids it may show: what it asked for, and what it showed when it asked. */
  allowed: Set<number>;
  /** It has shown the very raster it asked for since it asked. */
  settled: boolean;
  /** It showed pixels at the last check, so it shows pixels now. */
  lit: boolean;
  /** What the last check found on it. */
  showing: Shown | undefined;
};

type Config = {
  readonly name: string;
  readonly seed: number;
  readonly steps: number;
  /** The atlas page edge. */
  readonly page: number;
  readonly limits?: Partial<GPUSupportedLimits>;
  readonly scales: ReadonlyArray<number>;
  readonly contents: ReadonlyArray<Content>;
  readonly quads: number;
  /** Queued text rasters go to the asynchronous rasterizer, as with raster workers. */
  readonly asyncText: boolean;
  /** Allocations run out of memory, and the device says so some steps later. */
  readonly outOfMemory?: boolean;
};

const style: QuadStyle = { ink: { token: "ink" } };

/** Violation kinds to pass over, for reading the next kind's trace while a build still has the first. */
const ignored = new Set((process.env.ATLAS_RANDOM_IGNORE ?? "").split(",").filter((kind) => kind !== ""));

const mulberry32 = (seed: number) => {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const mix = (seed: number, x: number, y: number): number => {
  let h = Math.imul(seed + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(x + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(y + 0x165667b1, 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
};

/** The stamp a raster of `seed` carries at a pixel. Coverage travels as one byte; never 0, which is an unwritten texel. */
const stampOf = (kind: Kind, seed: number, x: number, y: number): number =>
  kind === "text" ? 1 + (mix(seed, x, y) % 255) : 1 + (mix(seed, x, y) % 0x3fffffff);

const seedOf = (shown: Shown): number => shown.content.id * 16 + shown.scale + 1;

const families = (spec: ReadonlyArray<{ readonly kind: Kind; readonly w: number; readonly h: number; readonly count: number; readonly cold?: boolean }>): Content[] => {
  const out: Content[] = [];
  spec.forEach((family, index) => {
    for (let i = 0; i < family.count; i += 1) {
      out.push({ id: out.length, kind: family.kind, w: family.w, h: family.h, cold: family.cold ?? false, family: index });
    }
  });
  return out;
};

const quadOf = (content: Content): Quad => ({
  key: `q${content.id}`,
  kind: content.kind,
  band: "cards",
  z: 0,
  rect: { x: 0, y: 0, width: content.w, height: content.h },
  tiers: 0,
  scale: { kind: "board" },
  style,
  ...(content.kind === "text"
    ? { text: { text: `c${content.id}`, font: "mono", size: content.h, weight: 400, truncate: "end", width: content.w } }
    : { sprite: { atlas: "mark", cell: { col: content.id, row: 0 } } as SpriteRef }),
});

type Outcome = {
  readonly steps: number;
  /** Violations by kind, with the first of each. Empty when the atlas held. */
  readonly violations: ReadonlyMap<string, { readonly count: number; readonly first: string }>;
  readonly pages: number;
  readonly evictions: number;
  /** Landings written over the cell their quad showed before. */
  readonly overwrites: number;
  readonly landed: number;
};

/**
 * Run one seeded scenario. With `collect`, a violation is counted and the run
 * goes on (to list the kinds a build has); without, the first one throws.
 */
const run = async (config: Config, collect = false): Promise<Outcome> => {
  const random = mulberry32(config.seed);
  const below = (n: number): number => Math.floor(random() * n);
  const pick = <T>(xs: ReadonlyArray<T>): T => xs[below(xs.length)]!;
  const chance = (p: number): boolean => random() < p;

  const byId = new Map(config.contents.map((c) => [c.id, c] as const));
  const sizeOf = (shown: Shown): { readonly w: number; readonly h: number } => {
    const scale = config.scales[shown.scale]!;
    const { content } = shown;
    return content.kind === "text"
      ? { w: Math.max(1, Math.ceil(content.w * scale)), h: Math.max(1, Math.ceil(content.h * scale * 1.2)) }
      : { w: Math.max(1, Math.ceil(content.w * scale)), h: Math.max(1, Math.ceil(content.h * scale)) };
  };
  /** Every raster there is, by kind and size: what a rect of that size can hold. */
  const bySize = new Map<string, Shown[]>();
  for (const content of config.contents) {
    for (let scale = 0; scale < config.scales.length; scale += 1) {
      const shown = { content, scale };
      const { w, h } = sizeOf(shown);
      const key = `${content.kind}:${w}x${h}`;
      const list = bySize.get(key);
      if (list === undefined) bySize.set(key, [shown]);
      else list.push(shown);
    }
  }

  // --- The clock: the atlas reads performance.now() for its retry backoff.
  let clock = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);

  // --- Rasterizers ------------------------------------------------------------
  const shownOf = (quad: Quad, scale: number): Shown => {
    const id = quad.text !== undefined ? Number(quad.text.text.slice(1)) : (quad.sprite as { cell: { col: number } }).cell.col;
    const index = config.scales.indexOf(scale);
    if (index < 0) throw new Error(`a raster was asked at scale ${scale}, which no quad asked for`);
    return { content: byId.get(id)!, scale: index };
  };
  const coverage = new Map<number, AtlasCoverage>();
  const coverageOf = (shown: Shown): AtlasCoverage => {
    const seed = seedOf(shown);
    let made = coverage.get(seed);
    if (made === undefined) {
      const { w, h } = sizeOf(shown);
      const data = new Uint8Array(w * h);
      for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) data[y * w + x] = stampOf("text", seed, x, y);
      made = { width: w, height: h, data };
      coverage.set(seed, made);
    }
    return made;
  };
  /** An owned bitmap, as an asynchronous raster hands over. Copying from it after close is an error. */
  const bitmapOf = (shown: Shown): AtlasPixels => {
    const seed = seedOf(shown);
    const { w, h } = sizeOf(shown);
    const bitmap = {
      width: w,
      height: h,
      closed: false,
      stampAt: (x: number, y: number) => stampOf("sprite", seed, x, y),
      close: () => {
        bitmap.closed = true;
      },
    };
    return bitmap as unknown as AtlasPixels;
  };
  /**
   * The one scratch canvas every synchronous sprite raster draws on, as the
   * browser rasterizers share one: it only grows, growing clears it, and a
   * draw clears just its own box and one pixel more. What a raster returns is
   * a view of it, good until the next raster.
   */
  const scratch = {
    width: 0,
    height: 0,
    grid: new Int32Array(0),
    stampAt: (x: number, y: number): number => scratch.grid[y * scratch.width + x] ?? 0,
  };
  const drawScratch = (shown: Shown): AtlasCanvasRegion => {
    const seed = seedOf(shown);
    const { w, h } = sizeOf(shown);
    if (w + 1 > scratch.width || h + 1 > scratch.height) {
      scratch.width = Math.max(scratch.width, w + 1);
      scratch.height = Math.max(scratch.height, h + 1);
      scratch.grid = new Int32Array(scratch.width * scratch.height);
    } else {
      for (let y = 0; y <= h; y += 1) scratch.grid.fill(0, y * scratch.width, y * scratch.width + w + 1);
    }
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) scratch.grid[y * scratch.width + x] = stampOf("sprite", seed, x, y);
    }
    return { source: scratch as unknown as HTMLCanvasElement, width: w, height: h };
  };
  /** Sprite sources that are decoded: a cold one joins when its first asynchronous raster lands. */
  const warm = new Set<number>();
  /** Asynchronous rasters in flight; the model lands them in any order. */
  const jobs: Array<(ok: boolean) => void> = [];
  const later = (make: () => AtlasPixels): Promise<AtlasPixels> =>
    new Promise<AtlasPixels>((resolve, reject) => {
      jobs.push((ok) => {
        if (ok) resolve(make());
        else reject(new Error("the raster failed"));
      });
    });

  const atlas = createGpuAtlas({
    size: config.page,
    preferAsyncRaster: config.asyncText,
    rasterizeTextSync: (run, scale) => coverageOf(shownOf({ text: run } as Quad, scale)),
    rasterizeText: (run, scale) => {
      const shown = shownOf({ text: run } as Quad, scale);
      return later(() => coverageOf(shown));
    },
    rasterizeSpriteSync: (quad, _mode, scale) => {
      const shown = shownOf(quad, scale);
      if (shown.content.cold && !warm.has(shown.content.id)) return undefined;
      return drawScratch(shown);
    },
    rasterizeSprite: (quad, _mode, scale) => {
      const shown = shownOf(quad, scale);
      return later(() => {
        warm.add(shown.content.id);
        return bitmapOf(shown);
      });
    },
  });

  // --- The device and the renderer's copy of the table -------------------------
  const devices: StrictDevice[] = [];
  let budget = atlasBindBudget();
  /** The cell table as the GPU has it. */
  let gpu = new Float32Array(0);
  let gpuCapacity = 0;
  let gpuRevision = -1;
  /** The pages the bind group holds, taken when the texture generation moved. */
  let boundGeneration = -1;
  let bound: { rgba: ReadonlyArray<StrictTexture>; coverage: ReadonlyArray<StrictTexture> } = { rgba: [], coverage: [] };
  const attach = (): void => {
    const next = strictDevice({ ...(config.limits === undefined ? {} : { limits: config.limits }) });
    devices.push(next);
    budget = atlasBindBudget(next.device);
    atlas.attach(next.device);
    // A new device: the renderer makes its buffers and bind group anew.
    gpuRevision = -1;
    boundGeneration = -1;
  };
  attach();

  // --- The model ---------------------------------------------------------------
  const quads: ModelQuad[] = [];
  for (let i = 0; i < config.quads; i += 1) {
    quads.push({ name: i, cell: NO_ATLAS_CELL, want: undefined, allowed: new Set(), settled: false, lit: false, showing: undefined });
  }
  const trace: string[] = [];
  const violations = new Map<string, { count: number; first: string }>();
  let step = 0;
  const fail = (kind: string, detail: string): void => {
    if (ignored.has(kind)) return;
    const message = `${kind}: ${detail}`;
    if (!collect) {
      throw new Error(
        `atlas violation at step ${step} of "${config.name}" (seed ${config.seed})\n  ${message}\n  last steps:\n    ${trace.slice(-25).join("\n    ")}`,
      );
    }
    const seen = violations.get(kind);
    if (seen === undefined) violations.set(kind, { count: 1, first: `step ${step}: ${detail}` });
    else seen.count += 1;
  };
  const label = (shown: Shown | undefined): string => (shown === undefined ? "nothing" : `c${shown.content.id}@${config.scales[shown.scale]}`);

  // --- What a quad shows -------------------------------------------------------
  type Display = {
    readonly tex: StrictTexture;
    /** On a page of its pool, where a gutter applies; not in a texture of its own. */
    readonly paged: boolean;
    readonly tilesX: number;
    readonly tilesY: number;
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  };
  const rowKey = (cell: number): string => {
    const base = cell * ATLAS_CELL_FLOATS;
    return Array.from(gpu.subarray(base, base + ATLAS_CELL_FLOATS)).join(",");
  };
  /**
   * The texture and rect the shader reads for `cell` drawn as `kind`, from the
   * uploaded table and the bound pages. "lost" is a texture made out of
   * memory that the device has not owned up to yet: it draws nothing, and the
   * atlas cannot know.
   */
  const displayOf = (cell: number, kind: Kind, who: string): Display | "lost" | undefined => {
    const base = cell * ATLAS_CELL_FLOATS;
    const u0 = gpu[base]!;
    const v0 = gpu[base + 1]!;
    const u1 = gpu[base + 2]!;
    const v1 = gpu[base + 3]!;
    const pages = kind === "text" ? bound.coverage : bound.rgba;
    const slots = kind === "text" ? budget.coverage : budget.rgba;
    const own = atlas.binding.standalone?.get(cell) as unknown as StrictTexture | undefined;
    // A dedicated texture takes page 0 of the pool its format names.
    const applies = own !== undefined && (own.format === "r8unorm") === (kind === "text");
    if (own !== undefined && !applies) {
      fail("texture-of-other-pool", `${who}: cell ${cell} is drawn as ${kind} and carries a ${own.format} texture`);
    }
    if (!(u1 > u0 || v1 > v0)) {
      // A row of zeros reads texel (0, 0) of page 0, which the atlas keeps
      // clear: the checker looks at it after every step.
      if (applies) fail("blank-row-with-texture", `${who}: cell ${cell} has no rect and carries texture ${own!.id}`);
      return undefined;
    }
    const tiled = gpu[base + 5]! > 0.5;
    const tilesX = tiled ? Math.round(gpu[base + 5]!) : 1;
    const tilesY = tiled ? Math.max(1, Math.round(gpu[base + 6]!)) : 1;
    let index = tiled ? 0 : Math.max(0, Math.floor(gpu[base + 4]!));
    if (index >= slots) index = 0;
    const tex = index === 0 && applies ? own : (pages[index] ?? (applies ? own : pages[0]));
    if (tex === undefined) {
      fail("no-texture", `${who}: cell ${cell} names ${kind} page ${index}, and no such page is bound`);
      return undefined;
    }
    if (tex.isDestroyed()) {
      fail("destroyed-texture", `${who}: cell ${cell} reads texture ${tex.id}, which is destroyed`);
      return undefined;
    }
    if (tex.isLost()) return "lost";
    if (tex.depthOrArrayLayers < tilesX * tilesY) {
      fail("tiles-past-layers", `${who}: cell ${cell} names ${tilesX}x${tilesY} tiles of a ${tex.depthOrArrayLayers} layer texture`);
      return undefined;
    }
    const spanW = tex.width * tilesX;
    const spanH = tex.height * tilesY;
    const edges = [u0 * spanW, v0 * spanH, u1 * spanW, v1 * spanH];
    const [x, y, x1, y1] = edges.map((e) => Math.round(e)) as [number, number, number, number];
    if (edges.some((e, i) => Math.abs(e - [x, y, x1, y1][i]!) > 1e-2)) {
      fail("row-off-texel", `${who}: cell ${cell} row ${rowKey(cell)} is not on texel edges of texture ${tex.id}`);
      return undefined;
    }
    if (x < 0 || y < 0 || x1 > spanW || y1 > spanH || x1 <= x || y1 <= y) {
      fail("row-out-of-texture", `${who}: cell ${cell} row ${rowKey(cell)} is outside texture ${tex.id}`);
      return undefined;
    }
    return { tex, paged: pages.includes(tex), tilesX, tilesY, x, y, w: x1 - x, h: y1 - y };
  };
  /** Does the rect hold exactly the raster of `shown`. */
  const holds = (d: Display, kind: Kind, shown: Shown): boolean => {
    const seed = seedOf(shown);
    if (d.tilesX * d.tilesY === 1) {
      const texels = d.tex.texels(0);
      if (texels === undefined) return false;
      for (let py = 0; py < d.h; py += 1) {
        const base = (d.y + py) * d.tex.width + d.x;
        for (let px = 0; px < d.w; px += 1) {
          if (texels[base + px] !== stampOf(kind, seed, px, py)) return false;
        }
      }
      return true;
    }
    for (let py = 0; py < d.h; py += 1) {
      const ty = Math.floor(py / d.tex.height);
      for (let px = 0; px < d.w; px += 1) {
        const tx = Math.floor(px / d.tex.width);
        if (d.tex.at(px - tx * d.tex.width, py - ty * d.tex.height, ty * d.tilesX + tx) !== stampOf(kind, seed, px, py)) return false;
      }
    }
    return true;
  };
  /** The first written texel in the gutter round a paged rect, if any. */
  const gutterOf = (d: Display): string | undefined => {
    if (!d.paged) return undefined;
    const g = d.tex.mipLevelCount > 1 ? 1 << (d.tex.mipLevelCount - 1) : 1;
    const texels = d.tex.texels(0);
    if (texels === undefined) return undefined;
    const x0 = Math.max(0, d.x - g);
    const y0 = Math.max(0, d.y - g);
    const x1 = Math.min(d.tex.width, d.x + d.w + g);
    const y1 = Math.min(d.tex.height, d.y + d.h + g);
    for (let y = y0; y < y1; y += 1) {
      const inside = y >= d.y && y < d.y + d.h;
      for (let x = x0; x < x1; x += 1) {
        if (inside && x >= d.x && x < d.x + d.w) {
          x = d.x + d.w - 1;
          continue;
        }
        const stamp = texels[y * d.tex.width + x]!;
        if (stamp !== 0) return `texel (${x}, ${y}) of texture ${d.tex.id} holds ${stamp}, ${g} px gutter of rect (${d.x}, ${d.y}, ${d.w}x${d.h})`;
      }
    }
    return undefined;
  };
  type Verdict = { readonly tex: StrictTexture; readonly serial: number; readonly row: string; readonly found: Shown | undefined; readonly gutter: string | undefined };
  const verdicts = new Map<string, Verdict>();
  const verdictOf = (cell: number, kind: Kind, d: Display): Verdict => {
    const key = `${kind}:${cell}`;
    const row = rowKey(cell);
    const g = d.tex.mipLevelCount > 1 ? 1 << (d.tex.mipLevelCount - 1) : 1;
    const before = verdicts.get(key);
    if (
      before !== undefined &&
      before.tex === d.tex &&
      before.row === row &&
      (d.tilesX * d.tilesY === 1 && d.paged
        ? !d.tex.touchedSince(before.serial, 0, d.x - g, d.y - g, d.w + 2 * g, d.h + 2 * g)
        : before.serial === d.tex.serial())
    ) {
      return before;
    }
    let found: Shown | undefined;
    for (const candidate of bySize.get(`${kind}:${d.w}x${d.h}`) ?? []) {
      if (holds(d, kind, candidate)) {
        found = candidate;
        break;
      }
    }
    const verdict: Verdict = { tex: d.tex, serial: d.tex.serial(), row, found, gutter: gutterOf(d) };
    verdicts.set(key, verdict);
    return verdict;
  };

  // --- The checker, after every step -------------------------------------------
  const check = (): void => {
    for (const each of devices) {
      if (each.errors.length > 0) {
        fail("device-error", each.errors.slice(0, 3).join(" | "));
        (each.errors as string[]).length = 0;
      }
    }
    // Upload as the renderer does.
    const binding = atlas.binding;
    const generation = binding.textureGeneration ?? 0;
    if (generation !== boundGeneration) {
      boundGeneration = generation;
      bound = {
        rgba: [...(binding.rgbaPages ?? [])] as unknown as StrictTexture[],
        coverage: [...(binding.coveragePages ?? [])] as unknown as StrictTexture[],
      };
    }
    // The texel every empty row reads, in each pool, whether or not a quad has an empty row now.
    for (const [kind, pages] of [["text", bound.coverage], ["sprite", bound.rgba]] as const) {
      const first = pages[0];
      if (first !== undefined && !first.isDestroyed() && first.at(0, 0) !== 0) {
        fail("reserved-texel-written", `texel (0, 0) of ${kind} page 0 holds ${first.at(0, 0)}`);
      }
    }
    const cells = binding.cells;
    const cellCount = binding.cellCount ?? Math.floor(cells.length / ATLAS_CELL_FLOATS);
    if (cellCount > gpuCapacity) {
      gpuCapacity = Math.max(cellCount, gpuCapacity * 2, 1);
      const grown = new Float32Array(gpuCapacity * ATLAS_CELL_FLOATS);
      grown.set(gpu.subarray(0, Math.min(gpu.length, grown.length)));
      gpu = grown;
      gpuRevision = -1;
    }
    const revision = atlas.revision();
    if (revision !== gpuRevision) {
      const dirty = binding.takeDirtyCells?.();
      if (dirty === undefined || dirty.all || gpuRevision === -1) {
        gpu.set(cells.subarray(0, cellCount * ATLAS_CELL_FLOATS));
      } else {
        for (const slot of dirty.slots) {
          const base = slot * ATLAS_CELL_FLOATS;
          if (base + ATLAS_CELL_FLOATS <= gpu.length) gpu.set(cells.subarray(base, base + ATLAS_CELL_FLOATS), base);
        }
      }
      gpuRevision = revision;
    }
    const held = new Map<number, number>();
    for (const q of quads) {
      if (q.cell !== NO_ATLAS_CELL) held.set(q.cell, (held.get(q.cell) ?? 0) + 1);
    }
    for (const cell of held.keys()) {
      const base = cell * ATLAS_CELL_FLOATS;
      for (let i = 0; i < ATLAS_CELL_FLOATS; i += 1) {
        if (gpu[base + i] !== cells[base + i]) {
          fail("row-not-uploaded", `cell ${cell} is ${Array.from(cells.subarray(base, base + ATLAS_CELL_FLOATS)).join(",")} and the GPU has ${rowKey(cell)}: the revision or the dirty list missed a change`);
          gpu.set(cells.subarray(base, base + ATLAS_CELL_FLOATS), base);
          break;
        }
      }
    }
    const audit = atlas.audit(held);
    for (const [kind, count] of Object.entries(audit.counts)) {
      const sample = audit.samples.find((s) => s.kind === kind);
      fail(`audit ${kind}`, `${count} found, first: cell ${sample?.cell} ${sample?.key ?? ""} ${sample?.detail ?? ""}`);
    }
    for (const q of quads) {
      if (q.cell === NO_ATLAS_CELL || q.want === undefined) continue;
      const kind = q.want.content.kind;
      const who = `quad ${q.name} (asked ${label(q.want)})`;
      const d = displayOf(q.cell, kind, who);
      if (d === undefined || d === "lost") {
        if (q.lit && d !== "lost") fail("went-blank", `${who} showed ${label(q.showing)} and now shows nothing, cell ${q.cell}`);
        q.lit = false;
        q.showing = undefined;
        continue;
      }
      const verdict = verdictOf(q.cell, kind, d);
      const found = verdict.found;
      if (found === undefined) {
        fail("torn-pixels", `${who}: cell ${q.cell} rect (${d.x}, ${d.y}, ${d.w}x${d.h}) of texture ${d.tex.id} holds no one raster`);
        q.showing = undefined;
        continue;
      }
      if (!q.allowed.has(found.content.id)) {
        fail("other-items-pixels", `${who} shows ${label(found)}, cell ${q.cell}; it may show ${[...q.allowed].map((id) => `c${id}`).join(" or ")}`);
      } else if (q.settled && (found.content !== q.want.content || found.scale !== q.want.scale)) {
        fail("lost-own-raster", `${who} had its own raster and now shows ${label(found)}, cell ${q.cell}`);
      }
      if (found.content === q.want.content && found.scale === q.want.scale) {
        q.settled = true;
        q.allowed = new Set([found.content.id]);
      }
      if (verdict.gutter !== undefined) fail("gutter-written", `${who}: ${verdict.gutter}`);
      q.lit = true;
      q.showing = found;
    }
  };

  // --- Steps -------------------------------------------------------------------
  const turn = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  const ask = (q: ModelQuad, want: Shown): void => {
    const previous = q.cell;
    const sameKey = q.want !== undefined && q.want.content === want.content && q.want.scale === want.scale;
    const cell = atlas.acquire(quadOf(want.content), config.scales[want.scale]!, previous === NO_ATLAS_CELL ? undefined : previous);
    if (cell === NO_ATLAS_CELL) fail("no-cell", `quad ${q.name} asked ${label(want)} and got no cell`);
    if (sameKey && cell !== previous) fail("same-key-moved", `quad ${q.name} asked ${label(want)} again and cell ${previous} became ${cell}`);
    if (!sameKey) {
      const kept = q.showing !== undefined && q.showing.content.kind === want.content.kind ? q.showing : undefined;
      q.allowed = new Set(kept === undefined ? [want.content.id] : [want.content.id, kept.content.id]);
      q.settled = false;
      q.lit = kept !== undefined;
    }
    q.cell = cell;
    q.want = want;
  };
  const drop = (q: ModelQuad): void => {
    atlas.release(q.cell);
    q.cell = NO_ATLAS_CELL;
    q.want = undefined;
    q.allowed = new Set();
    q.settled = false;
    q.lit = false;
    q.showing = undefined;
  };
  const neighbourScale = (scale: number): number => Math.max(0, Math.min(config.scales.length - 1, scale + (chance(0.5) ? 1 : -1)));
  const sibling = (content: Content): Content => pick(config.contents.filter((c) => c.family === content.family));
  let zoom = below(config.scales.length);

  const once = async (): Promise<string> => {
    const roll = random() * 100;
    const holding = quads.filter((q) => q.cell !== NO_ATLAS_CELL);
    if (roll < 26) {
      const q = pick(quads);
      if (q.want === undefined) {
        const want = { content: pick(config.contents), scale: chance(0.8) ? zoom : below(config.scales.length) };
        ask(q, want);
        return `quad ${q.name} asks ${label(want)}`;
      }
      const how = random();
      const want: Shown =
        how < 0.35
          ? { content: q.want.content, scale: neighbourScale(q.want.scale) }
          : how < 0.75
            ? { content: sibling(q.want.content), scale: q.want.scale }
            : how < 0.9
              ? { content: pick(config.contents.filter((c) => c.kind === q.want!.content.kind)), scale: q.want.scale }
              : how < 0.95
                ? { content: pick(config.contents), scale: below(config.scales.length) }
                : q.want;
      const from = label(q.want);
      ask(q, want);
      return `quad ${q.name} re-asks ${from} -> ${label(want)}`;
    }
    if (roll < 34) {
      if (holding.length === 0) return "nothing to let go";
      const q = pick(holding);
      const was = label(q.want);
      drop(q);
      return `quad ${q.name} lets go of ${was}`;
    }
    if (roll < 56) {
      if (config.outOfMemory === true && roll >= 53) {
        if (roll < 54.5) {
          // Any texture but the 1 px placeholders made at attach.
          devices[devices.length - 1]!.failNextTexture((w, h) => w > 1 || h > 1);
          return "the next allocation will be out of memory";
        }
        const waiting = devices.filter((each) => each.unansweredOutOfMemory() > 0);
        if (waiting.length > 0) {
          const each = pick(waiting);
          each.answerOutOfMemory(below(each.unansweredOutOfMemory()));
          await turn();
          return "an allocation is found out of memory";
        }
      }
      await turn();
      return "a turn of the queue";
    }
    if (roll < 74) {
      if (jobs.length === 0) {
        await turn();
        return "a turn of the queue (no raster in flight)";
      }
      const [job] = jobs.splice(below(jobs.length), 1);
      const ok = !chance(0.06);
      job!(ok);
      await turn();
      return ok ? "a raster lands" : "a raster fails";
    }
    if (roll < 84) {
      // A frame: every held cell with no image is asked for one before submit.
      let asked = 0;
      for (const q of holding) {
        if (!atlas.hasImage(q.cell)) {
          atlas.ensureNow(q.cell);
          asked += 1;
        }
      }
      return `a frame, ${asked} cells asked now`;
    }
    if (roll < 89) {
      // A zoom step: every quad on screen asks for its content at the next scale.
      zoom = neighbourScale(zoom);
      for (const q of holding) ask(q, { content: q.want!.content, scale: zoom });
      return `zoom to ${config.scales[zoom]}, ${holding.length} quads re-ask`;
    }
    if (roll < 94) {
      // Status lines change: several quads swap content inside one box.
      let changed = 0;
      for (const q of holding) {
        if (chance(0.25)) {
          ask(q, { content: sibling(q.want!.content), scale: q.want!.scale });
          changed += 1;
        }
      }
      return `${changed} quads change content in their box`;
    }
    if (roll < 97) {
      // A burst leaves the screen, as a pan does.
      let left = 0;
      for (const q of holding) {
        if (chance(0.4)) {
          drop(q);
          left += 1;
        }
      }
      return `${left} quads leave`;
    }
    if (roll < 99) {
      warm.clear();
      atlas.notifyMemoryPressure?.();
      return "memory pressure, decoded sources dropped";
    }
    if (roll < 99.6) {
      clock += 9000;
      return "nine seconds pass";
    }
    attach();
    for (const q of quads) {
      q.lit = false;
      q.settled = false;
    }
    return "the device is lost and attached anew";
  };

  check();
  for (step = 1; step <= config.steps; step += 1) {
    clock += 40;
    const did = await once();
    trace.push(`${step}: ${did}`);
    check();
  }

  // Everything leaves; nothing may stay referenced, and dispose frees it all.
  step = config.steps + 1;
  for (const q of quads) if (q.cell !== NO_ATLAS_CELL) drop(q);
  while (jobs.length > 0) jobs.pop()!(true);
  for (const each of devices) while (each.unansweredOutOfMemory() > 0) each.answerOutOfMemory(0);
  await turn();
  trace.push(`${step}: every quad leaves, every raster lands`);
  check();
  const stats = atlas.stats();
  if (stats.pinnedCells !== 0) fail("references-left", `${stats.pinnedCells} cells are still referenced after every quad let go`);
  if (stats.pending !== 0) fail("rasters-left", `${stats.pending} rasters are still pending after every quad let go`);
  atlas.dispose();
  const live = devices[devices.length - 1]!.liveTextures();
  if (live !== 0) fail("textures-left", `${live} textures survive dispose`);

  return { steps: config.steps, violations, pages: stats.pages, evictions: stats.evictions, overwrites: stats.overwrites, landed: stats.landed };
};

// --- The scenarios ---------------------------------------------------------------

const scenarios: ReadonlyArray<Config> = [
  {
    // One plot per page and a page per large cell: reclaim on nearly every landing,
    // pages past the bind budget, items too large for a page.
    name: "small pages",
    seed: 1,
    steps: 3000,
    page: 64,
    scales: [0.5, 1, 2],
    quads: 40,
    asyncText: false,
    contents: families([
      { kind: "text", w: 20, h: 11, count: 10 },
      { kind: "text", w: 14, h: 8, count: 6 },
      { kind: "text", w: 70, h: 10, count: 2 },
      { kind: "sprite", w: 16, h: 16, count: 8 },
      { kind: "sprite", w: 12, h: 12, count: 6, cold: true },
      { kind: "sprite", w: 40, h: 40, count: 2 },
      // At scale 1 with the gutter (1 for text, 8 for sprites): the plot's whole width, and a whole plot.
      { kind: "text", w: 63, h: 10, count: 2 },
      { kind: "sprite", w: 56, h: 20, count: 2 },
      { kind: "sprite", w: 56, h: 56, count: 1 },
    ]),
  },
  {
    // The shipped shape in small: 512 px plots, a portrait at the closest zoom
    // takes a plot to itself, strip and full pages, an item past a page.
    name: "plots",
    seed: 2,
    steps: 3000,
    page: 1024,
    scales: [1, 1.41, 2, 2.83, 4, 5.66],
    quads: 60,
    asyncText: false,
    contents: families([
      { kind: "text", w: 80, h: 11, count: 14 },
      { kind: "text", w: 60, h: 9, count: 8 },
      { kind: "sprite", w: 46, h: 46, count: 8, cold: true },
      { kind: "sprite", w: 16, h: 16, count: 10 },
      { kind: "sprite", w: 200, h: 120, count: 2 },
      { kind: "sprite", w: 120, h: 200, count: 2, cold: true },
      // With the gutter: a square plot's width at scale 1, a whole plot at
      // scale 4, a strip's width at scale 1, a full page's width at scale 4.
      { kind: "text", w: 511, h: 9, count: 2 },
      { kind: "sprite", w: 126, h: 126, count: 2 },
      { kind: "text", w: 1023, h: 9, count: 1 },
      { kind: "sprite", w: 254, h: 130, count: 1 },
    ]),
  },
  {
    // One page per pool in the bind group, and a device whose largest texture
    // is one page: later pages bind per cell, large items split into tiles.
    name: "tight budget and tiles",
    seed: 3,
    steps: 3000,
    page: 256,
    limits: { maxTextureDimension2D: 256, maxSampledTexturesPerShaderStage: 2 } as Partial<GPUSupportedLimits>,
    scales: [1, 2, 4],
    quads: 30,
    asyncText: false,
    contents: families([
      { kind: "text", w: 40, h: 10, count: 8 },
      { kind: "text", w: 150, h: 10, count: 3 },
      { kind: "sprite", w: 24, h: 24, count: 8 },
      { kind: "sprite", w: 100, h: 30, count: 3, cold: true },
      { kind: "sprite", w: 30, h: 100, count: 2 },
      // With the gutter: the page's width at scale 1 and at scale 4, and a whole page at scale 4.
      { kind: "text", w: 255, h: 10, count: 2 },
      { kind: "sprite", w: 62, h: 20, count: 2 },
      { kind: "sprite", w: 62, h: 62, count: 1 },
    ]),
  },
  {
    // Queued text rasters off the main thread, as with raster workers.
    name: "text rastered off thread",
    seed: 4,
    steps: 3000,
    page: 128,
    scales: [1, 1.41, 2, 2.83],
    quads: 50,
    asyncText: true,
    contents: families([
      { kind: "text", w: 30, h: 11, count: 16 },
      { kind: "text", w: 22, h: 9, count: 8 },
      { kind: "sprite", w: 20, h: 20, count: 10, cold: true },
      { kind: "sprite", w: 14, h: 14, count: 6 },
      // With the gutter: the plot's width at scale 1 and at scale 2, and a whole plot at scale 2.
      { kind: "text", w: 127, h: 9, count: 2 },
      { kind: "sprite", w: 60, h: 14, count: 2 },
      { kind: "sprite", w: 60, h: 60, count: 1 },
    ]),
  },
  {
    // Pages and textures of their own that the device made out of memory and
    // owns up to some steps later, on this device or on one already replaced.
    name: "allocations that run out of memory",
    seed: 5,
    steps: 3000,
    page: 128,
    scales: [1, 2, 4],
    quads: 40,
    asyncText: false,
    outOfMemory: true,
    contents: families([
      { kind: "text", w: 30, h: 11, count: 10 },
      { kind: "text", w: 20, h: 9, count: 6 },
      { kind: "sprite", w: 20, h: 20, count: 8 },
      { kind: "sprite", w: 14, h: 14, count: 6, cold: true },
      { kind: "sprite", w: 90, h: 40, count: 2 },
      // With the gutter: the plot's width at scale 1 and at scale 4, and a whole plot at scale 4.
      { kind: "text", w: 127, h: 9, count: 2 },
      { kind: "sprite", w: 30, h: 12, count: 2 },
      { kind: "sprite", w: 30, h: 30, count: 1 },
    ]),
  },
];

const seedsPerScenario = Math.max(1, Number(process.env.ATLAS_RANDOM_SEEDS ?? "1") || 1);
const stepsAsked = Number(process.env.ATLAS_RANDOM_STEPS ?? "0") || 0;

describe("gpu atlas under random use", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drains its queue in microtasks here, so a run replays from its seed", () => {
    expect(typeof requestAnimationFrame).toBe("undefined");
  });

  for (const scenario of scenarios) {
    for (let extra = 0; extra < seedsPerScenario; extra += 1) {
      const asShipped = extra === 0 && stepsAsked === 0;
      const config: Config = asShipped ? scenario : { ...scenario, seed: scenario.seed + extra * 1000, steps: stepsAsked || scenario.steps };
      it(`holds every invariant through ${config.steps} random steps: ${config.name}${extra === 0 ? "" : `, seed ${config.seed}`}`, async () => {
        const collect = process.env.ATLAS_RANDOM_COLLECT === "1";
        const outcome = await run(config, collect);
        if (collect) {
          const lines = [...outcome.violations].map(([kind, v]) => `  ${String(v.count).padStart(6)}  ${kind}\n          ${v.first}`);
          console.log(
            `\n"${config.name}" seed ${config.seed}: ${outcome.steps} steps, ${outcome.landed} landed, ${outcome.evictions} evicted, ${outcome.overwrites} written over, ${outcome.pages} pages\n${lines.join("\n")}`,
          );
        }
        expect([...outcome.violations.keys()]).toEqual([]);
        if (!asShipped) return;
        // The run must have pushed the atlas: cells evicted to make room, and
        // content changed inside a box written over the cell it replaced.
        expect(outcome.evictions).toBeGreaterThan(0);
        expect(outcome.overwrites).toBeGreaterThan(0);
        // A run takes about half a millisecond a step; a loaded machine and a long soak get room.
      }, Math.max(30_000, config.steps * 20));
    }
  }
});
