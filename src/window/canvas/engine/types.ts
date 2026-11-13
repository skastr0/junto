/**
 * The small pieces of browser GPU state the quad pipeline accepts from the
 * shell, so the engine itself touches no global (docs/canvas-gpu-architecture
 * .md, section 4: everything the engine needs from the browser is handed in).
 */

/** Track B's atlas, once it exists: one texture, a sampler, and a UV rect per cell. */
export type AtlasBinding = {
  readonly texture: GPUTexture;
  readonly sampler: GPUSampler;
  /** One vec4f per cell: u0, v0, u1, v1. */
  readonly cells: Float32Array;
};
