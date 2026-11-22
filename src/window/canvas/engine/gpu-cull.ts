/**
 * GPU culling (#912): a compute pass culls the scene's candidate list by
 * tier and by view, per quad, into a compacted list in the same order, and
 * writes each band's drawIndirect arguments. The draw then reads the
 * compacted list instead of the CPU's.
 *
 * Painter's order is the draw order, so the compaction keeps it: a flag and
 * an in-block exclusive scan per candidate, a scan of the block sums, then a
 * scatter (a standard three-pass stream compaction). Placement is the
 * vertex stage's own `placeQuad`, so a quad is kept exactly when the vertex
 * stage would put any of it on screen; motion is bounded by the vertex
 * stage's largest growth and shift, and any turn by the half-diagonal.
 *
 * Atlas residency is not decided here: it still comes from the CPU's
 * visible set, which also builds the candidates.
 */

import { PLACE_QUAD, QUAD_STRUCTS } from "./quad-wgsl";

const BUFFER = { STORAGE: 0x80, COPY_DST: 0x08, UNIFORM: 0x40, INDIRECT: 0x100 } as const;
const STAGE_COMPUTE = 4;
/** Threads per workgroup, and candidates per scan block. */
const BLOCK = 256;
/** Bands the draw splits into (wires interleave between them). */
const BANDS = 3;
/** drawIndirect's four words: vertexCount, instanceCount, firstVertex, firstInstance. */
const ARGS_WORDS = 4;

/** The vertex stage's largest motion growth (motion 2, the send pulse) and shift (motion 13, the rise). */
const MOTION_GROWTH = 1.31;
const MOTION_SHIFT = 3.0;

const CULL_SHADER = /* wgsl */ `
${QUAD_STRUCTS}

struct Params {
  count: u32,
  groupsX: u32,
  pad0: u32,
  pad1: u32,
  bandEnds: vec4u,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> candidates: array<u32>;
@group(0) @binding(2) var<storage, read> quads: array<Quad>;
@group(0) @binding(3) var<storage, read> owners: array<Owner>;
@group(0) @binding(4) var<storage, read_write> local: array<u32>;
@group(0) @binding(5) var<storage, read_write> blocks: array<u32>;
@group(0) @binding(6) var<storage, read_write> culled: array<u32>;
@group(0) @binding(7) var<storage, read_write> args: array<u32>;
@group(0) @binding(8) var<uniform> params: Params;

${PLACE_QUAD}

const BLOCK = ${String(BLOCK)}u;
const FLAG = 0x80000000u;

var<workgroup> sums: array<u32, ${String(BLOCK)}>;

fn visible(slot: u32) -> bool {
  let q = quads[slot];
  let tierBit = u32(u.camera.w);
  if ((q.tiers & tierBit) == 0u) { return false; }
  let o = owners[q.owner];
  let placed = placeQuad(q, o, tierBit);
  let half = length(q.rect.zw * placed.z) * 0.5 * ${MOTION_GROWTH.toFixed(2)} + ${MOTION_SHIFT.toFixed(1)};
  let centre = (placed.xy - vec2f(0.0, o.p.z)) * u.camera.z + u.camera.xy;
  let r = half * u.camera.z;
  return centre.x + r >= 0.0 && centre.x - r <= u.view.x && centre.y + r >= 0.0 && centre.y - r <= u.view.y;
}

fn scanSums(lid: u32) {
  for (var off = 1u; off < BLOCK; off = off * 2u) {
    var v = 0u;
    if (lid >= off) { v = sums[lid - off]; }
    workgroupBarrier();
    sums[lid] = sums[lid] + v;
    workgroupBarrier();
  }
}

@compute @workgroup_size(${String(BLOCK)}) fn flagScan(
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
) {
  let block = wid.x + wid.y * params.groupsX;
  let i = block * BLOCK + lid.x;
  var flag = 0u;
  if (i < params.count) { flag = select(0u, 1u, visible(candidates[i])); }
  sums[lid.x] = flag;
  workgroupBarrier();
  scanSums(lid.x);
  if (i < params.count) { local[i] = (sums[lid.x] - flag) | (flag * FLAG); }
  // A 2D grid can carry spare groups past the last block: they write nothing.
  if (lid.x == BLOCK - 1u && block * BLOCK < params.count) { blocks[block] = sums[lid.x]; }
}

@compute @workgroup_size(${String(BLOCK)}) fn scanBlocks(@builtin(local_invocation_id) lid: vec3u) {
  let nb = (params.count + BLOCK - 1u) / BLOCK;
  let per = (nb + BLOCK - 1u) / BLOCK;
  let first = lid.x * per;
  var total = 0u;
  for (var k = 0u; k < per; k = k + 1u) {
    let b = first + k;
    if (b < nb) { total = total + blocks[b]; }
  }
  sums[lid.x] = total;
  workgroupBarrier();
  scanSums(lid.x);
  var run = sums[lid.x] - total;
  for (var k = 0u; k < per; k = k + 1u) {
    let b = first + k;
    if (b < nb) {
      let v = blocks[b];
      blocks[b] = run;
      run = run + v;
    }
  }
  if (lid.x == BLOCK - 1u) { blocks[nb] = sums[lid.x]; }
}

fn exclusive(i: u32) -> u32 {
  if (i >= params.count) { return blocks[(params.count + BLOCK - 1u) / BLOCK]; }
  return blocks[i / BLOCK] + (local[i] & ~FLAG);
}

@compute @workgroup_size(${String(BLOCK)}) fn scatter(
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(workgroup_id) wid: vec3u,
) {
  let block = wid.x + wid.y * params.groupsX;
  let i = block * BLOCK + lid.x;
  if (i < params.count && (local[i] & FLAG) != 0u && block * BLOCK < params.count) {
    culled[blocks[block] + (local[i] & ~FLAG)] = candidates[i];
  }
  if (i == 0u) {
    var start = 0u;
    for (var b = 0u; b < ${String(BANDS)}u; b = b + 1u) {
      let lo = exclusive(start);
      let hi = exclusive(params.bandEnds[b]);
      args[b * 4u] = 4u;
      args[b * 4u + 1u] = hi - lo;
      args[b * 4u + 2u] = 0u;
      args[b * 4u + 3u] = lo;
      start = params.bandEnds[b];
    }
  }
}
`;

export const GPU_CULL_SHADER = CULL_SHADER;

export type GpuCull = {
  /**
   * Encode the cull over `count` candidates in the renderer's order buffer,
   * bands ending at `bandEnds`. Returns the compacted list to bind as the
   * draw's order, or undefined when the device could not give the buffers.
   */
  readonly encode: (
    encoder: GPUCommandEncoder,
    inputs: {
      readonly uniform: GPUBuffer;
      readonly candidates: GPUBuffer;
      readonly quads: GPUBuffer;
      readonly owners: GPUBuffer;
      readonly count: number;
      readonly bandEnds: readonly [number, number, number];
      /** The pass's timestamp writes, asked only when the pass is encoded. */
      readonly timestampWrites?: () => GPUComputePassTimestampWrites | undefined;
    },
  ) => GPUBuffer | undefined;
  /** The indirect arguments buffer: band b's draw at offset b * 16. */
  readonly args: GPUBuffer;
  readonly destroy: () => void;
};

export const createGpuCull = (device: GPUDevice): GpuCull => {
  const module = device.createShaderModule({ code: CULL_SHADER });
  const entries: GPUBindGroupLayoutEntry[] = [
    { binding: 0, visibility: STAGE_COMPUTE, buffer: { type: "uniform" } },
    { binding: 1, visibility: STAGE_COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: STAGE_COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 3, visibility: STAGE_COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 4, visibility: STAGE_COMPUTE, buffer: { type: "storage" } },
    { binding: 5, visibility: STAGE_COMPUTE, buffer: { type: "storage" } },
    { binding: 6, visibility: STAGE_COMPUTE, buffer: { type: "storage" } },
    { binding: 7, visibility: STAGE_COMPUTE, buffer: { type: "storage" } },
    { binding: 8, visibility: STAGE_COMPUTE, buffer: { type: "uniform" } },
  ];
  const layout = device.createBindGroupLayout({ entries });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const pipeline = (entryPoint: string): GPUComputePipeline =>
    device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint } });
  const flagScan = pipeline("flagScan");
  const scanBlocks = pipeline("scanBlocks");
  const scatter = pipeline("scatter");
  const args = device.createBuffer({ size: BANDS * ARGS_WORDS * 4, usage: BUFFER.STORAGE | BUFFER.INDIRECT | BUFFER.COPY_DST });
  const params = device.createBuffer({ size: 32, usage: BUFFER.UNIFORM | BUFFER.COPY_DST });
  const paramWords = new Uint32Array(8);
  const maxGroups = Math.max(1, device.limits?.maxComputeWorkgroupsPerDimension ?? 65535);

  let capacity = 0;
  let local: GPUBuffer | undefined;
  let blocks: GPUBuffer | undefined;
  let culled: GPUBuffer | undefined;
  let bind: GPUBindGroup | undefined;
  let bound: { uniform?: GPUBuffer; candidates?: GPUBuffer; quads?: GPUBuffer; owners?: GPUBuffer } = {};

  const ensure = (count: number): boolean => {
    if (count <= capacity && local !== undefined) return true;
    let next = Math.max(BLOCK, capacity);
    while (next < count) next *= 2;
    const blockCount = Math.ceil(next / BLOCK) + 1;
    local?.destroy();
    blocks?.destroy();
    culled?.destroy();
    local = device.createBuffer({ size: next * 4, usage: BUFFER.STORAGE });
    blocks = device.createBuffer({ size: blockCount * 4, usage: BUFFER.STORAGE });
    culled = device.createBuffer({ size: next * 4, usage: BUFFER.STORAGE });
    capacity = next;
    bind = undefined;
    return true;
  };

  return {
    args,
    encode: (encoder, inputs) => {
      const count = Math.max(1, inputs.count);
      if (!ensure(count)) return undefined;
      if (
        bind === undefined ||
        bound.uniform !== inputs.uniform ||
        bound.candidates !== inputs.candidates ||
        bound.quads !== inputs.quads ||
        bound.owners !== inputs.owners
      ) {
        bind = device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: { buffer: inputs.uniform } },
            { binding: 1, resource: { buffer: inputs.candidates } },
            { binding: 2, resource: { buffer: inputs.quads } },
            { binding: 3, resource: { buffer: inputs.owners } },
            { binding: 4, resource: { buffer: local! } },
            { binding: 5, resource: { buffer: blocks! } },
            { binding: 6, resource: { buffer: culled! } },
            { binding: 7, resource: { buffer: args } },
            { binding: 8, resource: { buffer: params } },
          ],
        });
        bound = { uniform: inputs.uniform, candidates: inputs.candidates, quads: inputs.quads, owners: inputs.owners };
      }
      const groups = Math.ceil(inputs.count / BLOCK);
      const groupsX = Math.min(Math.max(1, groups), maxGroups);
      const groupsY = Math.max(1, Math.ceil(groups / groupsX));
      paramWords[0] = inputs.count;
      paramWords[1] = groupsX;
      paramWords[4] = inputs.bandEnds[0];
      paramWords[5] = inputs.bandEnds[1];
      paramWords[6] = inputs.bandEnds[2];
      device.queue.writeBuffer(params, 0, paramWords);
      const timestampWrites = inputs.timestampWrites?.();
      const pass = encoder.beginComputePass(timestampWrites === undefined ? undefined : { timestampWrites });
      pass.setBindGroup(0, bind);
      if (inputs.count > 0) {
        pass.setPipeline(flagScan);
        pass.dispatchWorkgroups(groupsX, groupsY);
      }
      pass.setPipeline(scanBlocks);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(scatter);
      pass.dispatchWorkgroups(groupsX, groupsY);
      pass.end();
      return culled;
    },
    destroy: () => {
      local?.destroy();
      blocks?.destroy();
      culled?.destroy();
      args.destroy();
      params.destroy();
    },
  };
};
