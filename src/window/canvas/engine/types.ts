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
  readonly failures: number;
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
  /** On-screen text/sprite quads drawn with no image in the last frame. */
  readonly visibleBlank: number;
  /** Cumulative on-screen text/sprite quads drawn with no image across all frames. */
  readonly visibleBlankTotal: number;
};
