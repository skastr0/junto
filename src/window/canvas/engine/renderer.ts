/**
 * The quad pipeline (docs/canvas-gpu-architecture.md, section 6): one record
 * type, one pipeline, one ordered list, one draw call per band.
 *
 * The vertex shader reads the slot from the order list and the record from the
 * quad buffer, both as read-only storage; the card's own offset, lift and
 * opacity come from the owner buffer, so a drag rewrites one owner entry and
 * no record. The fragment shader draws rounded rectangles (per-corner radii),
 * discs, the seat ring with its sweep, blurred shadows, gradients and (once
 * track B binds an atlas) sprite and text cells. Paint order is the order
 * list; translucency composites in that order, so there is no depth buffer.
 *
 * Uploads are the byte ranges that changed: a seat report writes that seat's
 * records, a card move its owner entry, a camera frame its uniform and (only
 * when the visible set changed) the order list.
 */

import type { AtlasBinding } from "./types";
import type { Scene } from "./scene";
import { QUAD_BYTES, QUAD_FLOATS } from "./quad";

export type Renderer = ReturnType<typeof createRenderer>;

// WebGPU's usage and visibility flags, by the numbers the spec gives them.
// The TypeScript DOM lib in this tree carries the interfaces but not the
// enum objects, and a fake device in a test must not need the globals.
const BUFFER = { STORAGE: 0x80, COPY_DST: 0x08, UNIFORM: 0x40 } as const;
const TEXTURE = { COPY_DST: 0x02, TEXTURE_BINDING: 0x04 } as const;
const STAGE = { VERTEX: 1, FRAGMENT: 2 } as const;

const ATLAS_DUMMY_WIDTH = 1;

const SHADER = /* wgsl */ `
struct Uniforms {
  view: vec4f,    // width, height, pixelRatio, wallMs
  camera: vec4f,  // x, y, zoom, tier bit
  scales: vec4f,  // farSeat, seatFloor, nodeScale, seconds
  misc: vec4f,
};

struct Owner {
  p: vec4f, // x, y, lift, opacity
  q: vec4f, // saturate, pad, pad, pad
};

struct Quad {
  rect: vec4f,
  radii: vec4f,
  fill: u32,
  fillTo: u32,
  stroke: u32,
  strokeWidth: f32,
  opacity: f32,
  shape: u32,
  kind: u32,
  owner: u32,
  tiers: u32,
  scaleRule: u32,
  scaleCap: f32,
  motion: u32,
  motionPeriod: f32,
  motionSince: f32,
  motionFlags: u32,
  source: u32,
  gradientAngle: f32,
  anchorX: f32,
  anchorY: f32,
  style: u32,
  previousStyle: u32,
  changeAt: f32,
  dash: u32,
  reserved: u32,
};

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) half: vec2f,
  @location(2) @interpolate(flat) slot: u32,
  @location(3) corner: vec2f,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> order: array<u32>;
@group(0) @binding(2) var<storage, read> quads: array<Quad>;
@group(0) @binding(3) var<storage, read> owners: array<Owner>;
@group(0) @binding(4) var atlas: texture_2d<f32>;
@group(0) @binding(5) var atlasSampler: sampler;
@group(0) @binding(6) var<storage, read> cells: array<vec4f>;

const PI2 = 6.283185307179586;

fn unpackRgba(word: u32) -> vec4f {
  return unpack4x8unorm(word);
}

fn phaseOf(period: f32) -> f32 {
  return fract(u.view.w / max(period, 1.0));
}

fn beat(phase: f32) -> f32 {
  // opacity 0, 1, 0, .55, 0 at 0, 18.75, 37.5, 50, 68.75%
  if (phase < 0.1875) { return phase / 0.1875; }
  if (phase < 0.375) { return 1.0 - (phase - 0.1875) / 0.1875; }
  if (phase < 0.5) { return (phase - 0.375) / 0.125 * 0.55; }
  if (phase < 0.6875) { return 0.55 * (1.0 - (phase - 0.5) / 0.1875); }
  return 0.0;
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  var out: VSOut;
  let slot = order[ii];
  let q = quads[slot];
  let o = owners[q.owner];
  let corner = vec2f(f32(vi & 1u), f32(vi >> 1u));
  let local = corner * 2.0 - 1.0;

  let tierBit = u32(u.camera.w);
  let tierOn = (q.tiers & tierBit) != 0u;

  var scale = 1.0;
  var center = o.p.xy + q.rect.xy + q.rect.zw * 0.5;
  if (q.scaleRule == 1u) {
    let far = max(1.0, min(u.scales.x, q.scaleCap));
    let floorScale = max(u.scales.y, min(u.scales.x, q.scaleCap));
    scale = select(far, floorScale, tierBit == 8u);
    center = o.p.xy + vec2f(q.anchorX, q.anchorY);
  } else if (q.scaleRule == 2u) {
    scale = u.scales.z;
    center = o.p.xy + vec2f(q.anchorX, q.anchorY);
  }

  var motionScale = 1.0;
  if (q.motion == 2u || q.motion == 7u) {
    motionScale = 1.0 + select(0.31, 0.22, q.motion == 7u) * phaseOf(q.motionPeriod);
  } else if (q.motion == 10u) {
    let wave = 0.5 - 0.5 * cos(phaseOf(q.motionPeriod) * PI2);
    motionScale = 1.0 + 0.015 * wave;
  } else if (q.motion == 11u || q.motion == 12u) {
    let age = clamp((u.view.w - q.motionSince) / 720.0, 0.0, 1.0);
    if (q.motion == 11u) { motionScale = 0.82 + 0.18 * age; }
  } else if (q.motion == 13u) {
    let age = clamp((u.view.w - q.motionSince) / 200.0, 0.0, 1.0);
    center = center + vec2f(0.0, 3.0 * (1.0 - age));
  }

  let size = q.rect.zw * scale * motionScale;
  let radii = q.radii * scale * motionScale;
  let world = center + local * size * 0.5 - vec2f(0.0, o.p.z);
  let screen = (world - u.camera.xy) * u.camera.z;
  let clip = vec2f(screen.x / u.view.x * 2.0 - 1.0, 1.0 - screen.y / u.view.y * 2.0);
  out.pos = select(vec4f(2.0, 2.0, 2.0, 1.0), vec4f(clip, 0.0, 1.0), tierOn);
  out.local = local;
  out.half = size * 0.5;
  out.slot = slot;
  out.corner = corner;
  return out;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let q = quads[in.slot];
  let o = owners[q.owner];
  let ppu = u.camera.z * u.view.z;
  var motionAlpha = 1.0;

  if (q.motion == 3u) { motionAlpha = beat(phaseOf(q.motionPeriod)); }
  else if (q.motion == 4u) { motionAlpha = 0.5 - 0.5 * cos(phaseOf(q.motionPeriod) * PI2); }
  else if (q.motion == 5u) { motionAlpha = 0.25 + 0.75 * (0.5 - 0.5 * cos(phaseOf(q.motionPeriod) * PI2)); }
  else if (q.motion == 6u) { motionAlpha = select(1.0, 0.1, phaseOf(q.motionPeriod) >= 0.5); }
  else if (q.motion == 7u) { motionAlpha = 1.0 - phaseOf(q.motionPeriod); }
  else if (q.motion == 8u) {
    let phase = phaseOf(q.motionPeriod);
    motionAlpha = select(select(0.0, 0.9, phase >= 0.3), 0.0, phase >= 0.6);
  } else if (q.motion == 11u || q.motion == 12u) {
    let age = u.view.w - q.motionSince;
    if (q.motion == 11u) { motionAlpha = select(0.0, clamp(age / 720.0, 0.0, 1.0), age >= 0.0); }
    else { motionAlpha = select(0.0, 1.0, age >= 720.0); }
  } else if (q.motion == 13u) {
    motionAlpha = clamp((u.view.w - q.motionSince) / 200.0, 0.0, 1.0);
  }

  var fill = unpackRgba(q.fill);
  let fillTo = unpackRgba(q.fillTo);
  if (fillTo.a > 0.0) {
    let angle = radians(q.gradientAngle);
    let dir = vec2f(sin(angle), -cos(angle));
    let t = clamp(dot(in.local, dir) * 0.5 + 0.5, 0.0, 1.0);
    fill = mix(fill, fillTo, t);
  }
  var stroke = unpackRgba(q.stroke);

  var outer = 0.0;
  var inner = 0.0;
  var ringBand = 0.0;

  if (q.shape == 1u) {
    let dist = length(in.local * in.half);
    let r = min(in.half.x, in.half.y);
    outer = clamp(0.5 - (dist - r) * ppu, 0.0, 1.0);
    if (q.motion == 1u) {
      let ring = clamp(0.5 - (dist - r * 0.82) * ppu, 0.0, 1.0);
      ringBand = max(0.0, outer - ring);
      let angle = atan2(in.local.y, in.local.x) / PI2 + 0.5;
      var phase = phaseOf(q.motionPeriod);
      if ((q.motionFlags & 1u) != 0u) { phase = 1.0 - phase; }
      let sweep = fract(angle + phase);
      var sweepAlpha = 0.22 + 0.78 * sweep * sweep;
      if ((q.motionFlags & 2u) != 0u) {
        sweepAlpha = sweepAlpha * (0.5 - 0.5 * cos(phase * PI2));
      }
      motionAlpha = motionAlpha * sweepAlpha;
      inner = 0.0;
    } else {
      inner = outer;
    }
  } else {
    let p = abs(in.local * in.half);
    let right = select(q.radii.x, q.radii.y, in.local.x > 0.0);
    let left = select(q.radii.w, q.radii.z, in.local.x > 0.0);
    let rr = select(right, left, in.local.y > 0.0);
    let corner = p - in.half + rr;
    let d = length(max(corner, vec2f(0.0))) + min(max(corner.x, corner.y), 0.0) - rr;
    outer = clamp(0.5 - d * ppu, 0.0, 1.0);
    if (q.kind == 1u) {
      // A blurred shadow: soft outside the rectangle, full inside.
      let blur = max(q.strokeWidth, 1.0);
      let soft = clamp(1.0 - max(d, 0.0) / blur, 0.0, 1.0);
      let alpha = fill.a * soft * 0.35 * q.opacity * o.p.w * motionAlpha;
      return vec4f(fill.rgb * alpha, alpha);
    }
    inner = clamp(0.5 - (d + max(q.strokeWidth, 0.0)) * ppu, 0.0, 1.0);
  }

  var colour = vec3f(0.0);
  var alpha = 0.0;
  if (ringBand > 0.0) {
    colour = fill.rgb;
    alpha = fill.a * ringBand;
  } else {
    colour = fill.rgb * inner + stroke.rgb * max(0.0, outer - inner);
    alpha = fill.a * inner + stroke.a * max(0.0, outer - inner);
  }

  if (q.kind >= 2u && q.source != 0xffffffffu) {
    let cell = cells[q.source];
    let uv = mix(cell.xy, cell.zw, in.corner);
    let tex = textureSample(atlas, atlasSampler, uv);
    if (q.kind == 3u) {
      // Text: the atlas is coverage; the style's ink colours it.
      colour = fill.rgb;
      alpha = tex.r * fill.a;
    } else {
      colour = tex.rgb * fill.rgb;
      alpha = tex.a * fill.a;
    }
  }

  alpha = alpha * q.opacity * o.p.w * motionAlpha;
  if (alpha < 0.002) { return vec4f(0.0); }
  let luma = dot(colour, vec3f(0.2126, 0.7152, 0.0722));
  colour = mix(vec3f(luma), colour, clamp(o.q.x, 0.0, 1.0));
  return vec4f(colour * alpha, alpha);
}
`;

type Gpu = {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  readonly pipeline: GPURenderPipeline;
  readonly bindLayout: GPUBindGroupLayout;
  quads: GPUBuffer;
  owners: GPUBuffer;
  order: GPUBuffer;
  uniform: GPUBuffer;
  cells: GPUBuffer;
  bind: GPUBindGroup;
  quadCapacity: number;
  ownerCapacity: number;
  orderCapacity: number;
  frameRanges: Array<{ buffer: string; offset: number; size: number }>;
  totalBytes: number;
};

export const createRenderer = () => {
  let gpu: Gpu | undefined;
  let configuredFor = 0;
  const uniform = new Float32Array(16);

  const note = (state: Gpu, buffer: string, offset: number, size: number): void => {
    if (size <= 0) return;
    state.totalBytes += size;
    state.frameRanges.push({ buffer, offset, size });
  };

  const bufferOf = (device: GPUDevice, size: number): GPUBuffer =>
    device.createBuffer({
      size: Math.max(4, Math.ceil(size / 4) * 4),
      usage: BUFFER.STORAGE | BUFFER.COPY_DST,
    });

  const uploadAll = (state: Gpu, scene: Scene): void => {
    const device = state.device;
    device.queue.writeBuffer(state.quads, 0, scene.quadBuffer.bytes, 0, Math.max(4, scene.quadCount * QUAD_BYTES));
    note(state, "quads", 0, scene.quadCount * QUAD_BYTES);
    if (scene.ownerCapacity > 0) {
      device.queue.writeBuffer(state.owners, 0, scene.ownerBuffer, 0, scene.ownerCapacity * 8);
      note(state, "owners", 0, scene.ownerCapacity * 8 * 4);
    }
    scene.takeQuadDirty();
    scene.takeOwnerDirty();
  };

  const makeBindGroup = (state: Omit<Gpu, "bind">, atlas: AtlasBinding | undefined): GPUBindGroup => {
    const device = state.device;
    const texture = atlas?.texture ?? dummyTexture(device);
    const sampler = atlas?.sampler ?? device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
    return device.createBindGroup({
      layout: state.bindLayout,
      entries: [
        { binding: 0, resource: { buffer: state.uniform } },
        { binding: 1, resource: { buffer: state.order } },
        { binding: 2, resource: { buffer: state.quads } },
        { binding: 3, resource: { buffer: state.owners } },
        { binding: 4, resource: texture.createView() },
        { binding: 5, resource: sampler },
        { binding: 6, resource: { buffer: state.cells } },
      ],
    });
  };

  const dummyTexture = (device: GPUDevice): GPUTexture =>
    device.createTexture({ size: [ATLAS_DUMMY_WIDTH, ATLAS_DUMMY_WIDTH], format: "rgba8unorm", usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST });

  const ensure = (state: Gpu, scene: Scene): void => {
    if (scene.quadCapacity > state.quadCapacity) {
      state.quads = bufferOf(state.device, scene.quadCapacity * QUAD_BYTES);
      state.quadCapacity = scene.quadCapacity;
      state.bind = makeBindGroup(state, undefined);
    }
    if (scene.ownerCapacity > state.ownerCapacity) {
      state.owners = bufferOf(state.device, scene.ownerCapacity * 8 * 4);
      state.ownerCapacity = scene.ownerCapacity;
      state.bind = makeBindGroup(state, undefined);
    }
    if (scene.orderBuffer.length > state.orderCapacity) {
      state.order = bufferOf(state.device, scene.orderBuffer.length * 4);
      state.orderCapacity = scene.orderBuffer.length;
      state.bind = makeBindGroup(state, undefined);
    }
  };

  const configure = (device: GPUDevice, format: GPUTextureFormat, generation: number, scene: Scene, atlas?: AtlasBinding): void => {
    if (gpu !== undefined && configuredFor === generation) return;
    const module = device.createShaderModule({ code: SHADER });
    const bindLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: STAGE.VERTEX | STAGE.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: STAGE.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: STAGE.VERTEX | STAGE.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: STAGE.VERTEX | STAGE.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: STAGE.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 5, visibility: STAGE.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 6, visibility: STAGE.FRAGMENT, buffer: { type: "read-only-storage" } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bindLayout] });
    const pipeline = device.createRenderPipeline({
      layout,
      vertex: { module, entryPoint: "vs" },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-strip" },
    });
    const next: Gpu = {
      device,
      format,
      pipeline,
      bindLayout,
      quads: bufferOf(device, scene.quadCapacity * QUAD_BYTES),
      owners: bufferOf(device, scene.ownerCapacity * 8 * 4),
      order: bufferOf(device, scene.orderBuffer.length * 4),
      uniform: device.createBuffer({ size: uniform.byteLength, usage: BUFFER.UNIFORM | BUFFER.COPY_DST }),
      cells: bufferOf(device, 16),
      bind: undefined as unknown as GPUBindGroup,
      quadCapacity: scene.quadCapacity,
      ownerCapacity: scene.ownerCapacity,
      orderCapacity: scene.orderBuffer.length,
      frameRanges: [],
      totalBytes: gpu?.totalBytes ?? 0,
    };
    next.bind = makeBindGroup(next, atlas);
    gpu = next;
    configuredFor = generation;
    uploadAll(next, scene);
  };

  const upload = (scene: Scene, prepared: { readonly orderChanged: boolean }): void => {
    const state = gpu;
    if (state === undefined) return;
    ensure(state, scene);
    const quadDirty = scene.takeQuadDirty();
    if (quadDirty.all) {
      state.device.queue.writeBuffer(state.quads, 0, scene.quadBuffer.bytes, 0, Math.max(4, scene.quadCount * QUAD_BYTES));
      note(state, "quads", 0, scene.quadCount * QUAD_BYTES);
    } else {
      let runStart = -1;
      let runEnd = -1;
      for (const slot of quadDirty.slots) {
        if (runStart < 0) {
          runStart = slot;
          runEnd = slot;
          continue;
        }
        if (slot === runEnd + 1) {
          runEnd = slot;
          continue;
        }
        state.device.queue.writeBuffer(
          state.quads,
          runStart * QUAD_BYTES,
          scene.quadBuffer.bytes,
          runStart * QUAD_BYTES,
          (runEnd - runStart + 1) * QUAD_BYTES,
        );
        note(state, "quads", runStart * QUAD_BYTES, (runEnd - runStart + 1) * QUAD_BYTES);
        runStart = slot;
        runEnd = slot;
      }
      if (runStart >= 0) {
        state.device.queue.writeBuffer(
          state.quads,
          runStart * QUAD_BYTES,
          scene.quadBuffer.bytes,
          runStart * QUAD_BYTES,
          (runEnd - runStart + 1) * QUAD_BYTES,
        );
        note(state, "quads", runStart * QUAD_BYTES, (runEnd - runStart + 1) * QUAD_BYTES);
      }
    }
    const ownerDirty = scene.takeOwnerDirty();
    if (ownerDirty.all) {
      state.device.queue.writeBuffer(state.owners, 0, scene.ownerBuffer, 0, scene.ownerCapacity * 8);
      note(state, "owners", 0, scene.ownerCapacity * 8 * 4);
    } else {
      for (const slot of ownerDirty.slots) {
        state.device.queue.writeBuffer(state.owners, slot * 32, scene.ownerBuffer, slot * 8, 8);
        note(state, "owners", slot * 32, 32);
      }
    }
    if (prepared.orderChanged || state.orderCapacity === 0) {
      const bytes = scene.orderCount * 4;
      if (bytes > 0) state.device.queue.writeBuffer(state.order, 0, scene.orderBuffer, 0, bytes);
      note(state, "order", 0, bytes);
    }
  };

  const writeUniform = (scene: Scene, frame: {
    readonly width: number;
    readonly height: number;
    readonly pixelRatio: number;
    readonly wallMs: number;
    readonly camera: { readonly x: number; readonly y: number; readonly zoom: number };
    readonly tierBit: number;
    readonly farSeat: number;
    readonly seatFloor: number;
    readonly nodeScale: number;
  }): void => {
    const state = gpu;
    if (state === undefined) return;
    uniform[0] = frame.width;
    uniform[1] = frame.height;
    uniform[2] = frame.pixelRatio;
    uniform[3] = frame.wallMs;
    uniform[4] = frame.camera.x;
    uniform[5] = frame.camera.y;
    uniform[6] = frame.camera.zoom;
    uniform[7] = frame.tierBit;
    uniform[8] = frame.farSeat;
    uniform[9] = frame.seatFloor;
    uniform[10] = frame.nodeScale;
    uniform[11] = 0;
    uniform[12] = scene.orderCount;
    uniform[13] = 0;
    uniform[14] = 0;
    uniform[15] = 0;
    state.device.queue.writeBuffer(state.uniform, 0, uniform);
    note(state, "uniform", 0, uniform.byteLength);
  };

  type BandEnds = readonly [number, number, number];

  /** Encode one band's draw; the engine calls this between the wire passes. */
  const encode = (pass: GPURenderPassEncoder, band: 0 | 1 | 2): void => {
    const state = gpu;
    if (state === undefined) return;
    const first = band === 0 ? 0 : lastBands[band - 1]!;
    const count = lastBands[band]! - first;
    if (count <= 0) return;
    pass.setPipeline(state.pipeline);
    pass.setBindGroup(0, state.bind);
    pass.draw(4, count, 0, first);
  };

  let lastBands: BandEnds = [0, 0, 0];

  const beginFrame = (bands: BandEnds): void => {
    if (gpu !== undefined) gpu.frameRanges = [];
    lastBands = [bands[0], bands[1], bands[2]];
  };

  return {
    configure,
    upload,
    writeUniform,
    encode,
    beginFrame,
    attachAtlas: (atlas: AtlasBinding): void => {
      if (gpu === undefined) return;
      gpu.bind = makeBindGroup(gpu, atlas);
    },
    get configured(): boolean {
      return gpu !== undefined;
    },
    get generation(): number {
      return configuredFor;
    },
    get lastFrameRanges(): ReadonlyArray<{ buffer: string; offset: number; size: number }> {
      return gpu?.frameRanges ?? [];
    },
    get totalBytes(): number {
      return gpu?.totalBytes ?? 0;
    },
    reset(): void {
      gpu?.quads.destroy();
      gpu?.owners.destroy();
      gpu?.order.destroy();
      gpu?.uniform.destroy();
      gpu?.cells.destroy();
      gpu = undefined;
      configuredFor = 0;
    },
  };
};

export type { AtlasBinding };
export { QUAD_FLOATS };
