/**
 * The wire layer's GPU half: the shader module, four pipelines, and the
 * buffers the scene's pools and records fill. It uploads the byte ranges that
 * changed and encodes two draws between the engine's bands: wires (a glow pass
 * under the hairlines) before the cards, tracks and pulses after them.
 *
 * Everything is created from the device it is given, and again when the
 * device changes (loss) or a pool grows, from the scene's own arrays: the
 * scene never holds a GPU object.
 */

import { DERIVE_BACK, DERIVE_TIP, TRACK_ARM, TRACK_SPREAD, TRACK_WIDTH } from "../../paint/wires";
import { STRIP_ATTRIBUTES, STRIP_STRIDE } from "../../paint/wires";
import type { StripPool } from "./pool";
import { RECORD_BYTES, type WireScene } from "./scene";
import { WIRE_SHADER } from "./shader";

/** A derives arrowhead's own stroke, in marks at fit 1 (flow-track.ts `trackTile`: `0.6 * fit`). */
const DERIVE_STROKE = 0.6;

const UNIFORM_FLOATS = 20;

export type UploadRange = { readonly buffer: string; readonly offset: number; readonly size: number };

type PoolBuffers = {
  readonly vertex: GPUBuffer;
  readonly index: GPUBuffer;
  readonly generation: number;
};

type Resources = {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  readonly layout: GPUBindGroupLayout;
  readonly wire: GPURenderPipeline;
  readonly glow: GPURenderPipeline;
  readonly track: GPURenderPipeline;
  readonly pulse: GPURenderPipeline;
  readonly uniform: GPUBuffer;
  records: GPUBuffer;
  recordsGeneration: number;
  bind: GPUBindGroup;
  main: PoolBuffers;
  glowBuffers: PoolBuffers;
  trackBuffers: PoolBuffers;
};

export type WireGpu = {
  readonly upload: (device: GPUDevice, format: GPUTextureFormat) => void;
  readonly encodeRest: (pass: GPURenderPassEncoder) => void;
  readonly encodeTracks: (pass: GPURenderPassEncoder) => void;
  /** The ranges written by the last `upload`, for the engine's counters. */
  readonly lastUploads: () => ReadonlyArray<UploadRange>;
  readonly dispose: () => void;
};

/** WebGPU's buffer-usage and shader-stage flags, by the numbers the spec gives them. */
const BUFFER = { VERTEX: 0x20, INDEX: 0x10, STORAGE: 0x80, UNIFORM: 0x40, COPY_DST: 0x08 } as const;
const STAGE = { VERTEX: 1, FRAGMENT: 2 } as const;

const BLEND: GPUBlendState = {
  color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
};

const VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: STRIP_STRIDE,
  stepMode: "vertex",
  attributes: [
    { shaderLocation: 0, offset: STRIP_ATTRIBUTES.pos.offset, format: STRIP_ATTRIBUTES.pos.format },
    { shaderLocation: 1, offset: STRIP_ATTRIBUTES.extrude.offset, format: STRIP_ATTRIBUTES.extrude.format },
    { shaderLocation: 2, offset: STRIP_ATTRIBUTES.along.offset, format: STRIP_ATTRIBUTES.along.format },
    { shaderLocation: 3, offset: STRIP_ATTRIBUTES.across.offset, format: STRIP_ATTRIBUTES.across.format },
    { shaderLocation: 4, offset: STRIP_ATTRIBUTES.slot.offset, format: STRIP_ATTRIBUTES.slot.format },
  ],
};

/** A buffer is never empty (a zero size is a validation error). */
const sized = (bytes: number): number => Math.max(16, Math.ceil(bytes / 4) * 4);

export const createWireGpu = (scene: WireScene): WireGpu => {
  let res: Resources | undefined;
  let uploads: UploadRange[] = [];
  const uniformData = new Float32Array(UNIFORM_FLOATS);

  const makePool = (device: GPUDevice, pool: StripPool, label: string): PoolBuffers => {
    const vertex = device.createBuffer({
      label: `wires ${label} vertices`,
      size: sized(pool.vertices().byteLength),
      usage: BUFFER.VERTEX | BUFFER.COPY_DST,
    });
    const index = device.createBuffer({
      label: `wires ${label} indices`,
      size: sized(pool.indices().byteLength),
      usage: BUFFER.INDEX | BUFFER.COPY_DST,
    });
    pool.dirtyVertices.markAll(pool.vertices().length);
    pool.dirtyIndices.markAll(pool.indices().length);
    return { vertex, index, generation: pool.generation() };
  };

  const makeRecords = (device: GPUDevice): GPUBuffer =>
    device.createBuffer({
      label: "wires records",
      size: sized(scene.records().byteLength),
      usage: BUFFER.STORAGE | BUFFER.COPY_DST,
    });

  const makeBind = (device: GPUDevice, layout: GPUBindGroupLayout, uniform: GPUBuffer, records: GPUBuffer): GPUBindGroup =>
    device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: records } },
      ],
    });

  const create = (device: GPUDevice, format: GPUTextureFormat): Resources => {
    const module = device.createShaderModule({ label: "wires", code: WIRE_SHADER });
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: STAGE.VERTEX | STAGE.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: STAGE.VERTEX | STAGE.FRAGMENT, buffer: { type: "read-only-storage" } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pipeline = (vertex: string, fragment: string, indexed: boolean): GPURenderPipeline =>
      device.createRenderPipeline({
        label: `wires ${fragment}`,
        layout: pipelineLayout,
        vertex: { module, entryPoint: vertex, buffers: [VERTEX_LAYOUT] },
        fragment: { module, entryPoint: fragment, targets: [{ format, blend: BLEND }] },
        primitive: indexed
          ? { topology: "triangle-strip", stripIndexFormat: "uint32", cullMode: "none" }
          : { topology: "triangle-strip", cullMode: "none" },
      });
    const uniform = device.createBuffer({
      label: "wires uniforms",
      size: UNIFORM_FLOATS * 4,
      usage: BUFFER.UNIFORM | BUFFER.COPY_DST,
    });
    const records = makeRecords(device);
    scene.dirtyRecords.markAll(scene.records().length);
    return {
      device,
      format,
      layout,
      wire: pipeline("vs_wire", "fs_wire", true),
      glow: pipeline("vs_glow", "fs_glow", true),
      track: pipeline("vs_track", "fs_track", true),
      pulse: pipeline("vs_pulse", "fs_pulse", false),
      uniform,
      records,
      recordsGeneration: scene.recordsGeneration(),
      bind: makeBind(device, layout, uniform, records),
      main: makePool(device, scene.pool, "strips"),
      glowBuffers: makePool(device, scene.glowPool, "glow"),
      trackBuffers: makePool(device, scene.trackPool, "tracks"),
    };
  };

  const destroy = (r: Resources | undefined): void => {
    if (r === undefined) return;
    for (const buffer of [r.uniform, r.records, r.main.vertex, r.main.index, r.glowBuffers.vertex, r.glowBuffers.index, r.trackBuffers.vertex, r.trackBuffers.index]) {
      buffer.destroy();
    }
  };

  const syncPool = (device: GPUDevice, pool: StripPool, buffers: PoolBuffers, label: string, set: (next: PoolBuffers) => void): PoolBuffers => {
    let held = buffers;
    if (pool.generation() !== held.generation) {
      held.vertex.destroy();
      held.index.destroy();
      held = makePool(device, pool, label);
      set(held);
    }
    const v = pool.dirtyVertices.take();
    if (v !== undefined) {
      device.queue.writeBuffer(held.vertex, v.start * 4, pool.vertices(), v.start, v.end - v.start);
      uploads.push({ buffer: `${label} vertices`, offset: v.start * 4, size: (v.end - v.start) * 4 });
    }
    const i = pool.dirtyIndices.take();
    if (i !== undefined) {
      device.queue.writeBuffer(held.index, i.start * 4, pool.indices(), i.start, i.end - i.start);
      uploads.push({ buffer: `${label} indices`, offset: i.start * 4, size: (i.end - i.start) * 4 });
    }
    return held;
  };

  const upload: WireGpu["upload"] = (device, format) => {
    uploads = [];
    if (res === undefined || res.device !== device || res.format !== format) {
      destroy(res);
      res = create(device, format);
    }
    const r = res;
    // Records first: a grown array is a new buffer, and the bind group follows it.
    if (r.recordsGeneration !== scene.recordsGeneration()) {
      r.records.destroy();
      r.records = makeRecords(device);
      r.recordsGeneration = scene.recordsGeneration();
      r.bind = makeBind(device, r.layout, r.uniform, r.records);
      scene.dirtyRecords.markAll(scene.records().length);
    }
    const span = scene.dirtyRecords.take();
    if (span !== undefined) {
      device.queue.writeBuffer(r.records, span.start * 4, scene.records(), span.start, span.end - span.start);
      uploads.push({ buffer: "records", offset: span.start * 4, size: (span.end - span.start) * 4 });
    }
    r.main = syncPool(device, scene.pool, r.main, "strips", (next) => (r.main = next));
    r.glowBuffers = syncPool(device, scene.glowPool, r.glowBuffers, "glow", (next) => (r.glowBuffers = next));
    r.trackBuffers = syncPool(device, scene.trackPool, r.trackBuffers, "tracks", (next) => (r.trackBuffers = next));

    const u = scene.uniforms();
    uniformData.set(u.camera, 0);
    uniformData.set(u.view, 4);
    uniformData.set(u.track, 8);
    uniformData[12] = TRACK_ARM;
    uniformData[13] = TRACK_SPREAD;
    uniformData[14] = DERIVE_BACK;
    uniformData[15] = DERIVE_TIP;
    uniformData[16] = TRACK_WIDTH;
    uniformData[17] = DERIVE_STROKE;
    device.queue.writeBuffer(r.uniform, 0, uniformData);
  };

  const drawIndexed = (pass: GPURenderPassEncoder, pipeline: GPURenderPipeline, buffers: PoolBuffers, extent: number): void => {
    if (res === undefined || extent <= 0) return;
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, res.bind);
    pass.setVertexBuffer(0, buffers.vertex);
    pass.setIndexBuffer(buffers.index, "uint32");
    pass.drawIndexed(extent);
  };

  const encodeRest: WireGpu["encodeRest"] = (pass) => {
    if (res === undefined) return;
    // The soft pass goes under the hairlines.
    drawIndexed(pass, res.glow, res.glowBuffers, scene.glowPool.extent());
    drawIndexed(pass, res.wire, res.main, scene.pool.extent());
  };

  const encodeTracks: WireGpu["encodeTracks"] = (pass) => {
    if (res === undefined) return;
    drawIndexed(pass, res.track, res.trackBuffers, scene.trackPool.extent());
    const pulses = scene.pulses();
    if (pulses.length === 0) return;
    pass.setPipeline(res.pulse);
    pass.setBindGroup(0, res.bind);
    pass.setVertexBuffer(0, res.main.vertex);
    for (const pulse of pulses) pass.draw(pulse.count, 1, pulse.start);
  };

  return {
    upload,
    encodeRest,
    encodeTracks,
    lastUploads: () => uploads,
    dispose: () => {
      destroy(res);
      res = undefined;
    },
  };
};

export { RECORD_BYTES };
