/**
 * The quad pipeline (docs/canvas-gpu-architecture.md, section 6): one record
 * type, one pipeline, one ordered list, one draw call per band.
 *
 * A record names its style by id. The style table (B, engine/styles.ts) holds
 * every colour, so a theme switch rewrites that one buffer and no record: the
 * vertex and fragment shaders read the table by index, exactly as a DOM
 * element reads its CSS class. Shadows are layers of the style table's shadow
 * specs, drawn from their own small buffer.
 *
 * The vertex shader reads the slot from the order list and the record from the
 * quad buffer, both as read-only storage; the card's own offset, lift and
 * opacity come from the owner buffer, so a drag rewrites one owner entry and
 * no record. Paint order is the order list; translucency composites in that
 * order, so there is no depth buffer.
 *
 * Uploads are the byte ranges that changed: a seat report writes that seat's
 * records, a card move its owner entry, a theme switch the style buffer, a
 * camera frame its uniform and (only when the visible set changed) the order.
 */

import type { Scene } from "./scene";
import { QUAD_BYTES } from "./quad";
import type { AtlasBinding } from "./types";

export type Renderer = ReturnType<typeof createRenderer>;

// WebGPU's usage and visibility flags, by the numbers the spec gives them.
// The TypeScript DOM lib in this tree carries the interfaces but not the
// enum objects, and a fake device in a test must not need the globals.
const BUFFER = { STORAGE: 0x80, COPY_DST: 0x08, UNIFORM: 0x40 } as const;
const TEXTURE = { COPY_DST: 0x02, TEXTURE_BINDING: 0x04 } as const;
const STAGE = { VERTEX: 1, FRAGMENT: 2 } as const;

const STYLE_STRIDE = 24;
const ATLAS_DUMMY_WIDTH = 1;
const SHADOW_LAYER_FLOATS = 8;
const SHADOW_SPEC_WORDS = 4;

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
@group(0) @binding(7) var<storage, read> styles: array<f32>;
@group(0) @binding(8) var<storage, read> shadowMeta: array<vec4u>;
@group(0) @binding(9) var<storage, read> shadowLayers: array<vec4f>;

const PI2 = 6.283185307179586;
const STYLE = ${STYLE_STRIDE}u;

fn phaseOf(period: f32) -> f32 {
  return fract(u.view.w / max(period, 1.0));
}

fn beat(phase: f32) -> f32 {
  if (phase < 0.1875) { return phase / 0.1875; }
  if (phase < 0.375) { return 1.0 - (phase - 0.1875) / 0.1875; }
  if (phase < 0.5) { return (phase - 0.375) / 0.125 * 0.55; }
  if (phase < 0.6875) { return 0.55 * (1.0 - (phase - 0.5) / 0.1875); }
  return 0.0;
}

fn styleColour(base: u32, at: u32) -> vec4f {
  return vec4f(styles[base + at], styles[base + at + 1u], styles[base + at + 2u], styles[base + at + 3u]);
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
  } else if (q.motion == 11u) {
    let age = clamp((u.view.w - q.motionSince) / 720.0, 0.0, 1.0);
    motionScale = 0.82 + 0.18 * age;
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
  let base = q.style * STYLE;

  var fill = styleColour(base, 0u);
  let fillTo = styleColour(base, 4u);
  let angle = styles[base + 8u];
  var stroke = styleColour(base, 9u);
  let strokeWidth = styles[base + 13u];
  let shadowId = i32(styles[base + 17u]);
  var ink = styleColour(base, 18u);
  let styleOpacity = styles[base + 22u];
  if (ink.a <= 0.0) { ink = fill; }
  if (fillTo.a > 0.0) {
    let radians = angle * PI2 / 360.0;
    let dir = vec2f(sin(radians), -cos(radians));
    let t = clamp(dot(in.local, dir) * 0.5 + 0.5, 0.0, 1.0);
    fill = mix(fill, fillTo, t);
  }

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

  // A shadow quad draws the style's shadow layers, each a blurred ring or drop.
  if (q.kind == 1u) {
    if (shadowId < 0) { return vec4f(0.0); }
    let meta = shadowMeta[u32(shadowId)];
    let count = min(meta.x, 32u);
    var outColour = vec3f(0.0);
    var outAlpha = 0.0;
    for (var i = 0u; i < count; i = i + 1u) {
      let layer = shadowLayers[meta.y + i * 2u];
      let tint = shadowLayers[meta.y + i * 2u + 1u];
      let p = abs(in.local * in.half - vec2f(layer.x, layer.y));
      let half = in.half + vec2f(layer.w);
      let r = max(0.0, min(q.radii.x + layer.w, min(half.x, half.y)));
      let corner = p - half + r;
      let d = length(max(corner, vec2f(0.0))) + min(max(corner.x, corner.y), 0.0) - r;
      let blur = max(layer.z, 0.5);
      let soft = clamp(0.5 - d / blur, 0.0, 1.0);
      let a = tint.a * soft * styleOpacity * o.p.w * motionAlpha;
      outColour = outColour + tint.rgb * a * (1.0 - outAlpha);
      outAlpha = outAlpha + a * (1.0 - outAlpha);
    }
    if (outAlpha < 0.002) { return vec4f(0.0); }
    return vec4f(outColour, outAlpha);
  }

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
      let turn = atan2(in.local.y, in.local.x) / PI2 + 0.5;
      var phase = phaseOf(q.motionPeriod);
      if ((q.motionFlags & 1u) != 0u) { phase = 1.0 - phase; }
      let sweep = fract(turn + phase);
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
    inner = clamp(0.5 - (d + max(strokeWidth, 0.0)) * ppu, 0.0, 1.0);
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
      colour = ink.rgb;
      alpha = tex.r * ink.a * outer;
    } else {
      let tint = select(vec4f(1.0), fill, fill.a > 0.0);
      colour = tex.rgb * tint.rgb;
      alpha = tex.a * select(1.0, tint.a, fill.a > 0.0) * outer;
    }
  }

  alpha = alpha * styleOpacity * o.p.w * motionAlpha;
  if (alpha < 0.002) { return vec4f(0.0); }
  let luma = dot(colour, vec3f(0.2126, 0.7152, 0.0722));
  colour = mix(vec3f(luma), colour, clamp(o.q.x, 0.0, 1.0));
  return vec4f(colour * alpha, alpha);
}
`;

type Range = { readonly buffer: string; readonly offset: number; readonly size: number };

type Gpu = {
  readonly device: GPUDevice;
  readonly pipeline: GPURenderPipeline;
  readonly bindLayout: GPUBindGroupLayout;
  readonly atlas?: AtlasBinding;
  quads: GPUBuffer;
  owners: GPUBuffer;
  order: GPUBuffer;
  uniform: GPUBuffer;
  cells: GPUBuffer;
  styles: GPUBuffer;
  shadowMeta: GPUBuffer;
  shadowLayers: GPUBuffer;
  bind: GPUBindGroup;
  quadCapacity: number;
  ownerCapacity: number;
  orderCapacity: number;
  styleCapacity: number;
  shadowMetaCapacity: number;
  shadowLayerCapacity: number;
  styleRevision: number;
  frameRanges: Range[];
  totalBytes: number;
};

const SHADOW_META_CAPACITY = 256;
const SHADOW_LAYER_CAPACITY = 512;

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

  const dummyTexture = (device: GPUDevice): GPUTexture =>
    device.createTexture({
      size: [ATLAS_DUMMY_WIDTH, ATLAS_DUMMY_WIDTH],
      format: "rgba8unorm",
      usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST,
    });

  const makeBindGroup = (state: Omit<Gpu, "bind">): GPUBindGroup => {
    const device = state.device;
    const texture = state.atlas?.texture ?? dummyTexture(device);
    const sampler = state.atlas?.sampler ?? device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
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
        { binding: 7, resource: { buffer: state.styles } },
        { binding: 8, resource: { buffer: state.shadowMeta } },
        { binding: 9, resource: { buffer: state.shadowLayers } },
      ],
    });
  };

  const styleFloats = (scene: Scene): number => Math.max(STYLE_STRIDE, scene.styleCount * STYLE_STRIDE);

  const uploadStyles = (state: Gpu, scene: Scene): void => {
    const floats = styleFloats(scene);
    state.device.queue.writeBuffer(state.styles, 0, scene.styleBuffer, 0, Math.min(scene.styleBuffer.length, floats));
    note(state, "styles", 0, Math.min(scene.styleBuffer.byteLength, floats * 4));
    const shadows = scene.shadowSnapshot();
    const metaBytes = Math.min(shadows.meta.byteLength, SHADOW_META_CAPACITY * SHADOW_SPEC_WORDS * 4);
    state.device.queue.writeBuffer(state.shadowMeta, 0, shadows.meta, 0, Math.max(4, metaBytes));
    note(state, "shadows", 0, metaBytes);
    const layerBytes = Math.min(shadows.layers.byteLength, SHADOW_LAYER_CAPACITY * SHADOW_LAYER_FLOATS * 4);
    state.device.queue.writeBuffer(state.shadowLayers, 0, shadows.layers, 0, Math.max(4, layerBytes));
    note(state, "shadows", 0, layerBytes);
    state.styleRevision = scene.styleRevision;
  };

  const ensure = (state: Gpu, scene: Scene): void => {
    let rebind = false;
    if (scene.quadCapacity > state.quadCapacity) {
      state.quads = bufferOf(state.device, scene.quadCapacity * QUAD_BYTES);
      state.quadCapacity = scene.quadCapacity;
      rebind = true;
    }
    if (scene.ownerCapacity > state.ownerCapacity) {
      state.owners = bufferOf(state.device, scene.ownerCapacity * 8 * 4);
      state.ownerCapacity = scene.ownerCapacity;
      rebind = true;
    }
    if (scene.orderBuffer.length > state.orderCapacity) {
      state.order = bufferOf(state.device, scene.orderBuffer.length * 4);
      state.orderCapacity = scene.orderBuffer.length;
      rebind = true;
    }
    if (scene.styleCount * STYLE_STRIDE > state.styleCapacity) {
      state.styleCapacity = Math.max(STYLE_STRIDE * 16, scene.styleCount * STYLE_STRIDE);
      state.styles = bufferOf(state.device, state.styleCapacity * 4);
      state.styleRevision = -1;
      rebind = true;
    }
    if (rebind) state.bind = makeBindGroup(state);
  };

  const configure = (
    device: GPUDevice,
    format: GPUTextureFormat,
    generation: number,
    scene: Scene,
    atlas?: AtlasBinding,
  ): void => {
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
        { binding: 7, visibility: STAGE.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 8, visibility: STAGE.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 9, visibility: STAGE.FRAGMENT, buffer: { type: "read-only-storage" } },
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
      pipeline,
      bindLayout,
      ...(atlas === undefined ? {} : { atlas }),
      quads: bufferOf(device, Math.max(1, scene.quadCapacity) * QUAD_BYTES),
      owners: bufferOf(device, Math.max(1, scene.ownerCapacity) * 8 * 4),
      order: bufferOf(device, Math.max(1, scene.orderBuffer.length) * 4),
      uniform: device.createBuffer({ size: uniform.byteLength, usage: BUFFER.UNIFORM | BUFFER.COPY_DST }),
      cells: bufferOf(device, 16),
      styles: bufferOf(device, styleFloats(scene) * 4),
      shadowMeta: bufferOf(device, SHADOW_META_CAPACITY * SHADOW_SPEC_WORDS * 4),
      shadowLayers: bufferOf(device, SHADOW_LAYER_CAPACITY * SHADOW_LAYER_FLOATS * 4),
      bind: undefined as unknown as GPUBindGroup,
      quadCapacity: Math.max(1, scene.quadCapacity),
      ownerCapacity: Math.max(1, scene.ownerCapacity),
      orderCapacity: Math.max(1, scene.orderBuffer.length),
      styleCapacity: styleFloats(scene),
      shadowMetaCapacity: SHADOW_META_CAPACITY,
      shadowLayerCapacity: SHADOW_LAYER_CAPACITY,
      styleRevision: -1,
      frameRanges: [],
      totalBytes: gpu?.totalBytes ?? 0,
    };
    next.bind = makeBindGroup(next);
    gpu = next;
    configuredFor = generation;
    device.queue.writeBuffer(next.quads, 0, scene.quadBuffer.bytes, 0, Math.max(4, scene.quadCount * QUAD_BYTES));
    note(next, "quads", 0, scene.quadCount * QUAD_BYTES);
    if (scene.ownerCapacity > 0) {
      device.queue.writeBuffer(next.owners, 0, scene.ownerBuffer, 0, scene.ownerCapacity * 8);
      note(next, "owners", 0, scene.ownerCapacity * 8 * 4);
    }
    scene.takeQuadDirty();
    scene.takeOwnerDirty();
    uploadStyles(next, scene);
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
      const flush = (): void => {
        if (runStart < 0) return;
        state.device.queue.writeBuffer(
          state.quads,
          runStart * QUAD_BYTES,
          scene.quadBuffer.bytes,
          runStart * QUAD_BYTES,
          (runEnd - runStart + 1) * QUAD_BYTES,
        );
        note(state, "quads", runStart * QUAD_BYTES, (runEnd - runStart + 1) * QUAD_BYTES);
        runStart = -1;
        runEnd = -1;
      };
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
        flush();
        runStart = slot;
        runEnd = slot;
      }
      flush();
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
    if (prepared.orderChanged) {
      const bytes = scene.orderCount * 4;
      if (bytes > 0) state.device.queue.writeBuffer(state.order, 0, scene.orderBuffer, 0, bytes);
      note(state, "order", 0, bytes);
    }
    if (state.styleRevision !== scene.styleRevision) uploadStyles(state, scene);
  };

  const writeUniform = (
    scene: Scene,
    frame: {
      readonly width: number;
      readonly height: number;
      readonly pixelRatio: number;
      readonly wallMs: number;
      readonly camera: { readonly x: number; readonly y: number; readonly zoom: number };
      readonly tierBit: number;
      readonly farSeat: number;
      readonly seatFloor: number;
      readonly nodeScale: number;
    },
  ): void => {
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
  let lastBands: BandEnds = [0, 0, 0];

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
      gpu.bind = makeBindGroup({ ...gpu, atlas });
    },
    get configured(): boolean {
      return gpu !== undefined;
    },
    get generation(): number {
      return configuredFor;
    },
    get lastFrameRanges(): ReadonlyArray<Range> {
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
      gpu?.styles.destroy();
      gpu?.shadowMeta.destroy();
      gpu?.shadowLayers.destroy();
      gpu = undefined;
      configuredFor = 0;
    },
  };
};

export type { AtlasBinding };
