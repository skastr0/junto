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

import type { Prepared, Scene } from "./scene";
import { QUAD_BYTES } from "./quad";
import { DURATION } from "@shared/theme";
import { STYLE_STRIDE } from "./styles";
import type { AtlasBinding } from "./types";

export type Renderer = ReturnType<typeof createRenderer>;

// WebGPU's usage and visibility flags, by the numbers the spec gives them.
// The TypeScript DOM lib in this tree carries the interfaces but not the
// enum objects, and a fake device in a test must not need the globals.
const BUFFER = { STORAGE: 0x80, COPY_DST: 0x08, UNIFORM: 0x40 } as const;
const TEXTURE = { COPY_DST: 0x02, TEXTURE_BINDING: 0x04 } as const;
const STAGE = { VERTEX: 1, FRAGMENT: 2 } as const;

const ATLAS_DUMMY_WIDTH = 1;
const SHADOW_LAYER_FLOATS = 8;
const SHADOW_SPEC_WORDS = 4;

const SHADER = /* wgsl */ `
const TRANSITION_MS = ${DURATION.state.toFixed(1)};

struct Uniforms {
  view: vec4f,    // width, height, pixelRatio, wallMs
  camera: vec4f,  // x, y, zoom, tier bit
  scales: vec4f,  // farSeat, seatFloor, nodeScale, seconds
  misc: vec4f,
};

struct Owner {
  p: vec4f, // x, y, lift, opacity
  q: vec4f, // saturate, card width, card height, content-centre dx
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
  hole: f32,
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

// A motion's phase is anchored to its record: the scene stores
// now - (wall % period) at paint, so the shader advances from the same
// DOM wall clock (f32 cannot hold Date.now() itself).
fn phaseOfQuad(q: Quad) -> f32 {
  return fract((u.view.w - q.motionSince) / max(q.motionPeriod, 1.0));
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

fn filled(base: u32, local: vec2f) -> vec4f {
  let stopA = styleColour(base, 0u);
  let stopB = styleColour(base, 4u);
  if (stopB.a <= 0.0) { return stopA; }
  let theta = styles[base + 8u] * PI2 / 360.0;
  let dir = vec2f(sin(theta), -cos(theta));
  let t = clamp(dot(local, dir) * 0.5 + 0.5, 0.0, 1.0);
  return mix(stopA, stopB, t);
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
    // 1 at near and mid; the far ring's scale at far; its floor at overview.
    let far = max(1.0, min(u.scales.x, q.scaleCap));
    let floorScale = max(u.scales.y, min(u.scales.x, q.scaleCap));
    var seatScale = 1.0;
    if (tierBit == 4u) {
      seatScale = far;
    } else if (tierBit == 8u) {
      seatScale = floorScale;
    }
    // The quad's own centre, and the point it is placed about: its anchor at
    // near and mid, the card box's centre at far and overview (the DOM
    // re-lays a seat out there, the ring centred on the box). Its offset from
    // that point scales with the ring, so a crest (or a cluster's count) rides
    // the grown ring instead of pinning to its middle.
    let anchor = vec2f(q.anchorX, q.anchorY);
    let relCentre = vec2f(q.rect.x + q.rect.z * 0.5, q.rect.y + q.rect.w * 0.5);
    var base = anchor;
    if (tierBit == 4u || tierBit == 8u) {
      // A seat's ring is centred on its content box, not the card: the sheet
      // pads the seat 1px 10px 1px 1px. o.q.w carries that half-difference;
      // a cluster badge owns its box and carries 0.
      base = vec2f(o.q.y * 0.5 + o.q.w, o.q.z * 0.5);
    }
    scale = seatScale;
    center = o.p.xy + base + (relCentre - anchor) * seatScale;
  } else if (q.scaleRule == 2u) {
    // A node-scale quad grows about its anchor: a note's tick keeps its
    // top-left on the card and a label's far text keeps its left centre, as
    // the DOM lays them out; only the size is held at --node-s. Placing the
    // centre on the anchor instead put the tick half outside the card and
    // flung the label's huge far text across its neighbour.
    let anchor = vec2f(q.anchorX, q.anchorY);
    let relCentre = vec2f(q.rect.x + q.rect.z * 0.5, q.rect.y + q.rect.w * 0.5);
    scale = u.scales.z;
    center = o.p.xy + anchor + (relCentre - anchor) * scale;
  } else if (q.scaleRule == 3u) {
    // The far name tag: its offset from the ring centre scales with the seat,
    // the tag itself by farSeat * 1.4 about its top centre.
    let far = max(1.0, min(u.scales.x, q.scaleCap));
    let floorScale = max(u.scales.y, min(u.scales.x, q.scaleCap));
    var seatScale = 1.0;
    if (tierBit == 4u) {
      seatScale = far;
    } else if (tierBit == 8u) {
      seatScale = floorScale;
    }
    let anchor = vec2f(q.anchorX, q.anchorY);
    var base = anchor;
    if (tierBit == 4u || tierBit == 8u) {
      base = vec2f(o.q.y * 0.5 + o.q.w, o.q.z * 0.5);
    }
    let relTop = vec2f(q.rect.x + q.rect.z * 0.5, q.rect.y);
    let top = base + (relTop - anchor) * seatScale;
    scale = u.scales.x * 1.4;
    center = o.p.xy + top + vec2f(0.0, q.rect.w * scale * 0.5);
  }

  var motionScale = 1.0;
  if (q.motion == 2u || q.motion == 7u) {
    motionScale = 1.0 + select(0.31, 0.22, q.motion == 7u) * phaseOfQuad(q);
  } else if (q.motion == 10u) {
    let wave = 0.5 - 0.5 * cos(phaseOfQuad(q) * PI2);
    motionScale = 1.0 + 0.015 * wave;
  } else if (q.motion == 11u) {
    let age = clamp((u.view.w - q.motionSince) / 720.0, 0.0, 1.0);
    motionScale = 0.82 + 0.18 * age;
  } else if (q.motion == 13u) {
    let age = clamp((u.view.w - q.motionSince) / 200.0, 0.0, 1.0);
    center = center + vec2f(0.0, 3.0 * (1.0 - age));
  } else if (q.motion == 9u) {
    // The shake: 0, -1, 1 board units across the lap, then back to rest.
    let phase = phaseOfQuad(q);
    var dx = 0.0;
    if (phase < 0.25) { dx = -4.0 * phase; } else if (phase < 0.75) { dx = -1.0 + 4.0 * (phase - 0.25); } else { dx = 1.0 - 4.0 * (phase - 0.75); }
    center = vec2f(center.x + dx, center.y);
  }

  let size = q.rect.zw * scale * motionScale;
  let radii = q.radii * scale * motionScale;
  var offset = local * size * 0.5;
  if (q.motion == 1u) {
    // A turning part turns about its centre, exactly as the DOM's part does
    // (transform: rotate, origin 50% 50%). A ring's spin cell is a sprite
    // quad, not a disc, so it has to turn here: before this it drew at zero
    // degrees on every frame and every moving ring stood still.
    var turn = phaseOfQuad(q);
    if ((q.motionFlags & 1u) != 0u) { turn = 1.0 - turn; }
    let angle = turn * PI2;
    let turnCos = cos(angle);
    let turnSin = sin(angle);
    // y grows down the screen, so this is clockwise, the CSS direction.
    offset = vec2f(offset.x * turnCos - offset.y * turnSin, offset.x * turnSin + offset.y * turnCos);
  }
  let world = center + offset - vec2f(0.0, o.p.z);
  let screen = world * u.camera.z + u.camera.xy;
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
  let strokeWidth = styles[base + 13u];
  let shadowId = i32(styles[base + 17u]);

  var fill = filled(base, in.local);
  var stroke = styleColour(base, 9u);
  var ink = styleColour(base, 18u);
  var styleOpacity = styles[base + 22u];
  if (q.previousStyle != q.style && q.previousStyle != 0xffffffffu) {
    let previousBase = q.previousStyle * STYLE;
    let t = smoothstep(0.0, 1.0, clamp((u.view.w - q.changeAt) / TRANSITION_MS, 0.0, 1.0));
    fill = mix(filled(previousBase, in.local), fill, t);
    stroke = mix(styleColour(previousBase, 9u), stroke, t);
    ink = mix(styleColour(previousBase, 18u), ink, t);
    styleOpacity = mix(styles[previousBase + 22u], styleOpacity, t);
  }
  if (ink.a <= 0.0) { ink = fill; }

  var motionAlpha = 1.0;
  if (q.motion == 1u) {
    // A turning part with the fade flag breathes once a lap (glint), as the
    // DOM's second animation on the same part does.
    if ((q.motionFlags & 2u) != 0u) { motionAlpha = 0.5 - 0.5 * cos(phaseOfQuad(q) * PI2); }
  } else if (q.motion == 3u) { motionAlpha = beat(phaseOfQuad(q)); }
  else if (q.motion == 4u) { motionAlpha = 0.5 - 0.5 * cos(phaseOfQuad(q) * PI2); }
  else if (q.motion == 5u) { motionAlpha = 0.25 + 0.75 * (0.5 - 0.5 * cos(phaseOfQuad(q) * PI2)); }
  else if (q.motion == 6u) { motionAlpha = select(1.0, 0.1, phaseOfQuad(q) >= 0.5); }
  else if (q.motion == 7u) { motionAlpha = 1.0 - phaseOfQuad(q); }
  else if (q.motion == 8u) {
    let phase = phaseOfQuad(q);
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
    let spec = shadowMeta[u32(shadowId)];
    let count = min(spec.x, 32u);
    var outColour = vec3f(0.0);
    var outAlpha = 0.0;
    // A shadow is the element's own box grown by each layer, painted only
    // outside that box. The painter grows the quad past the element to give a
    // glow room and names the growth as its hole; without the hole the solid
    // first layer of a ring shadow fills the card with its tint.
    let baseHalf = max(in.half - vec2f(q.hole), vec2f(0.0));
    for (var i = 0u; i < count; i = i + 1u) {
      let layer = shadowLayers[spec.y + i * 2u];
      let tint = shadowLayers[spec.y + i * 2u + 1u];
      let lp = in.local * in.half - vec2f(layer.x, layer.y);
      let p = abs(lp);
      let p0 = abs(in.local * in.half);
      let halfSize = baseHalf + vec2f(layer.w);
      // Every corner keeps its own radius. One radius for all four painted
      // a seat's 28 left end into its 14 bottom corners and filled the
      // rounded cutouts with the drop.
      let layerRight = select(q.radii.x, q.radii.y, lp.x > 0.0);
      let layerLeft = select(q.radii.w, q.radii.z, lp.x > 0.0);
      let layerR = max(select(layerRight, layerLeft, lp.y > 0.0) + layer.w, 0.0);
      let r = max(0.0, min(layerR, min(halfSize.x, halfSize.y)));
      let corner = p - halfSize + r;
      let d = length(max(corner, vec2f(0.0))) + min(max(corner.x, corner.y), 0.0) - r;
      let holeRight = select(q.radii.x, q.radii.y, in.local.x > 0.0);
      let holeLeft = select(q.radii.w, q.radii.z, in.local.x > 0.0);
      // q.radii are the element's used radii already: shadow() clamps them to
      // the element box. Subtracting q.hole here squared the hole at the card
      // corners and left the drop as a sharp grey triangle outside the border.
      let holeR = max(select(holeRight, holeLeft, in.local.y > 0.0), 0.0);
      let hc = p0 - baseHalf + holeR;
      let hd = length(max(hc, vec2f(0.0))) + min(max(hc.x, hc.y), 0.0) - holeR;
      let blur = max(layer.z, 0.5);
      let soft = clamp(0.5 - d / blur, 0.0, 1.0) * (1.0 - clamp(0.5 - hd * ppu, 0.0, 1.0));
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
      var phase = phaseOfQuad(q);
      if ((q.motionFlags & 1u) != 0u) { phase = 1.0 - phase; }
      let sweep = fract(turn + phase);
      // The fade flag rides the common turn branch below; the sweep holds shape only.
      motionAlpha = motionAlpha * (0.22 + 0.78 * sweep * sweep);
      inner = 0.0;
    } else if (strokeWidth > 0.0) {
      // A disc's stroke is a rim just inside its edge, the width a rect's
      // stroke takes. inner = outer drew no rim at all, so a handle's ground
      // fill was the whole dot and its main-coloured rim vanished.
      inner = clamp(0.5 - (dist - max(r - strokeWidth, 0.0)) * ppu, 0.0, 1.0);
    } else {
      inner = outer;
    }
  } else {
    let p = abs(in.local * in.half);
    let right = select(q.radii.x, q.radii.y, in.local.x > 0.0);
    let left = select(q.radii.w, q.radii.z, in.local.x > 0.0);
    // CSS never lets a radius pass half the shorter side; a pill asks for 999.
    let rr = min(select(right, left, in.local.y > 0.0), min(in.half.x, in.half.y));
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

  if (q.kind >= 2u) {
    if (q.source == 0xffffffffu) {
      // A text or sprite quad with no cell yet draws nothing; without this
      // the fill path above would stamp the style's fill across the rect.
      alpha = 0.0;
    } else {
      let cell = cells[q.source];
      let uv = mix(cell.xy, cell.zw, in.corner);
      // Level sample: a per-instance branch is not uniform control flow, where
      // textureSample is not allowed.
      let tex = textureSampleLevel(atlas, atlasSampler, uv, 0.0);
      if (q.kind == 3u) {
        // The atlas holds white coverage over transparent, landed
        // unpremultiplied: the alpha channel is the glyph coverage, and the
        // red channel is white inside every edge texel too. Reading r made
        // antialiased edges opaque and text bold.
        colour = ink.rgb;
        alpha = tex.a * ink.a * outer;
      } else {
        let tint = select(vec4f(1.0), fill, fill.a > 0.0);
        colour = tex.rgb * tint.rgb;
        alpha = tex.a * select(1.0, tint.a, fill.a > 0.0) * outer;
      }
    }
  }

  alpha = alpha * styleOpacity * o.p.w * motionAlpha;
  if (alpha < 0.002) { return vec4f(0.0); }
  let luma = dot(colour, vec3f(0.2126, 0.7152, 0.0722));
  colour = mix(vec3f(luma), colour, clamp(o.q.x, 0.0, 1.0));
  return vec4f(colour * alpha, alpha);
}
`;

/** The WGSL source, exported for the reserved-word guard and diagnostics. */
export const QUAD_SHADER = SHADER;
export const WGSL_RESERVED = "NULL Self abstract active alignas alignof as asm asm_fragment async attribute auto await become binding_array cast catch class co_await co_return co_yield coherent column_major common compile compile_fragment concept const_cast consteval constexpr constinit crate debugger decltype delete demote demote_to_helper do dynamic_cast enum explicit export extends extern external fallthrough filter final finally friend from fxgroup get goto groupshared highp impl implements import inline instanceof interface layout lowp macro macro_rules match mediump meta mod module move mut mutable namespace new nil noexcept noinline nointerpolation noperspective null nullptr of operator package packoffset partition pass patch pixelfragment precise precision premerge priv protected pub public readonly ref regardless register reinterpret_cast require resource restrict self set shared sizeof smooth snorm static static_assert static_cast std subroutine super target template this thread_local throw trait try type typedef typeid typename typeof union unless unorm unsafe unsized use using varying virtual volatile wgsl where writeonly yield" as const;

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
  /** The atlas cell-table revision the cells buffer holds. */
  cellsRevision: number;
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
    // writeBuffer's size is in elements of the typed array, not bytes.
    const metaElements = Math.min(shadows.meta.length, SHADOW_META_CAPACITY * SHADOW_SPEC_WORDS);
    if (metaElements > 0) state.device.queue.writeBuffer(state.shadowMeta, 0, shadows.meta, 0, metaElements);
    note(state, "shadows", 0, metaElements * 4);
    const layerElements = Math.min(shadows.layers.length, SHADOW_LAYER_CAPACITY * SHADOW_LAYER_FLOATS);
    if (layerElements > 0) state.device.queue.writeBuffer(state.shadowLayers, 0, shadows.layers, 0, layerElements);
    note(state, "shadows", 0, layerElements * 4);
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
      cells: bufferOf(device, Math.max(16, atlas?.cells.byteLength ?? 16)),
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
      cellsRevision: 0,
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
    if (atlas !== undefined) {
      device.queue.writeBuffer(next.cells, 0, atlas.cells);
      note(next, "cells", 0, atlas.cells.byteLength);
    }
    uploadStyles(next, scene);
  };

  const upload = (scene: Scene, prepared: Prepared): void => {
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
      // The buffer is a Uint32Array: writeBuffer's size is in elements.
      if (scene.orderCount > 0) state.device.queue.writeBuffer(state.order, 0, scene.orderBuffer, 0, scene.orderCount);
      note(state, "order", 0, scene.orderCount * 4);
    }
    if (state.styleRevision !== scene.styleRevision) uploadStyles(state, scene);
    // The atlas writes UVs as rasters land; its revision names what the cells
    // buffer holds. One write for the whole table keeps every text and sprite
    // quad pointing at the cell it asked for.
    if (state.atlas !== undefined && prepared.atlasRevision !== state.cellsRevision) {
      const cells = state.atlas.cells;
      const elements = Math.min(cells.length, Math.floor(state.cells.size / 4));
      if (elements > 0) {
        state.device.queue.writeBuffer(state.cells, 0, cells, 0, elements);
        note(state, "cells", 0, elements * 4);
      }
      state.cellsRevision = prepared.atlasRevision;
    }
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
