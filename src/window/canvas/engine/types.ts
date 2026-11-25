/**
 * The small pieces of browser GPU state the quad pipeline accepts from the
 * shell, so the engine itself touches no global (docs/canvas-gpu-architecture
 * .md, section 4: everything the engine needs from the browser is handed in).
 */

/** Stride of one cell entry in `AtlasBinding.cells`: u0, v0, u1, v1, layer, 0, 0, 0. */
export const ATLAS_CELL_FLOATS = 8;

/** Which cell slots changed since the last renderer upload. */
export type AtlasDirtyCells = {
  readonly all: boolean;
  readonly slots: ReadonlyArray<number>;
};

/** Sampled-texture bind-group budget per atlas pool, derived from device.limits. */
export type AtlasBindBudget = {
  readonly rgba: number;
  readonly coverage: number;
};

/**
 * Split the device's `maxSampledTexturesPerShaderStage` evenly between the
 * RGBA sprite pool and the R8 text-coverage pool so every page of both pools
 * binds in one bind group. Falls back to the WebGPU minimum (16 -> 8 + 8)
 * when device limits are absent.
 */
export const atlasBindBudget = (device?: Pick<GPUDevice, "limits">): AtlasBindBudget => {
  const max = device?.limits?.maxSampledTexturesPerShaderStage;
  const total = typeof max === "number" && max >= 2 ? Math.floor(max) : 16;
  const rgba = Math.max(1, Math.floor(total / 2));
  const coverage = Math.max(1, total - rgba);
  return { rgba, coverage };
};

/** Track B's atlas, once it exists: per-page textures, a sampler, and a UV + page table. */
export type AtlasBinding = {
  readonly texture: GPUTexture;
  /** One-channel r8unorm texture for text coverage (q.kind == 3u), when split from RGBA. */
  readonly coverageTexture?: GPUTexture;
  /** All live RGBA atlas pages, indexed by `cell.page.x` (`0..rgbaPages.length - 1`). */
  readonly rgbaPages?: ReadonlyArray<GPUTexture>;
  /** All live R8 coverage atlas pages, indexed by `cell.page.x` (`0..coveragePages.length - 1`). */
  readonly coveragePages?: ReadonlyArray<GPUTexture>;
  readonly sampler: GPUSampler;
  /** Eight f32 words per cell: u0, v0, u1, v1, pageOrLayer, tilesX, tilesY, 0. */
  readonly cells: Float32Array;
  /** Number of allocated cell slots, for upload and buffer growth. */
  readonly cellCount?: number;
  /** Bumped whenever any bound page texture list changes so the renderer rebinds. */
  readonly textureGeneration?: number;
  /** Dedicated full-resolution textures ONLY for items larger than a page (or past bind budget). */
  readonly standalone?: ReadonlyMap<number, GPUTexture>;
  /** Take and clear cell indices whose UV/layer entry changed since the last upload. */
  readonly takeDirtyCells?: () => AtlasDirtyCells;
};

/** Observable atlas counters for diagnostics and the test hook. */
export type AtlasStats = {
  readonly requests: number;
  readonly pending: number;
  readonly landed: number;
  readonly evictions: number;
  /** Landings written over the cell their slot showed, when nothing else held it: a changed status line takes no new rect. */
  readonly overwrites: number;
  /** Failures reported so far, a running total. `failedCells` is the slots failed now. */
  readonly failures: number;
  /**
   * Slots failed now: no pixels of their own and no raster on the way, each
   * waiting for the retry timer. Their quads draw the last pixels they had,
   * or nothing. 0 when every held cell has what it asked for.
   */
  readonly failedCells: number;
  readonly pages: number;
  readonly pageSize: number;
  readonly bytesInUse: number;
  readonly activeCells: number;
  readonly pinnedCells: number;
  /** Live standalone/overflow texture entries currently bound outside the main page bind group. */
  readonly standaloneCount: number;
  /** Estimated bytes held by the decoded SVG + media source cache. */
  readonly decodedSourceBytes: number;
  /** Number of decoded SVG sources currently cached. */
  readonly decodedSvgCount: number;
  /** Always 0: no cell is kept past eviction as a floor. The field stays so proof files keep their shape. */
  readonly floorBytes: number;
  /** Always 0, as `floorBytes`. */
  readonly floorCells: number;
  /** Always 0: a placed cell is never moved. The field stays so proof files keep their shape. */
  readonly compactions: number;
  /** Cumulative count of previously-seen content keys that drew without an image (rule 6). */
  readonly lostPixels: number;
  /** On-screen text/sprite quads drawn with no image in the last frame. */
  readonly visibleBlank: number;
  /** Cumulative on-screen text/sprite quads drawn with no image across all frames. */
  readonly visibleBlankTotal: number;
};

/** Bounded diagnostic snapshot of one queued or in-flight atlas cell. */
export type AtlasPendingEntry = {
  readonly key: string;
  readonly kind: "text" | "sprite";
  readonly state: "queued" | "rasterizing";
  readonly scale: number;
  readonly width: number;
  readonly height: number;
  readonly sourceRef: string | null;
  readonly attempts: number;
};

/** One broken cell-table invariant, as `GpuAtlas.audit` found it. */
export type AtlasAuditViolation = {
  readonly kind: string;
  readonly cell: number;
  readonly key: string | null;
  readonly detail: string;
};

/** The atlas's read-only invariant check: counts by kind and the first violations. */
export type AtlasAudit = {
  readonly checked: number;
  readonly heldCells: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly samples: ReadonlyArray<AtlasAuditViolation>;
};

/** One landed cell whose texels differ from a fresh raster of its own quad, or one fixed texel or gutter that is not what the atlas contract keeps it. */
export type AtlasTexelMismatch = {
  readonly kind: "texels" | "box" | "gutter" | "reserved-texel";
  readonly cell: number;
  readonly key: string;
  readonly meanDiff: number;
  readonly badFraction: number;
  readonly detail: string;
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

/**
 * The atlas's texel readback check over referenced, landed cells.
 *
 * `skipped` counts only cells a quad can draw now that the audit did not
 * compare; a proof gate treats every one as a failure. `undrawn` counts the
 * cells no quad can draw now, by why, and is information only. `truncated` is
 * true when the audit stopped at its limit with comparable cells left.
 */
export type AtlasTexelAudit = {
  readonly checked: number;
  readonly truncated: boolean;
  readonly skipped: Readonly<Record<string, number>>;
  readonly undrawn: Readonly<Record<string, number>>;
  readonly mismatches: ReadonlyArray<AtlasTexelMismatch>;
  readonly worst: number;
};
