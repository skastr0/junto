/**
 * The wire shader (architecture section 13). One module, one vertex layout
 * (`paint/wires/strip.ts`: pos, extrude, along, across, slot), five fragment
 * entry points:
 *
 *   fs_wire   the hairline: a strip that never overlaps itself, widened to a
 *             pixel with its alpha scaled by coverage when it is thinner
 *   fs_glow   a soft pass under a selected or hovered wire: the stroke
 *             convolved with a Gaussian, per pass, in the wire's own hue
 *   fs_track  the flow track's marks at the wall-clock phase: an open chevron
 *             for flows, a filled arrowhead for derives, drawn from distance
 *             fields so no atlas is read
 *   fs_pulse  a lit dash with round caps, clipped to the wire's ends
 *
 * Wire strips and glow strips draw with `vs_wire`/`vs_glow`; the track strips
 * with `vs_track`; a pulse draws a wire's own strip again with `vs_pulse`,
 * widened to the pulse's width by the strip's extrude vector.
 *
 * Colour is straight sRGB from the theme, premultiplied here, blended
 * (one, one-minus-src-alpha) into a plain surface, so it composites as CSS
 * does. The camera is the contract's: screen = board * zoom + offset.
 */

export const WIRE_SHADER = /* wgsl */ `
struct Uniforms {
  camera: vec4f,  // offset x, offset y, zoom, device pixel ratio
  view: vec4f,    // width, height (CSS px), pulse half width, hairline half width
  track: vec4f,   // period, flows offset, derives offset, derives opacity
  mark: vec4f,    // chevron arm, spread, derives back, derives tip
  mark2: vec4f,   // track stroke width, derives stroke, 0, 0
};

struct Wire {
  colour: vec4f,
  look: vec4f,    // opacity, length, track kind, track alpha
  pulse: vec4f,   // from, to, half width, reserved
  pulseColour: vec4f,
  glow: vec4f,    // sigma, alpha, sigma, alpha
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> wires: array<Wire>;

struct VIn {
  @location(0) pos: vec2f,
  @location(1) extrude: vec2f,
  @location(2) along: f32,
  @location(3) across: f32,
  @location(4) slot: f32,
};

struct VOut {
  @builtin(position) position: vec4f,
  @location(0) at: vec2f,                              // along, across
  @location(1) @interpolate(flat) slot: u32,
  @location(2) @interpolate(flat) widths: vec2f,       // built half width, drawn half width
  @location(3) @interpolate(flat) extra: f32,          // fit on a track strip
};

const HIDDEN = vec4f(2.0, 2.0, 2.0, 1.0);

fn toClip(board: vec2f) -> vec4f {
  let screen = board * u.camera.z + u.camera.xy;
  return vec4f(screen.x / u.view.x * 2.0 - 1.0, 1.0 - screen.y / u.view.y * 2.0, 0.0, 1.0);
}

// One device pixel, in board units.
fn pixel() -> f32 {
  return 1.0 / (u.camera.z * u.camera.w);
}

fn widen(v: VIn, built: f32, drawn: f32, slot: u32) -> VOut {
  var out: VOut;
  // A margin of half a pixel carries the antialiased edge.
  let reach = drawn + 0.5 * pixel();
  out.position = toClip(v.pos + v.extrude * (reach - built));
  out.at = vec2f(v.along, sign(v.across) * reach);
  out.slot = slot;
  out.widths = vec2f(built, drawn);
  out.extra = 0.0;
  return out;
}

@vertex
fn vs_wire(v: VIn) -> VOut {
  let slot = u32(v.slot + 0.5);
  let wire = wires[slot];
  if (wire.look.x <= 0.0) {
    var hidden: VOut;
    hidden.position = HIDDEN;
    return hidden;
  }
  let built = abs(v.across);
  // Thinner than a pixel is drawn a pixel wide and faded by what it covers.
  let drawn = max(built, 0.5 * pixel());
  return widen(v, built, drawn, slot);
}

@vertex
fn vs_glow(v: VIn) -> VOut {
  let slot = u32(v.slot + 0.5);
  let wire = wires[slot];
  var out: VOut;
  if (wire.glow.y <= 0.0 && wire.glow.w <= 0.0) {
    out.position = HIDDEN;
    return out;
  }
  out.position = toClip(v.pos);
  out.at = vec2f(v.along, v.across);
  out.slot = slot;
  out.widths = vec2f(abs(v.across), abs(v.across));
  out.extra = 0.0;
  return out;
}

@vertex
fn vs_pulse(v: VIn) -> VOut {
  let slot = u32(v.slot + 0.5);
  let wire = wires[slot];
  if (wire.pulse.y <= wire.pulse.x || wire.pulseColour.a <= 0.0) {
    var hidden: VOut;
    hidden.position = HIDDEN;
    return hidden;
  }
  let built = abs(v.across);
  // Round caps reach half the dash's width past each end of its span.
  let drawn = max(wire.pulse.z, 0.5 * pixel());
  var out = widen(v, built, drawn, slot);
  return out;
}

@vertex
fn vs_track(v: VIn) -> VOut {
  let slot = u32(v.slot + 0.5);
  let wire = wires[slot];
  var out: VOut;
  if (wire.look.z < 0.5 || wire.look.w <= 0.0) {
    out.position = HIDDEN;
    return out;
  }
  out.position = toClip(v.pos);
  out.at = vec2f(v.along, v.across);
  out.slot = slot;
  out.widths = vec2f(abs(v.across), abs(v.across));
  out.extra = v.extrude.x;
  return out;
}

fn premultiplied(colour: vec3f, alpha: f32) -> vec4f {
  return vec4f(colour * alpha, alpha);
}

// Distance from the centreline's end caps: inside the wire it is the distance across.
fn capDistance(along: f32, across: f32, extent: f32) -> f32 {
  let past = max(max(-along, along - extent), 0.0);
  return length(vec2f(past, across));
}

@fragment
fn fs_wire(f: VOut) -> @location(0) vec4f {
  let wire = wires[f.slot];
  let drawn = f.widths.y;
  let d = capDistance(f.at.x, f.at.y, wire.look.y);
  let coverage = clamp((drawn - d) / pixel() + 0.5, 0.0, 1.0);
  // The width that is not drawn wide enough to be seen is paid for in alpha.
  let thin = min(1.0, f.widths.x / drawn);
  let alpha = wire.look.x * coverage * thin * wire.colour.a;
  return premultiplied(wire.colour.rgb, alpha);
}

// Error function, Abramowitz and Stegun 7.1.26.
fn erf(x: f32) -> f32 {
  let sgn = select(-1.0, 1.0, x >= 0.0);
  let a = abs(x);
  let t = 1.0 / (1.0 + 0.3275911 * a);
  let y = 1.0 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-a * a);
  return sgn * y;
}

fn glowCoverage(distance: f32, halfWidth: f32, sigma: f32) -> f32 {
  let k = max(sigma, 1e-3) * 1.41421356;
  return 0.5 * (erf((distance + halfWidth) / k) - erf((distance - halfWidth) / k));
}

@fragment
fn fs_glow(f: VOut) -> @location(0) vec4f {
  let wire = wires[f.slot];
  let d = capDistance(f.at.x, f.at.y, wire.look.y);
  let hair = u.view.w;
  let a = wire.glow.y * glowCoverage(d, hair, wire.glow.x);
  let b = wire.glow.w * glowCoverage(d, hair, wire.glow.z);
  let alpha = (1.0 - (1.0 - clamp(a, 0.0, 1.0)) * (1.0 - clamp(b, 0.0, 1.0))) * wire.colour.a;
  return premultiplied(wire.colour.rgb, alpha);
}

// Signed distance to the segment ab.
fn segment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

// Signed distance to the triangle abc: negative inside.
fn triangle(p: vec2f, a: vec2f, b: vec2f, c: vec2f) -> f32 {
  let e0 = b - a;
  let e1 = c - b;
  let e2 = a - c;
  let v0 = p - a;
  let v1 = p - b;
  let v2 = p - c;
  let pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  let pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  let pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  let s = sign(e0.x * e2.y - e0.y * e2.x);
  let d = min(min(vec2f(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                  vec2f(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                  vec2f(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}

@fragment
fn fs_track(f: VOut) -> @location(0) vec4f {
  let wire = wires[f.slot];
  let derives = wire.look.z > 1.5;
  let period = u.track.x;
  let offset = select(u.track.y, u.track.z, derives);
  // Mark centres sit at offset plus whole periods along the wire.
  let t = (f.at.x - offset) / period;
  let dx = (t - round(t)) * period;
  let p = vec2f(dx, f.at.y);
  let fit = f.extra;
  let spread = u.mark.y * fit;
  var coverage: f32;
  if (derives) {
    let tri = triangle(p, vec2f(-u.mark.z * fit, -spread), vec2f(u.mark.w * fit, 0.0), vec2f(-u.mark.z * fit, spread));
    // The mark is filled and stroked, round joined: its edge sits half a stroke out.
    coverage = clamp((0.5 * u.mark2.y * fit - tri) / pixel() + 0.5, 0.0, 1.0);
  } else {
    let arm = u.mark.x * fit * 0.5;
    let d = min(segment(p, vec2f(-arm, -spread), vec2f(arm, 0.0)), segment(p, vec2f(arm, 0.0), vec2f(-arm, spread)));
    coverage = clamp((0.5 * u.mark2.x * fit - d) / pixel() + 0.5, 0.0, 1.0);
  }
  let breath = select(1.0, u.track.w, derives);
  let alpha = coverage * wire.look.w * breath * wire.colour.a;
  return premultiplied(wire.colour.rgb, alpha);
}

@fragment
fn fs_pulse(f: VOut) -> @location(0) vec4f {
  let wire = wires[f.slot];
  let drawn = wire.pulse.z;
  // Round caps on the dash, a butt cut at the wire's own ends.
  let outside = max(max(wire.pulse.x - f.at.x, f.at.x - wire.pulse.y), 0.0);
  let d = length(vec2f(outside, f.at.y));
  let coverage = clamp((drawn - d) / pixel() + 0.5, 0.0, 1.0);
  let within = clamp(f.at.x / pixel() + 0.5, 0.0, 1.0) * clamp((wire.look.y - f.at.x) / pixel() + 0.5, 0.0, 1.0);
  let alpha = coverage * within * wire.pulseColour.a;
  return premultiplied(wire.pulseColour.rgb, alpha);
}
`;
