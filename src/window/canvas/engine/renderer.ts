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
import { QUAD_BYTES, QUAD_FLOATS } from "./quad";
import { DURATION } from "@shared/theme";
import { STYLE_STRIDE } from "./styles";
import { ATLAS_CELL_FLOATS, atlasBindBudget, type AtlasBindBudget, type AtlasBinding } from "./types";
import { PLACE_QUAD, QUAD_STRUCTS } from "./quad-wgsl";
import { createGpuCull, type GpuCull } from "./gpu-cull";

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

const buildQuadShader = (rgbaSlots: number, coverageSlots: number): string => {
  const extraRgbaDecls: string[] = [];
  const rgbaCases: string[] = [
    "    case 0u: { return textureSampleLevel(atlas, atlasSampler, uv, layer, lod); }",
  ];
  for (let i = 1; i < rgbaSlots; i += 1) {
    const binding = 11 + (i - 1);
    extraRgbaDecls.push(`@group(0) @binding(${binding}) var atlas${i}: texture_2d_array<f32>;`);
    rgbaCases.push(`    case ${i}u: { return textureSampleLevel(atlas${i}, atlasSampler, uv, layer, lod); }`);
  }
  const extraCovDecls: string[] = [];
  const covCases: string[] = [
    "    case 0u: { return textureSampleLevel(coverageAtlas, atlasSampler, uv, layer, 0.0).r; }",
  ];
  for (let j = 1; j < coverageSlots; j += 1) {
    const binding = 11 + (rgbaSlots - 1) + (j - 1);
    extraCovDecls.push(`@group(0) @binding(${binding}) var coverageAtlas${j}: texture_2d_array<f32>;`);
    covCases.push(`    case ${j}u: { return textureSampleLevel(coverageAtlas${j}, atlasSampler, uv, layer, 0.0).r; }`);
  }
  const extraDecls = [...extraRgbaDecls, ...extraCovDecls].join("\n");
  return /* wgsl */ `
const TRANSITION_MS = ${DURATION.state.toFixed(1)};

${QUAD_STRUCTS}// Everything a quad's pixels share is worked out once per vertex and handed
// down flat; only the local position and the gradient parameters (affine in
// it, so exact under interpolation) vary across the quad (issue 915).
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  // The gradient parameter of the style and of the one it fades from, and the fade.
  @location(1) grad: vec3f,
  // half size, mip level, ring phase (-1: not a turning ring).
  @location(2) @interpolate(flat) geo: vec4f,
  @location(3) @interpolate(flat) fillA: vec4f,
  @location(4) @interpolate(flat) fillB: vec4f,
  @location(5) @interpolate(flat) prevA: vec4f,
  @location(6) @interpolate(flat) prevB: vec4f,
  @location(7) @interpolate(flat) stroke: vec4f,
  @location(8) @interpolate(flat) ink: vec4f,
  @location(9) @interpolate(flat) radii: vec4f,
  // stroke width, hole, alpha scale (style, owner and motion), saturation.
  @location(10) @interpolate(flat) misc: vec4f,
  // kind, shape, shadow spec + 1 (0: none), has a cell.
  @location(11) @interpolate(flat) ids: vec4u,
  @location(12) @interpolate(flat) cellUv: vec4f,
  @location(13) @interpolate(flat) cellPage: vec4f,
};

struct AtlasCell {
  uv: vec4f,
  page: vec4f,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> order: array<u32>;
@group(0) @binding(2) var<storage, read> quads: array<Quad>;
@group(0) @binding(3) var<storage, read> owners: array<Owner>;
@group(0) @binding(4) var atlas: texture_2d_array<f32>;
@group(0) @binding(5) var atlasSampler: sampler;
@group(0) @binding(6) var<storage, read> cells: array<AtlasCell>;
@group(0) @binding(7) var<storage, read> styles: array<f32>;
@group(0) @binding(8) var<storage, read> shadowMeta: array<vec4u>;
@group(0) @binding(9) var<storage, read> shadowLayers: array<vec4f>;
// Text coverage, one channel (r8unorm pages, issue 911). u.misc.z is 1 when the
// atlas splits it out; otherwise text sits in the rgba pages' alpha.
@group(0) @binding(10) var coverageAtlas: texture_2d_array<f32>;
${extraDecls}

fn sampleRgba(pageIdx: u32, uv: vec2f, layer: i32, lod: f32) -> vec4f {
  switch (pageIdx) {
${rgbaCases.join("\n")}
    default: { return textureSampleLevel(atlas, atlasSampler, uv, layer, lod); }
  }
}

fn sampleCoverage(pageIdx: u32, uv: vec2f, layer: i32) -> f32 {
  switch (pageIdx) {
${covCases.join("\n")}
    default: { return textureSampleLevel(coverageAtlas, atlasSampler, uv, layer, 0.0).r; }
  }
}

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

/** A style's far gradient stop; a solid fill is its own far stop. */
fn fillEnd(base: u32) -> vec4f {
  let stopB = styleColour(base, 4u);
  return select(stopB, styleColour(base, 0u), stopB.a <= 0.0);
}

/** Where a point sits along a style's gradient, unclamped (affine in local). */
fn gradientAt(base: u32, local: vec2f) -> f32 {
  let theta = styles[base + 8u] * PI2 / 360.0;
  return dot(local, vec2f(sin(theta), -cos(theta))) * 0.5 + 0.5;
}

${PLACE_QUAD}@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  var out: VSOut;
  let slot = order[ii];
  let q = quads[slot];
  let o = owners[q.owner];
  let corner = vec2f(f32(vi & 1u), f32(vi >> 1u));
  let local = corner * 2.0 - 1.0;

  let tierBit = u32(u.camera.w);
  let tierOn = (q.tiers & tierBit) != 0u;

  let placed = placeQuad(q, o, tierBit);
  let scale = placed.z;
  var center = placed.xy;

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

  // The style, faded from the previous one over the transition.
  let base = q.style * STYLE;
  out.fillA = styleColour(base, 0u);
  out.fillB = fillEnd(base);
  out.prevA = out.fillA;
  out.prevB = out.fillB;
  var stroke = styleColour(base, 9u);
  var ink = styleColour(base, 18u);
  var styleOpacity = styles[base + 22u];
  var styleMix = 1.0;
  var gPrev = 0.0;
  if (q.previousStyle != q.style && q.previousStyle != 0xffffffffu) {
    let previousBase = q.previousStyle * STYLE;
    styleMix = smoothstep(0.0, 1.0, clamp((u.view.w - q.changeAt) / TRANSITION_MS, 0.0, 1.0));
    out.prevA = styleColour(previousBase, 0u);
    out.prevB = fillEnd(previousBase);
    gPrev = gradientAt(previousBase, local);
    stroke = mix(styleColour(previousBase, 9u), stroke, styleMix);
    ink = mix(styleColour(previousBase, 18u), ink, styleMix);
    styleOpacity = mix(styles[previousBase + 22u], styleOpacity, styleMix);
  }
  out.grad = vec3f(gradientAt(base, local), gPrev, styleMix);
  out.stroke = stroke;
  out.ink = ink;

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

  // The record's radii and hole are authored in the unscaled board rect.
  // Scale them with the quad's rule and motion, or a bloomed pill's 28
  // radius arcs over a 112 high box and the drop's hole leaves a gap at its
  // rounded corners.
  let quadScale = select(1.0, size.x / q.rect.z, q.rect.z > 0.001);
  out.radii = q.radii * quadScale;
  let shadowId = styles[base + 17u];
  out.misc = vec4f(styles[base + 13u], q.hole * quadScale, styleOpacity * o.p.w * motionAlpha, o.q.x);
  let hasCell = q.kind >= 2u && q.source != 0xffffffffu;
  out.ids = vec4u(q.kind, q.shape, select(0u, u32(shadowId) + 1u, shadowId >= 0.0), select(0u, 1u, hasCell));

  // A turning disc's sweep phase, the direction flag applied.
  var ringPhase = -1.0;
  if (q.shape == 1u && q.motion == 1u) {
    ringPhase = phaseOfQuad(q);
    if ((q.motionFlags & 1u) != 0u) { ringPhase = 1.0 - ringPhase; }
  }

  // The cell, and its mip level: its texels over the device pixels it
  // covers, so a sprite drawn smaller than its raster reads the mips (issue 911).
  // A per-instance branch is not uniform control flow, where textureSample
  // and derivatives are not allowed, so the level is worked out here.
  var lod = 0.0;
  out.cellUv = vec4f(0.0);
  out.cellPage = vec4f(0.0);
  if (hasCell) {
    let cell = cells[q.source];
    out.cellUv = cell.uv;
    out.cellPage = cell.page;
    if (q.kind == 2u) {
      let dims = vec2f(textureDimensions(atlas));
      let tiles = select(vec2f(1.0), cell.page.yz, cell.page.y > 0.5);
      let texels = abs(cell.uv.zw - cell.uv.xy) * tiles * dims;
      let covered = max(size * u.camera.z * u.view.z, vec2f(1.0));
      lod = max(0.0, log2(max(texels.x / covered.x, texels.y / covered.y)));
    }
  }
  out.geo = vec4f(size * 0.5, lod, ringPhase);
  return out;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let ppu = u.camera.z * u.view.z;
  let half = in.geo.xy;
  let qRadii = in.radii;
  let qHole = in.misc.y;
  let strokeWidth = in.misc.x;
  let kind = in.ids.x;
  let shape = in.ids.y;

  let fill = mix(
    mix(in.prevA, in.prevB, clamp(in.grad.y, 0.0, 1.0)),
    mix(in.fillA, in.fillB, clamp(in.grad.x, 0.0, 1.0)),
    in.grad.z,
  );
  let stroke = in.stroke;
  var ink = in.ink;
  if (ink.a <= 0.0) { ink = fill; }
  var sweepAlpha = 1.0;

  // A shadow quad draws the style's shadow layers, each a blurred ring or drop.
  if (kind == 1u) {
    if (in.ids.z == 0u) { return vec4f(0.0); }
    let spec = shadowMeta[in.ids.z - 1u];
    let count = min(spec.x, 32u);
    var outColour = vec3f(0.0);
    var outAlpha = 0.0;
    // A shadow is the element's own box grown by each layer, painted only
    // outside that box. The painter grows the quad past the element to give a
    // glow room and names the growth as its hole; without the hole the solid
    // first layer of a ring shadow fills the card with its tint.
    let baseHalf = max(half - vec2f(qHole), vec2f(0.0));
    let p0 = abs(in.local * half);
    // The element: q.radii are its used radii already (shadow() clamps them
    // to the element box), each corner its own.
    let holeRight = select(qRadii.x, qRadii.y, in.local.x > 0.0);
    let holeLeft = select(qRadii.w, qRadii.z, in.local.x > 0.0);
    let holeR = max(select(holeRight, holeLeft, in.local.y > 0.0), 0.0);
    let hc = p0 - baseHalf + holeR;
    let hd = length(max(hc, vec2f(0.0))) + min(max(hc.x, hc.y), 0.0) - holeR;
    let outside = 1.0 - clamp(0.5 - hd * ppu, 0.0, 1.0);
    let inside = 1.0 - outside;
    // Bit i of spec.z: layer i is inset (drawn inside the element only).
    let insetMask = spec.z;
    // Inside the hole with no inset layer, nothing paints: stop before the loop.
    if (insetMask == 0u && outside <= 0.0) { return vec4f(0.0); }
    if (insetMask == 0xffffffffu >> (32u - max(count, 1u)) && inside <= 0.0) { return vec4f(0.0); }
    for (var i = 0u; i < count; i = i + 1u) {
      let layer = shadowLayers[spec.y + i * 2u];
      let tint = shadowLayers[spec.y + i * 2u + 1u];
      let inset = (insetMask & (1u << i)) != 0u;
      let lp = in.local * half - vec2f(layer.x, layer.y);
      let p = abs(lp);
      // An outer layer is the element grown by its spread; an inset one is
      // the element shrunk by it, and its shadow is what that box leaves.
      let spread = select(layer.w, -layer.w, inset);
      let halfSize = max(baseHalf + vec2f(spread), vec2f(0.0));
      // Every corner keeps its own radius. One radius for all four painted
      // a seat's 28 left end into its 14 bottom corners and filled the
      // rounded cutouts with the drop.
      let layerRight = select(qRadii.x, qRadii.y, lp.x > 0.0);
      let layerLeft = select(qRadii.w, qRadii.z, lp.x > 0.0);
      let layerR = max(select(layerRight, layerLeft, lp.y > 0.0) + spread, 0.0);
      let r = max(0.0, min(layerR, min(halfSize.x, halfSize.y)));
      let corner = p - halfSize + r;
      let d = length(max(corner, vec2f(0.0))) + min(max(corner.x, corner.y), 0.0) - r;
      let blur = max(layer.z, 0.5);
      let cover = clamp(0.5 - d / blur, 0.0, 1.0);
      let soft = select(cover * outside, (1.0 - cover) * inside, inset);
      let a = tint.a * soft * in.misc.z;
      outColour = outColour + tint.rgb * a * (1.0 - outAlpha);
      outAlpha = outAlpha + a * (1.0 - outAlpha);
    }
    if (outAlpha < 0.002) { return vec4f(0.0); }
    return vec4f(outColour, outAlpha);
  }

  var outer = 0.0;
  var inner = 0.0;
  var ringBand = 0.0;

  if (shape == 1u) {
    let dist = length(in.local * half);
    let r = min(half.x, half.y);
    outer = clamp(0.5 - (dist - r) * ppu, 0.0, 1.0);
    if (in.geo.w >= 0.0) {
      let ring = clamp(0.5 - (dist - r * 0.82) * ppu, 0.0, 1.0);
      ringBand = max(0.0, outer - ring);
      let turn = atan2(in.local.y, in.local.x) / PI2 + 0.5;
      let sweep = fract(turn + in.geo.w);
      // The fade flag rides the common turn branch below; the sweep holds shape only.
      sweepAlpha = 0.22 + 0.78 * sweep * sweep;
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
    let p = abs(in.local * half);
    let right = select(qRadii.x, qRadii.y, in.local.x > 0.0);
    let left = select(qRadii.w, qRadii.z, in.local.x > 0.0);
    // CSS never lets a radius pass half the shorter side; a pill asks for 999.
    let rr = min(select(right, left, in.local.y > 0.0), min(half.x, half.y));
    let corner = p - half + rr;
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

  if (kind >= 2u) {
    if (in.ids.w == 0u) {
      // A text or sprite quad with no cell yet draws nothing; without this
      // the fill path above would stamp the style's fill across the rect.
      alpha = 0.0;
    } else {
      let page = in.cellPage;
      var uv = mix(in.cellUv.xy, in.cellUv.zw, in.local * 0.5 + 0.5);
      var pageIdx = u32(max(0.0, page.x));
      var layer = 0;
      if (page.y > 0.5) {
        pageIdx = 0u;
        let tx = clamp(i32(floor(uv.x * page.y)), 0, i32(page.y) - 1);
        let ty = clamp(i32(floor(uv.y * page.z)), 0, i32(page.z) - 1);
        layer = ty * i32(page.y) + tx;
        uv = vec2f(uv.x * page.y - f32(tx), uv.y * page.z - f32(ty));
      }
      if (kind == 3u) {
        // Split pages hold coverage in r. The rgba pages hold white coverage
        // over transparent, unpremultiplied: there alpha is the coverage, and
        // r is white inside every edge texel (reading it made text bold).
        // Only the texture the text lives in is sampled.
        var coverage = 0.0;
        if (u.misc.z > 0.5) {
          coverage = sampleCoverage(pageIdx, uv, layer);
        } else {
          coverage = sampleRgba(pageIdx, uv, layer, 0.0).a;
        }
        colour = ink.rgb;
        alpha = coverage * ink.a * outer;
      } else {
        let tex = sampleRgba(pageIdx, uv, layer, in.geo.z);
        let tint = select(vec4f(1.0), fill, fill.a > 0.0);
        colour = tex.rgb * tint.rgb;
        alpha = tex.a * select(1.0, tint.a, fill.a > 0.0) * outer;
      }
    }
  }

  alpha = alpha * in.misc.z * sweepAlpha;
  if (alpha < 0.002) { return vec4f(0.0); }
  let luma = dot(colour, vec3f(0.2126, 0.7152, 0.0722));
  colour = mix(vec3f(luma), colour, clamp(in.misc.w, 0.0, 1.0));
  return vec4f(colour * alpha, alpha);
}
`;
};

/** The WGSL source, exported for the reserved-word guard and diagnostics. */
export const QUAD_SHADER = buildQuadShader(8, 8);
export const WGSL_RESERVED = "NULL Self abstract active alignas alignof as asm asm_fragment async attribute auto await become binding_array cast catch class co_await co_return co_yield coherent column_major common compile compile_fragment concept const_cast consteval constexpr constinit crate debugger decltype delete demote demote_to_helper do dynamic_cast enum explicit export extends extern external fallthrough filter final finally friend from fxgroup get goto groupshared highp impl implements import inline instanceof interface layout lowp macro macro_rules match mediump meta mod module move mut mutable namespace new nil noexcept noinline nointerpolation noperspective null nullptr of operator package packoffset partition pass patch pixelfragment precise precision premerge priv protected pub public readonly ref regardless register reinterpret_cast require resource restrict self set shared sizeof smooth snorm static static_assert static_cast std subroutine super target template this thread_local throw trait try type typedef typeid typename typeof union unless unorm unsafe unsized use using varying virtual volatile wgsl where writeonly yield" as const;

type Range = { readonly buffer: string; readonly offset: number; readonly size: number };

type Gpu = {
  readonly device: GPUDevice;
  readonly pipeline: GPURenderPipeline;
  readonly bindLayout: GPUBindGroupLayout;
  readonly bindBudget: AtlasBindBudget;
  readonly dummyTex: GPUTexture;
  atlas?: AtlasBinding;
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
  cellCapacity: number;
  styleCapacity: number;
  shadowMetaCapacity: number;
  shadowLayerCapacity: number;
  styleRevision: number;
  /** The atlas cell-table revision the cells buffer holds. */
  cellsRevision: number;
  /** The atlas texture generation currently bound in `bind`. */
  atlasTextureGeneration: number;
  /** Cached bind groups for standalone oversized textures (rebuilt on buffer rebind). */
  standaloneBinds: WeakMap<GPUTexture, GPUBindGroup>;
  lastScene?: Scene;
  frameRanges: Range[];
  totalBytes: number;
  /** The GPU cull, made when the cull first runs on the GPU. */
  cull?: GpuCull;
  /** The bind group whose order is the cull's compacted list, and that list. */
  culledBind?: GPUBindGroup;
  culledOrder?: GPUBuffer;
  /** The main bind group `culledBind` was made beside; a rebind remakes both. */
  culledFor?: GPUBindGroup;
  /** Whether this frame's draws read the cull's indirect arguments. */
  culledThisFrame: boolean;
  /**
   * Buffers made or regrown since their last full upload: a new buffer holds
   * zeros, so the next upload writes it whole whatever the scene's dirt says.
   */
  fresh: Set<"quads" | "owners" | "order">;
};

/**
 * A buffer the scene needs that the device cannot give: past its reported
 * limit, or an allocation the driver refused. Kept and reported, never
 * truncated in silence.
 */
export type BufferFailure = {
  readonly buffer: string;
  readonly bytes: number;
  readonly limit?: number;
  readonly reason: "limit" | "out-of-memory" | "validation";
};

/** Initial shadow table sizes only: both grow on demand, up to the device's limits. */
const SHADOW_META_INITIAL = 256;
const SHADOW_LAYER_INITIAL = 512;

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

  const failures: BufferFailure[] = [];
  const fail = (failure: BufferFailure): void => {
    failures.push(failure);
    console.error(`[canvas] GPU buffer "${failure.buffer}" of ${String(failure.bytes)} bytes: ${failure.reason}${failure.limit === undefined ? "" : ` (limit ${String(failure.limit)})`}`);
  };

  /** The largest storage binding this device takes: the smaller of its two reported limits. */
  const storageLimit = (device: GPUDevice): number | undefined => {
    const limits = device.limits as Partial<Record<"maxStorageBufferBindingSize" | "maxBufferSize", number>> | undefined;
    const binding = limits?.maxStorageBufferBindingSize;
    const buffer = limits?.maxBufferSize;
    const known = [binding, buffer].filter((value): value is number => typeof value === "number" && value > 0);
    return known.length === 0 ? undefined : Math.min(...known);
  };

  /**
   * A storage buffer grown to `bytes`, within the device's limits. Past the
   * limit it is reported and the old buffer stays; an allocation the driver
   * refuses is reported when its error scope settles.
   */
  const grown = (state: Gpu, name: string, old: GPUBuffer, bytes: number): GPUBuffer | undefined => {
    const limit = storageLimit(state.device);
    const size = Math.max(4, Math.ceil(bytes / 4) * 4);
    if (limit !== undefined && size > limit) {
      fail({ buffer: name, bytes: size, limit, reason: "limit" });
      return undefined;
    }
    const device = state.device;
    const scoped = typeof device.pushErrorScope === "function";
    if (scoped) {
      device.pushErrorScope("out-of-memory");
      device.pushErrorScope("validation");
    }
    const next = bufferOf(device, size);
    if (scoped) {
      void device.popErrorScope().then((error) => {
        if (error !== null) fail({ buffer: name, bytes: size, reason: "validation" });
      });
      void device.popErrorScope().then((error) => {
        if (error !== null) fail({ buffer: name, bytes: size, reason: "out-of-memory" });
      });
    }
    old.destroy();
    return next;
  };

  /** Double a capacity until it holds `needed`. */
  const doubled = (from: number, needed: number): number => {
    let capacity = Math.max(1, from);
    while (capacity < needed) capacity *= 2;
    return capacity;
  };

  const dummyTexture = (device: GPUDevice): GPUTexture =>
    device.createTexture({
      size: [ATLAS_DUMMY_WIDTH, ATLAS_DUMMY_WIDTH, 1],
      format: "rgba8unorm",
      usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST,
    });

  const makeBindGroup = (state: Omit<Gpu, "bind">, textureOverride?: GPUTexture, orderOverride?: GPUBuffer): GPUBindGroup => {
    const device = state.device;
    // A standalone override takes the binding its format names: an r8unorm
    // text texture is coverage (binding 10), anything else rgba (binding 4).
    const coverageOverride = textureOverride !== undefined && textureOverride.format === "r8unorm";
    const rgbaPages = state.atlas?.rgbaPages;
    const covPages = state.atlas?.coveragePages;
    const page0Rgba = (coverageOverride ? undefined : textureOverride) ?? rgbaPages?.[0] ?? state.atlas?.texture ?? state.dummyTex;
    const page0Cov = (coverageOverride ? textureOverride : undefined) ?? covPages?.[0] ?? state.atlas?.coverageTexture ?? page0Rgba;
    const sampler = state.atlas?.sampler ?? device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: state.uniform } },
      { binding: 1, resource: { buffer: orderOverride ?? state.order } },
      { binding: 2, resource: { buffer: state.quads } },
      { binding: 3, resource: { buffer: state.owners } },
      { binding: 4, resource: page0Rgba.createView({ dimension: "2d-array" }) },
      { binding: 5, resource: sampler },
      { binding: 6, resource: { buffer: state.cells } },
      { binding: 7, resource: { buffer: state.styles } },
      { binding: 8, resource: { buffer: state.shadowMeta } },
      { binding: 9, resource: { buffer: state.shadowLayers } },
      { binding: 10, resource: page0Cov.createView({ dimension: "2d-array" }) },
    ];
    const { rgba: rgbaSlots, coverage: covSlots } = state.bindBudget;
    for (let i = 1; i < rgbaSlots; i += 1) {
      const tex = rgbaPages?.[i] ?? page0Rgba;
      entries.push({ binding: 11 + (i - 1), resource: tex.createView({ dimension: "2d-array" }) });
    }
    for (let j = 1; j < covSlots; j += 1) {
      const tex = covPages?.[j] ?? page0Cov;
      entries.push({ binding: 11 + (rgbaSlots - 1) + (j - 1), resource: tex.createView({ dimension: "2d-array" }) });
    }
    return device.createBindGroup({
      layout: state.bindLayout,
      entries,
    });
  };

  const styleFloats = (scene: Scene): number => Math.max(STYLE_STRIDE, scene.styleCount * STYLE_STRIDE);

  const uploadStyles = (state: Gpu, scene: Scene): void => {
    const floats = styleFloats(scene);
    state.device.queue.writeBuffer(state.styles, 0, scene.styleBuffer, 0, Math.min(scene.styleBuffer.length, floats));
    note(state, "styles", 0, Math.min(scene.styleBuffer.byteLength, floats * 4));
    const shadows = scene.shadowSnapshot();
    // The tables grow with the specs and layers interned (a custom region
    // colour is a new tint); only a device limit stops them, and that is reported.
    const specs = Math.ceil(shadows.meta.length / SHADOW_SPEC_WORDS);
    let rebind = false;
    if (specs > state.shadowMetaCapacity) {
      const capacity = doubled(state.shadowMetaCapacity, specs);
      const next = grown(state, "shadowMeta", state.shadowMeta, capacity * SHADOW_SPEC_WORDS * 4);
      if (next !== undefined) {
        state.shadowMeta = next;
        state.shadowMetaCapacity = capacity;
        rebind = true;
      }
    }
    const layers = Math.ceil(shadows.layers.length / SHADOW_LAYER_FLOATS);
    if (layers > state.shadowLayerCapacity) {
      const capacity = doubled(state.shadowLayerCapacity, layers);
      const next = grown(state, "shadowLayers", state.shadowLayers, capacity * SHADOW_LAYER_FLOATS * 4);
      if (next !== undefined) {
        state.shadowLayers = next;
        state.shadowLayerCapacity = capacity;
        rebind = true;
      }
    }
    if (rebind) {
      state.bind = makeBindGroup(state);
      state.standaloneBinds = new WeakMap();
    }
    // writeBuffer's size is in elements of the typed array, not bytes.
    const metaElements = Math.min(shadows.meta.length, state.shadowMetaCapacity * SHADOW_SPEC_WORDS);
    if (metaElements > 0) state.device.queue.writeBuffer(state.shadowMeta, 0, shadows.meta, 0, metaElements);
    note(state, "shadows", 0, metaElements * 4);
    const layerElements = Math.min(shadows.layers.length, state.shadowLayerCapacity * SHADOW_LAYER_FLOATS);
    if (layerElements > 0) state.device.queue.writeBuffer(state.shadowLayers, 0, shadows.layers, 0, layerElements);
    note(state, "shadows", 0, layerElements * 4);
    state.styleRevision = scene.styleRevision;
  };

  const ensure = (state: Gpu, scene: Scene): void => {
    let rebind = false;
    // Each buffer follows the scene's capacity; one past the device's limit is
    // reported and keeps its old size, never cut silently.
    if (scene.quadCapacity > state.quadCapacity) {
      const next = grown(state, "quads", state.quads, scene.quadCapacity * QUAD_BYTES);
      if (next !== undefined) {
        state.quads = next;
        state.quadCapacity = scene.quadCapacity;
        state.fresh.add("quads");
        rebind = true;
      }
    }
    if (scene.ownerCapacity > state.ownerCapacity) {
      const next = grown(state, "owners", state.owners, scene.ownerCapacity * 8 * 4);
      if (next !== undefined) {
        state.owners = next;
        state.ownerCapacity = scene.ownerCapacity;
        state.fresh.add("owners");
        rebind = true;
      }
    }
    if (scene.orderBuffer.length > state.orderCapacity) {
      const next = grown(state, "order", state.order, scene.orderBuffer.length * 4);
      if (next !== undefined) {
        state.order = next;
        state.orderCapacity = scene.orderBuffer.length;
        state.fresh.add("order");
        rebind = true;
      }
    }
    if (scene.styleCount * STYLE_STRIDE > state.styleCapacity) {
      const capacity = doubled(state.styleCapacity, scene.styleCount * STYLE_STRIDE);
      const next = grown(state, "styles", state.styles, capacity * 4);
      if (next !== undefined) {
        state.styles = next;
        state.styleCapacity = capacity;
        state.styleRevision = -1;
        rebind = true;
      }
    }
    const atlas = state.atlas;
    if (atlas !== undefined) {
      const cellCount = atlas.cellCount ?? Math.floor(atlas.cells.length / ATLAS_CELL_FLOATS);
      const neededCells = Math.max(1, cellCount);
      if (neededCells > state.cellCapacity) {
        let nextCap = doubled(state.cellCapacity, neededCells);
        // Doubling may overshoot the limit where the exact need does not.
        const limit = storageLimit(state.device);
        if (limit !== undefined) nextCap = Math.max(neededCells, Math.min(nextCap, Math.floor(limit / (ATLAS_CELL_FLOATS * 4))));
        const next = grown(state, "cells", state.cells, nextCap * ATLAS_CELL_FLOATS * 4);
        if (next !== undefined) {
          state.cells = next;
          state.cellCapacity = nextCap;
          state.cellsRevision = -1;
          rebind = true;
        }
      }
      const texGen = atlas.textureGeneration ?? 0;
      if (texGen !== state.atlasTextureGeneration) {
        state.atlasTextureGeneration = texGen;
        rebind = true;
      }
    }
    if (rebind) {
      state.bind = makeBindGroup(state);
      state.standaloneBinds = new WeakMap();
    }
  };

  const configure = (
    device: GPUDevice,
    format: GPUTextureFormat,
    generation: number,
    scene: Scene,
    atlas?: AtlasBinding,
  ): void => {
    if (gpu !== undefined && configuredFor === generation) return;
    gpu?.cull?.destroy();
    const bindBudget = atlasBindBudget(device);
    const module = device.createShaderModule({ code: buildQuadShader(bindBudget.rgba, bindBudget.coverage) });
    const layoutEntries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: STAGE.VERTEX | STAGE.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: STAGE.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: STAGE.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: STAGE.VERTEX, buffer: { type: "read-only-storage" } },
      // The vertex stage reads the atlas's size for a sprite's mip level.
      { binding: 4, visibility: STAGE.VERTEX | STAGE.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array" } },
      { binding: 5, visibility: STAGE.FRAGMENT, sampler: { type: "filtering" } },
      { binding: 6, visibility: STAGE.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 7, visibility: STAGE.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 8, visibility: STAGE.FRAGMENT, buffer: { type: "read-only-storage" } },
      { binding: 9, visibility: STAGE.FRAGMENT, buffer: { type: "read-only-storage" } },
      { binding: 10, visibility: STAGE.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array" } },
    ];
    for (let i = 1; i < bindBudget.rgba; i += 1) {
      layoutEntries.push({
        binding: 11 + (i - 1),
        visibility: STAGE.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "2d-array" },
      });
    }
    for (let j = 1; j < bindBudget.coverage; j += 1) {
      layoutEntries.push({
        binding: 11 + (bindBudget.rgba - 1) + (j - 1),
        visibility: STAGE.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "2d-array" },
      });
    }
    const bindLayout = device.createBindGroupLayout({ entries: layoutEntries });
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
    const initialCells = Math.max(
      1,
      atlas?.cellCount ?? Math.floor((atlas?.cells.length ?? 0) / ATLAS_CELL_FLOATS),
    );
    const next: Gpu = {
      device,
      pipeline,
      bindLayout,
      bindBudget,
      dummyTex: dummyTexture(device),
      ...(atlas === undefined ? {} : { atlas }),
      quads: bufferOf(device, Math.max(1, scene.quadCapacity) * QUAD_BYTES),
      owners: bufferOf(device, Math.max(1, scene.ownerCapacity) * 8 * 4),
      order: bufferOf(device, Math.max(1, scene.orderBuffer.length) * 4),
      uniform: device.createBuffer({ size: uniform.byteLength, usage: BUFFER.UNIFORM | BUFFER.COPY_DST }),
      cells: bufferOf(device, initialCells * ATLAS_CELL_FLOATS * 4),
      styles: bufferOf(device, styleFloats(scene) * 4),
      shadowMeta: bufferOf(device, SHADOW_META_INITIAL * SHADOW_SPEC_WORDS * 4),
      shadowLayers: bufferOf(device, SHADOW_LAYER_INITIAL * SHADOW_LAYER_FLOATS * 4),
      bind: undefined as unknown as GPUBindGroup,
      quadCapacity: Math.max(1, scene.quadCapacity),
      ownerCapacity: Math.max(1, scene.ownerCapacity),
      orderCapacity: Math.max(1, scene.orderBuffer.length),
      cellCapacity: initialCells,
      styleCapacity: styleFloats(scene),
      shadowMetaCapacity: SHADOW_META_INITIAL,
      shadowLayerCapacity: SHADOW_LAYER_INITIAL,
      styleRevision: -1,
      cellsRevision: 0,
      atlasTextureGeneration: atlas?.textureGeneration ?? 0,
      standaloneBinds: new WeakMap(),
      culledThisFrame: false,
      // Quads and owners are written whole below; the order on the first upload.
      fresh: new Set(["order"]),
      lastScene: scene,
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
    const initialAtlasCells = atlas?.cellCount ?? Math.floor((atlas?.cells.length ?? 0) / ATLAS_CELL_FLOATS);
    if (atlas !== undefined && initialAtlasCells > 0) {
      const elements = Math.min(initialAtlasCells * ATLAS_CELL_FLOATS, atlas.cells.length, Math.floor(next.cells.size / 4));
      if (elements > 0) {
        device.queue.writeBuffer(next.cells, 0, atlas.cells, 0, elements);
        note(next, "cells", 0, elements * 4);
      }
    }
    uploadStyles(next, scene);
  };

  /** Write the dirty cell slots as contiguous runs: one writeBuffer per run. */
  const writeCellRuns = (state: Gpu, cells: Float32Array, slots: ReadonlyArray<number>, fits: number): void => {
    if (slots.length === 0) return;
    const sorted = [...slots].sort((a, b) => a - b);
    let start = sorted[0]!;
    let end = start;
    const flush = (): void => {
      const offset = start * ATLAS_CELL_FLOATS;
      const elements = Math.min((end - start + 1) * ATLAS_CELL_FLOATS, fits - offset);
      if (elements <= 0) return;
      state.device.queue.writeBuffer(state.cells, offset * 4, cells, offset, elements);
      note(state, "cells", offset * 4, elements * 4);
    };
    for (let index = 1; index < sorted.length; index += 1) {
      const slot = sorted[index]!;
      if (slot <= end + 1) {
        end = Math.max(end, slot);
        continue;
      }
      flush();
      start = slot;
      end = slot;
    }
    flush();
  };

  const upload = (scene: Scene, prepared: Prepared): void => {
    const state = gpu;
    if (state === undefined) return;
    state.lastScene = scene;
    ensure(state, scene);
    const fresh = state.fresh;
    const quadDirty = scene.takeQuadDirty();
    if (quadDirty.all || fresh.has("quads")) {
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
    if (ownerDirty.all || fresh.has("owners")) {
      state.device.queue.writeBuffer(state.owners, 0, scene.ownerBuffer, 0, scene.ownerCapacity * 8);
      note(state, "owners", 0, scene.ownerCapacity * 8 * 4);
    } else {
      for (const slot of ownerDirty.slots) {
        state.device.queue.writeBuffer(state.owners, slot * 32, scene.ownerBuffer, slot * 8, 8);
        note(state, "owners", slot * 32, 32);
      }
    }
    if (prepared.orderChanged || fresh.has("order")) {
      // The buffer is a Uint32Array: writeBuffer's size is in elements.
      if (scene.orderCount > 0) state.device.queue.writeBuffer(state.order, 0, scene.orderBuffer, 0, scene.orderCount);
      note(state, "order", 0, scene.orderCount * 4);
    }
    fresh.clear();
    if (state.styleRevision !== scene.styleRevision) uploadStyles(state, scene);
    // The atlas writes UVs as rasters land; its revision names what the cells
    // buffer holds. Upload only the allocated cell slots.
    if (state.atlas !== undefined && prepared.atlasRevision !== state.cellsRevision) {
      const cells = state.atlas.cells;
      const cellCount = state.atlas.cellCount ?? Math.floor(cells.length / ATLAS_CELL_FLOATS);
      const fits = Math.min(cells.length, Math.floor(state.cells.size / 4));
      // The atlas names the cells it changed; a fresh or grown buffer takes them all.
      const dirty = state.atlas.takeDirtyCells?.();
      if (dirty === undefined || dirty.all || state.cellsRevision === -1) {
        const elements = Math.min(Math.max(ATLAS_CELL_FLOATS, cellCount * ATLAS_CELL_FLOATS), fits);
        if (elements > 0) {
          state.device.queue.writeBuffer(state.cells, 0, cells, 0, elements);
          note(state, "cells", 0, elements * 4);
        }
      } else {
        writeCellRuns(state, cells, dirty.slots, fits);
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
      readonly hoverScale: number;
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
    uniform[13] = frame.hoverScale;
    uniform[14] = state.atlas?.coverageTexture === undefined ? 0 : 1;
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
    if (state.culledThisFrame && state.cull !== undefined && state.culledBind !== undefined) {
      pass.setBindGroup(0, state.culledBind);
      pass.drawIndirect(state.cull.args, band * 16);
      return;
    }
    const standalone = state.atlas?.standalone;
    const scene = state.lastScene;
    if (standalone === undefined || standalone.size === 0 || scene === undefined) {
      pass.setBindGroup(0, state.bind);
      pass.draw(4, count, 0, first);
      return;
    }
    // Split the band into contiguous runs when oversized standalone textures are present.
    const order = scene.orderBuffer;
    const u32 = scene.quadBuffer.u32;
    let runStart = first;
    let runTex: GPUTexture | undefined = standalone.get(u32[order[first]! * QUAD_FLOATS + 23]!);
    const flushRun = (end: number): void => {
      const len = end - runStart;
      if (len <= 0) return;
      if (runTex === undefined) {
        pass.setBindGroup(0, state.bind);
      } else {
        let bg = state.standaloneBinds.get(runTex);
        if (bg === undefined) {
          bg = makeBindGroup(state, runTex);
          state.standaloneBinds.set(runTex, bg);
        }
        pass.setBindGroup(0, bg);
      }
      pass.draw(4, len, 0, runStart);
    };
    for (let i = first + 1; i < first + count; i += 1) {
      const tex = standalone.get(u32[order[i]! * QUAD_FLOATS + 23]!);
      if (tex !== runTex) {
        flushRun(i);
        runStart = i;
        runTex = tex;
      }
    }
    flushRun(first + count);
  };

  /**
   * Where the draw list is culled: "cpu" draws the scene's list as built;
   * "gpu" culls it per quad, by tier and view, in a compute pass first.
   */
  let cullMode: "cpu" | "gpu" = "cpu";

  /** Encode the GPU cull ahead of the render pass, when the cull runs there. */
  const cull = (encoder: GPUCommandEncoder, timestampWrites?: () => GPUComputePassTimestampWrites | undefined): void => {
    const state = gpu;
    if (state === undefined) return;
    state.culledThisFrame = false;
    if (cullMode !== "gpu") return;
    // A band split into standalone-texture runs needs the list on the CPU.
    const standalone = state.atlas?.standalone;
    if (standalone !== undefined && standalone.size > 0) return;
    state.cull ??= createGpuCull(state.device);
    const culled = state.cull.encode(encoder, {
      uniform: state.uniform,
      candidates: state.order,
      quads: state.quads,
      owners: state.owners,
      count: lastBands[2],
      bandEnds: lastBands,
      ...(timestampWrites === undefined ? {} : { timestampWrites }),
    });
    if (culled === undefined) return;
    if (state.culledBind === undefined || state.culledOrder !== culled || state.culledFor !== state.bind) {
      state.culledBind = makeBindGroup(state, undefined, culled);
      state.culledOrder = culled;
      state.culledFor = state.bind;
    }
    state.culledThisFrame = true;
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
    cull,
    /** Choose where the draw list is culled; takes effect at the next frame. */
    setCull: (mode: "cpu" | "gpu"): void => {
      cullMode = mode;
    },
    get cullMode(): "cpu" | "gpu" {
      return cullMode;
    },
    beginFrame,
    attachAtlas: (atlas: AtlasBinding): void => {
      if (gpu === undefined) return;
      gpu.atlas = atlas;
      gpu.atlasTextureGeneration = atlas.textureGeneration ?? 0;
      gpu.cellsRevision = -1;
      gpu.bind = makeBindGroup(gpu);
      gpu.standaloneBinds = new WeakMap();
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
    /** Buffers the device could not give, in the order they failed (the test hook reads it). */
    get bufferFailures(): ReadonlyArray<BufferFailure> {
      return failures;
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
      gpu?.dummyTex.destroy();
      gpu = undefined;
      configuredFor = 0;
    },
  };
};

export type { AtlasBinding };
