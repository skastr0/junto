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
  readonly generation: number;
};

type VisibleBuffers = {
  readonly main: GPUBuffer;
  readonly glow: GPUBuffer;
  readonly tracks: GPUBuffer;
  revision: number;
  mainCount: number;
  glowCount: number;
  tracksCount: number;
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
  /** The lens's camera (item 13 of issue 915): the same strips, drawn through a second uniform. */
  readonly lensUniform: GPUBuffer;
  records: GPUBuffer;
  recordsGeneration: number;
  bind: GPUBindGroup;
  lensBind: GPUBindGroup;
  main: PoolBuffers;
  glowBuffers: PoolBuffers;
  trackBuffers: PoolBuffers;
  visible: VisibleBuffers;
};

export type WireGpu = {
  readonly upload: (device: GPUDevice, format: GPUTextureFormat) => void;
  readonly encodeRest: (pass: GPURenderPassEncoder) => void;
  readonly encodeTracks: (pass: GPURenderPassEncoder) => void;
  /** Write the lens's camera and viewport into its uniform, after `upload`. */
  readonly uploadLens: (lens: WireLensFrame) => void;
  /** The same draws as encodeRest and encodeTracks, through the lens's camera. */
  readonly encodeLensRest: (pass: GPURenderPassEncoder) => void;
  readonly encodeLensTracks: (pass: GPURenderPassEncoder) => void;
  /** The ranges written by the last `upload`, for the engine's counters. */
  readonly lastUploads: () => ReadonlyArray<UploadRange>;
  /** Bytes the last upload wrote. */
  readonly lastBytes: () => number;
  /** Draw calls the last encoded frame issued. */
  readonly draws: () => number;
  /** Index count the last encoded frame's visible draw covered. */
  readonly indices: () => number;
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

/** The lens's camera and viewport, in its own CSS pixels. */
export type WireLensFrame = {
  readonly camera: { readonly x: number; readonly y: number; readonly zoom: number };
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
};

/** A buffer is never empty (a zero size is a validation error). */
const sized = (bytes: number): number => Math.max(16, Math.ceil(bytes / 4) * 4);

export const createWireGpu = (scene: WireScene): WireGpu => {
  let res: Resources | undefined;
  let uploads: UploadRange[] = [];
  let bytes = 0;
  let drawCalls = 0;
  const uniformData = new Float32Array(UNIFORM_FLOATS);

  const makePool = (device: GPUDevice, pool: StripPool, label: string): PoolBuffers => {
    const vertex = device.createBuffer({
      label: `wires ${label} vertices`,
      size: sized(pool.vertices().byteLength),
      usage: BUFFER.VERTEX | BUFFER.COPY_DST,
    });
    pool.dirtyVertices.markAll(pool.vertices().length);
    return { vertex, generation: pool.generation() };
  };

  /** The visible strips' index buffers: what the frame draws, nothing else. */
  const makeVisible = (device: GPUDevice): VisibleBuffers => {
    const v = scene.visibleIndices();
    const index = (label: string, array: Uint32Array): GPUBuffer =>
      device.createBuffer({ label: `wires ${label} visible indices`, size: sized(array.byteLength), usage: BUFFER.INDEX | BUFFER.COPY_DST });
    return {
      main: index("strips", v.main),
      glow: index("glow", v.glow),
      tracks: index("tracks", v.tracks),
      revision: -1,
      mainCount: 0,
      glowCount: 0,
      tracksCount: 0,
    };
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
    const lensUniform = device.createBuffer({
      label: "wires lens uniforms",
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
      lensUniform,
      records,
      recordsGeneration: scene.recordsGeneration(),
      bind: makeBind(device, layout, uniform, records),
      lensBind: makeBind(device, layout, lensUniform, records),
      main: makePool(device, scene.pool, "strips"),
      glowBuffers: makePool(device, scene.glowPool, "glow"),
      trackBuffers: makePool(device, scene.trackPool, "tracks"),
      visible: makeVisible(device),
    };
  };

  const destroy = (r: Resources | undefined): void => {
    if (r === undefined) return;
    for (const buffer of [
      r.uniform,
      r.lensUniform,
      r.records,
      r.main.vertex,
      r.glowBuffers.vertex,
      r.trackBuffers.vertex,
      r.visible.main,
      r.visible.glow,
      r.visible.tracks,
    ]) {
      buffer.destroy();
    }
  };

  const syncPool = (device: GPUDevice, pool: StripPool, buffers: PoolBuffers, label: string, set: (next: PoolBuffers) => void): PoolBuffers => {
    let held = buffers;
    if (pool.generation() !== held.generation) {
      held.vertex.destroy();
      held = makePool(device, pool, label);
      set(held);
    }
    for (const run of pool.dirtyVertices.take()) {
      device.queue.writeBuffer(held.vertex, run.start * 4, pool.vertices(), run.start, run.end - run.start);
      uploads.push({ buffer: `${label} vertices`, offset: run.start * 4, size: (run.end - run.start) * 4 });
    }
    // The pool's own index array is not what the frame draws (only visible
    // strips are); taking the runs keeps the dirty list from growing.
    pool.dirtyIndices.take();
    return held;
  };

  const upload: WireGpu["upload"] = (device, format) => {
    uploads = [];
    bytes = 0;
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
      r.lensBind = makeBind(device, r.layout, r.lensUniform, r.records);
      scene.dirtyRecords.markAll(scene.records().length);
    }
    for (const run of scene.dirtyRecords.take()) {
      device.queue.writeBuffer(r.records, run.start * 4, scene.records(), run.start, run.end - run.start);
      uploads.push({ buffer: "records", offset: run.start * 4, size: (run.end - run.start) * 4 });
    }
    r.main = syncPool(device, scene.pool, r.main, "strips", (next) => (r.main = next));
    r.glowBuffers = syncPool(device, scene.glowPool, r.glowBuffers, "glow", (next) => (r.glowBuffers = next));
    r.trackBuffers = syncPool(device, scene.trackPool, r.trackBuffers, "tracks", (next) => (r.trackBuffers = next));

    // The visible draw: one upload when the camera (or a strip) moved, sized
    // by the strips in view, never by the pool's high-water mark.
    const v = scene.visibleIndices();
    if (r.visible.revision !== v.revision) {
      const fit = (buffer: GPUBuffer, array: Uint32Array): GPUBuffer => {
        if (buffer.size >= array.byteLength) return buffer;
        buffer.destroy();
        return device.createBuffer({ label: "wires visible indices", size: sized(array.byteLength), usage: BUFFER.INDEX | BUFFER.COPY_DST });
      };
      r.visible = {
        ...r.visible,
        main: fit(r.visible.main, v.main),
        glow: fit(r.visible.glow, v.glow),
        tracks: fit(r.visible.tracks, v.tracks),
        revision: v.revision,
        mainCount: v.mainCount,
        glowCount: v.glowCount,
        tracksCount: v.tracksCount,
      };
      const put = (buffer: GPUBuffer, array: Uint32Array, count: number, label: string): void => {
        if (count === 0) return;
        device.queue.writeBuffer(buffer, 0, array, 0, count);
        uploads.push({ buffer: `visible ${label}`, offset: 0, size: count * 4 });
      };
      put(r.visible.main, v.main, v.mainCount, "strips");
      put(r.visible.glow, v.glow, v.glowCount, "glow");
      put(r.visible.tracks, v.tracks, v.tracksCount, "tracks");
    }

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
    for (const range of uploads) bytes += range.size;
  };

  const lensData = new Float32Array(UNIFORM_FLOATS);
  const uploadLens: WireGpu["uploadLens"] = (lens) => {
    if (res === undefined) return;
    // The main uniform as written this frame, with the lens's camera and viewport.
    lensData.set(uniformData);
    lensData[0] = lens.camera.x;
    lensData[1] = lens.camera.y;
    lensData[2] = lens.camera.zoom;
    lensData[3] = lens.pixelRatio;
    lensData[4] = lens.width;
    lensData[5] = lens.height;
    res.device.queue.writeBuffer(res.lensUniform, 0, lensData);
  };

  const drawIndexed = (pass: GPURenderPassEncoder, pipeline: GPURenderPipeline, vertex: GPUBuffer, index: GPUBuffer, count: number, bind?: GPUBindGroup): void => {
    if (res === undefined || count <= 0) return;
    drawCalls += 1;
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind ?? res.bind);
    pass.setVertexBuffer(0, vertex);
    pass.setIndexBuffer(index, "uint32");
    pass.drawIndexed(count);
  };

  const encodeRest: WireGpu["encodeRest"] = (pass) => {
    drawCalls = 0;
    if (res === undefined) return;
    // The soft pass goes under the hairlines.
    drawIndexed(pass, res.glow, res.glowBuffers.vertex, res.visible.glow, res.visible.glowCount);
    drawIndexed(pass, res.wire, res.main.vertex, res.visible.main, res.visible.mainCount);
  };

  const encodeLensRest: WireGpu["encodeLensRest"] = (pass) => {
    if (res === undefined) return;
    drawIndexed(pass, res.glow, res.glowBuffers.vertex, res.visible.glow, res.visible.glowCount, res.lensBind);
    drawIndexed(pass, res.wire, res.main.vertex, res.visible.main, res.visible.mainCount, res.lensBind);
  };

  const encodeTracks = (pass: GPURenderPassEncoder, bind?: GPUBindGroup): void => {
    if (res === undefined) return;
    drawIndexed(pass, res.track, res.trackBuffers.vertex, res.visible.tracks, res.visible.tracksCount, bind);
    const pulses = scene.pulses();
    if (pulses.length === 0) return;
    pass.setPipeline(res.pulse);
    pass.setBindGroup(0, bind ?? res.bind);
    pass.setVertexBuffer(0, res.main.vertex);
    for (const pulse of pulses) {
      drawCalls += 1;
      pass.draw(pulse.count, 1, pulse.start);
    }
  };

  return {
    upload,
    encodeRest,
    encodeTracks: (pass) => encodeTracks(pass),
    uploadLens,
    encodeLensRest,
    encodeLensTracks: (pass) => {
      if (res !== undefined) encodeTracks(pass, res.lensBind);
    },
    lastUploads: () => uploads,
    lastBytes: () => bytes,
    draws: () => drawCalls,
    indices: () =>
      res === undefined ? 0 : res.visible.mainCount + res.visible.glowCount + res.visible.tracksCount,
    dispose: () => {
      destroy(res);
      res = undefined;
    },
  };
};

export { RECORD_BYTES };
