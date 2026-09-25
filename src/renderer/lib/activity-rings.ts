/**
 * The ring language: how every activity mark is drawn. A seat's ring sits
 * around its portrait; a standalone mark is the same ring around a small hub.
 * Pure canvas-2D painters in a 20-unit box centered on (10, 10); the atlas
 * (activity-atlas.ts) bakes their frames once per theme.
 *
 *   work     an arc circles the ring, clockwise
 *   reverse  circling runs backwards (stuck)
 *   snake    the ring itself zigzags as a wave travels round it (thrashing, looping)
 *   call     a steady ring that sends a ring outward, twice, then waits
 *   halt     a heavy ring on a double heartbeat (blocked, failed)
 *   done     the ring sweeps closed, thickens, and rests; it never flashes
 *   live, dot, rest, off, fracture   still rings
 *
 * The ring stays inside radius ~7.8 so a portrait fits within it and the
 * outer band (to 10) is free for the expanding call ring, the waiting glow,
 * the good-health halo and the signal flag.
 */

type Ctx = CanvasRenderingContext2D;

export type RingPalette = {
  /** Atlas pixels of bloom per unit of requested blur; 0 in daylight. */
  readonly glow: number;
  readonly dark: boolean;
};

export type LoopRing = "work" | "reverse" | "snake" | "call" | "halt";
export type StillRing = "live" | "dot" | "rest" | "off" | "fracture";

/** Frames of the done draw-in; frame LAND_FRAMES is the resting pose. */
export const LAND_FRAMES = 8;

const C = 10;
const TAU = Math.PI * 2;
/** Ring radius and weight, in units of the 20-unit box. */
export const RING_R = 7.2;
const RING_W = 1.1;
/** A portrait inside the ring may reach this radius without touching it. */
export const RING_HOLE_R = RING_R - RING_W / 2 - 0.25;

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const ease = (t: number): number => 1 - (1 - clamp01(t)) ** 3;

/** Two beats over frames 0..10, then still: a heartbeat, not a blink. */
const heartbeat = (frame: number): number => {
  if (frame < 3) return frame / 3;
  if (frame < 6) return 1 - (frame - 3) / 3;
  if (frame < 8) return ((frame - 6) / 2) * 0.55;
  if (frame < 11) return 0.55 * (1 - (frame - 8) / 3);
  return 0;
};

const glowOn = (ctx: Ctx, p: RingPalette, color: string, blur: number): void => {
  if (p.glow <= 0) return;
  ctx.shadowColor = color;
  ctx.shadowBlur = blur * p.glow;
};

const circle = (ctx: Ctx, r: number, width: number, a0 = 0, a1 = TAU): void => {
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(C, C, Math.max(0.01, r), a0, a1);
  ctx.stroke();
};

const track = (ctx: Ctx, p: RingPalette, color: string): void => {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = p.dark ? 0.2 : 0.24;
  circle(ctx, RING_R, RING_W);
  ctx.restore();
};

/**
 * A lit arc whose head is at `head` radians and whose tail trails `span`
 * behind it (sign sets direction), thinning and fading toward the tail.
 */
const comet = (ctx: Ctx, p: RingPalette, color: string, head: number, span: number): void => {
  const steps = 18;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  for (let s = 0; s < steps; s += 1) {
    const t0 = s / steps;
    const t1 = (s + 1) / steps;
    ctx.globalAlpha = (1 - t0) ** 1.4;
    const a = head - span * t0;
    const b = head - span * t1;
    circle(ctx, RING_R, RING_W * (1.25 - 0.55 * t0), Math.min(a, b), Math.max(a, b) + 0.002);
  }
  ctx.fillStyle = color;
  ctx.globalAlpha = 1;
  glowOn(ctx, p, color, 5);
  ctx.beginPath();
  ctx.arc(C + Math.cos(head) * RING_R, C + Math.sin(head) * RING_R, RING_W * 0.95, 0, TAU);
  ctx.fill();
  ctx.restore();
};

const TOP = -Math.PI / 2;

/** Work: one lap per 16 frames (1.44 s), clockwise. */
const work = (ctx: Ctx, p: RingPalette, color: string, frame: number): void => {
  track(ctx, p, color);
  comet(ctx, p, color, TOP + (frame / 16) * TAU, Math.PI * 0.75);
};

/** Stuck: the lap runs backwards, slower, as if against the grain. */
const reverse = (ctx: Ctx, p: RingPalette, color: string, frame: number): void => {
  ctx.save();
  ctx.setLineDash([0.7, 1.1]);
  track(ctx, p, color);
  ctx.restore();
  comet(ctx, p, color, TOP - (frame / 32) * TAU, -Math.PI * 0.55);
};

/** Thrashing or looping: the ring itself zigzags, the wave travelling round. */
const snake = (ctx: Ctx, p: RingPalette, color: string, frame: number): void => {
  const phase = (frame / 32) * TAU * 2;
  const lobes = 7;
  const amp = 0.55;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = RING_W;
  ctx.lineJoin = "round";
  glowOn(ctx, p, color, 3);
  ctx.beginPath();
  const n = 140;
  for (let i = 0; i <= n; i += 1) {
    const th = (i / n) * TAU;
    // A travelling bulge makes the zigzag read as moving, not vibrating.
    const bulge = 0.6 + 0.4 * Math.cos(th - phase / 2);
    const r = RING_R + amp * bulge * Math.sin(lobes * th - phase * 2);
    const x = C + Math.cos(th) * r;
    const y = C + Math.sin(th) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
};

/** Wants the operator: a steady lit ring that sends a ring outward, twice. */
const call = (ctx: Ctx, p: RingPalette, color: string, frame: number): void => {
  const wave = frame < 10 ? { t: frame / 10, gain: 1 } : frame < 20 ? { t: (frame - 10) / 10, gain: 0.55 } : undefined;
  if (wave) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.9 * wave.gain * (1 - wave.t) ** 1.2;
    circle(ctx, RING_R + 0.3 + ease(wave.t) * 2.3, RING_W * (1 - 0.6 * wave.t));
    ctx.restore();
  }
  ctx.save();
  ctx.strokeStyle = color;
  glowOn(ctx, p, color, 5);
  circle(ctx, RING_R, RING_W * 1.15);
  ctx.restore();
};

/** Blocked or failed: a heavy ring cut into four, beating twice then holding. */
const halt = (ctx: Ctx, p: RingPalette, color: string, frame: number): void => {
  const beat = heartbeat(frame);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineCap = "butt";
  glowOn(ctx, p, color, 3 + 6 * beat);
  const gap = 0.3;
  for (let q = 0; q < 4; q += 1) {
    const a0 = (q * Math.PI) / 2 + Math.PI / 4 + gap / 2;
    circle(ctx, RING_R, RING_W * (1.6 + 0.35 * beat), a0, a0 + Math.PI / 2 - gap);
  }
  ctx.restore();
};

/**
 * Done: the ring sweeps closed from the top, then thickens into a resting
 * seal with a soft wash outside it. Frame LAND_FRAMES is where it stays.
 */
export const paintDone = (ctx: Ctx, p: RingPalette, color: string, frame: number): void => {
  const sealed = frame >= LAND_FRAMES;
  const sweep = sealed ? 1 : ease(frame / 5);
  const settle = sealed ? 1 : clamp01((frame - 5) / 2);
  track(ctx, p, color);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  if (settle > 0) {
    ctx.globalAlpha = 0.16 * settle;
    circle(ctx, RING_R + 1.1, 1.3);
    ctx.globalAlpha = 1;
  }
  glowOn(ctx, p, color, 3 + 2 * settle);
  ctx.lineCap = "round";
  if (sweep >= 1) circle(ctx, RING_R, RING_W * (1 + 0.45 * settle));
  else if (sweep > 0) circle(ctx, RING_R, RING_W * 1.2, TOP, TOP + sweep * TAU);
  ctx.restore();
};

export const paintLoop = (ctx: Ctx, p: RingPalette, ring: LoopRing, color: string, frame: number): void => {
  if (ring === "work") work(ctx, p, color, frame);
  else if (ring === "reverse") reverse(ctx, p, color, frame);
  else if (ring === "snake") snake(ctx, p, color, frame);
  else if (ring === "call") call(ctx, p, color, frame);
  else halt(ctx, p, color, frame);
};

/** Frame a frozen loop shows (reduced motion, offscreen, paused). */
export const LOOP_REST_FRAME: Readonly<Record<LoopRing, number>> = {
  work: 3,
  reverse: 6,
  snake: 0,
  call: 3,
  halt: 16,
};

export const paintStill = (ctx: Ctx, p: RingPalette, ring: StillRing, color: string): void => {
  ctx.save();
  ctx.strokeStyle = color;
  if (ring === "live") {
    ctx.globalAlpha = 0.8;
    circle(ctx, RING_R, RING_W * 0.85);
  } else if (ring === "dot") {
    glowOn(ctx, p, color, 2);
    circle(ctx, RING_R, RING_W);
  } else if (ring === "rest") {
    ctx.globalAlpha = p.dark ? 0.42 : 0.5;
    circle(ctx, RING_R, RING_W * 0.8);
  } else if (ring === "off") {
    ctx.globalAlpha = 0.55;
    ctx.lineCap = "round";
    ctx.setLineDash([0.05, 1.45]);
    circle(ctx, RING_R, RING_W);
  } else {
    // Fracture: an amber ring broken at every quarter (trouble, at rest).
    ctx.globalAlpha = 0.95;
    ctx.lineCap = "round";
    const gap = 0.55;
    for (let q = 0; q < 4; q += 1) {
      const a0 = (q * Math.PI) / 2 + Math.PI / 4 + gap / 2;
      circle(ctx, RING_R, RING_W, a0, a0 + Math.PI / 2 - gap);
    }
  }
  ctx.restore();
};

// --- outer band: glow, halo, flag --------------------------------------------

export type RingGlow = "amber" | "crimson";
export type RingHalo = "good" | "exceeding";

/** Waiting on the operator: a soft light around the ring, no motion. */
export const paintGlow = (ctx: Ctx, p: RingPalette, color: string, fade: number): void => {
  ctx.save();
  ctx.strokeStyle = color;
  for (const [r, w, a] of [
    [RING_R + 1.2, 1.4, 0.34],
    [RING_R + 2.2, 1.2, 0.16],
  ] as const) {
    ctx.globalAlpha = a * fade * (p.dark ? 1 : 0.85);
    circle(ctx, r, w);
  }
  ctx.restore();
};

const spark = (ctx: Ctx, cx: number, cy: number, r: number): void => {
  const w = r * 0.26;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.quadraticCurveTo(cx + w, cy - w, cx + r, cy);
  ctx.quadraticCurveTo(cx + w, cy + w, cx, cy + r);
  ctx.quadraticCurveTo(cx - w, cy + w, cx - r, cy);
  ctx.quadraticCurveTo(cx - w, cy - w, cx, cy - r);
  ctx.fill();
};

/** Going well: a fine second ring outside; exceeding adds a spark. */
export const paintHalo = (ctx: Ctx, p: RingPalette, halo: RingHalo, color: string, fade: number): void => {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.75 * fade;
  circle(ctx, RING_R + 1.9, 0.55);
  if (halo === "exceeding") {
    const a = Math.PI * 1.25;
    const x = C + Math.cos(a) * (RING_R + 1.9);
    const y = C + Math.sin(a) * (RING_R + 1.9);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(x, y, 1.9, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = fade;
    glowOn(ctx, p, color, 3);
    spark(ctx, x, y, 1.7);
  }
  ctx.restore();
};

const FLAG_ANGLE = -Math.PI / 4;
const FLAG_R = 1.9;
const FLAG_AT = [
  C + Math.cos(FLAG_ANGLE) * (RING_R + 0.9),
  C + Math.sin(FLAG_ANGLE) * (RING_R + 0.9),
] as const;

/** The seat's own declared signal: a pip on the ring at 45 degrees. */
export const paintFlag = (ctx: Ctx, p: RingPalette, color: string, blocked: boolean): void => {
  const [fx, fy] = FLAG_AT;
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(fx, fy, FLAG_R + 0.9, 0, TAU);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.fillStyle = color;
  glowOn(ctx, p, color, 4);
  ctx.beginPath();
  ctx.arc(fx, fy, FLAG_R, 0, TAU);
  ctx.fill();
  ctx.restore();
  // A declared blocked carries a bar so it never reads as a plain dot.
  if (blocked) {
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.lineWidth = 0.7;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(fx - 0.85, fy);
    ctx.lineTo(fx + 0.85, fy);
    ctx.stroke();
    ctx.restore();
  }
};
