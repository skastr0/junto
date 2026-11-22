/**
 * The small pieces of browser GPU state the quad pipeline accepts from the
 * shell, so the engine itself touches no global (docs/canvas-gpu-architecture
 * .md, section 4: everything the engine needs from the browser is handed in).
 */

/** Stride of one cell entry in `AtlasBinding.cells`: u0, v0, u1, v1, layer, 0, 0, 0. */
export const ATLAS_CELL_FLOATS = 8;

/** Track B's atlas, once it exists: a 2d-array texture, a sampler, and a UV + layer table. */
export type AtlasBinding = {
  readonly texture: GPUTexture;
  readonly sampler: GPUSampler;
  /** Eight f32 words per cell: u0, v0, u1, v1, layer, 0, 0, 0. */
  readonly cells: Float32Array;
  /** Number of allocated cell slots, for upload and buffer growth. */
  readonly cellCount?: number;
  /** Bumped whenever `texture` is recreated (device attach or page growth) so the renderer rebinds. */
  readonly textureGeneration?: number;
  /** Dedicated full-resolution textures for cells larger than a packing page, keyed by cell index. */
  readonly standalone?: ReadonlyMap<number, GPUTexture>;
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
  /** On-screen text/sprite quads drawn with no image in the last frame. */
  readonly visibleBlank: number;
  /** Cumulative on-screen text/sprite quads drawn with no image across all frames. */
  readonly visibleBlankTotal: number;
};
