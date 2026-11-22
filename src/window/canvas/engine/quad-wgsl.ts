/**
 * WGSL shared by the quad draw (renderer.ts) and the GPU cull (gpu-cull.ts):
 * the record layout, and where a quad is placed this frame. One source, so
 * the cull keeps exactly what the vertex stage places.
 */

/** The records' layout, shared by the draw and the cull. */
export const QUAD_STRUCTS = /* wgsl */ `
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

`;

export const PLACE_QUAD = /* wgsl */ `
// Where a quad sits this frame, motion aside: its centre in board units and
// its scale rule's factor. The vertex stage and the cull pass share it, so
// what the cull keeps is exactly what the vertex stage would place.
fn placeQuad(q: Quad, o: Owner, tierBit: u32) -> vec3f {
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
  } else if (q.scaleRule == 4u) {
    // The hovered card's full-detail bloom: every near quad grows about the
    // ring centre by the camera's hold (u.misc.y, hoverCardScale). At far the
    // unhovered ring already sits on the card's content-box centre (o.q),
    // not the ring's authored anchor; bloom from there or the card jumps out
    // from under the pointer. At mid the two points coincide.
    let anchor = vec2f(q.anchorX, q.anchorY);
    let relCentre = vec2f(q.rect.x + q.rect.z * 0.5, q.rect.y + q.rect.w * 0.5);
    var base = anchor;
    if (tierBit == 4u) {
      base = vec2f(o.q.y * 0.5 + o.q.w, o.q.z * 0.5);
    }
    scale = u.misc.y;
    center = o.p.xy + base + (relCentre - anchor) * scale;
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
  return vec3f(center, scale);
}

`;
